/**
 * Getting work orders from Appfolio into the web app, and knowing it happened.
 *
 * The design answers one worry: that a batch stops half way — the laptop
 * sleeps, the wifi drops, the service worker is evicted — and nobody can tell
 * afterwards what arrived. So two rules run through everything here.
 *
 * **Retrying is always safe**, and that is a property of the server, not a hope.
 * work_orders carries UNIQUE (client, number), so a re-post of the same work
 * order either creates it or refreshes a few fields; the web app's intake never
 * moves a job backwards, never unassigns anybody, never changes the title
 * something was billed under, and never nulls a stored value with a blank one.
 * That is why a job can sit in this queue being retried with no upper bound on
 * how many times it has already been sent.
 *
 * **Nothing is recorded because we think we sent it.** After a batch the numbers
 * involved are read back from the web app and the answer is stored as the truth.
 * A response that never arrived, or arrived and was lost when the worker was
 * evicted, therefore costs a lookup rather than a wrong ledger.
 *
 * The states a job moves through:
 *
 *   queued ──▶ sending ──▶ synced          the ordinary path
 *                 │
 *                 ├──▶ retry ──▶ sending   offline, 429, 5xx; backoff on an alarm
 *                 ├──▶ conflict            409: the number is here at another address
 *                 ├──▶ rejected            422: not a work order; a person must fix it
 *                 └──▶ blocked             401/403: sign in, or ask for permission
 *
 * conflict, rejected and blocked are all terminal until somebody acts. None of
 * them is ever retried automatically, because in all three the next identical
 * attempt has the same answer and the manager is the only one who can change it.
 */

import { api, NetworkError } from "./api.js";
import { sync_jobs, update_sync_jobs, settings } from "./store.js";
import { notify } from "./notify.js";

const ALARM = "nss-sync-retry";

/** Matches the web app's work_orders.api.max_batch. */
const BATCH_SIZE = 100;

/** Backoff by attempt number, in seconds. The last value repeats. */
const BACKOFF = [10, 30, 60, 300, 900];

/**
 * Attempts after which a row that never lands is called rejected.
 *
 * This is not for network failures — those retry indefinitely on purpose, since
 * the network coming back is exactly the case worth waiting for. It is for the
 * one loop that could otherwise never end: the web app accepting a work order
 * and the lookup never returning it, which means the two disagree about
 * something a retry cannot settle.
 */
const GIVE_UP_AFTER = 5;

/**
 * How many chunks one drain() may send before stopping.
 *
 * A ceiling rather than a trust that the states always converge. Every path out
 * of a chunk moves its rows to a state that is either terminal or has a
 * retry_after in the future, so the loop should always end on its own — but
 * "should" is doing a lot of work in a loop that calls a network API, and a
 * mistake here would be a hot loop rather than a wrong answer. The alarm picks
 * up whatever is left.
 */
const MAX_PASSES = 20;

const RETRIABLE = new Set(["queued", "retry"]);

/** Set while run() is working, so two triggers cannot both drain the queue. */
let running = false;

/** Set when a run finishes and finds work that arrived while it was going. */
let rerun = false;

export function now() {
  return new Date().toISOString();
}

function backoff_seconds(attempts) {
  return BACKOFF[Math.min(attempts, BACKOFF.length - 1)];
}

/**
 * Add scraped work orders to the queue.
 *
 * A number already in the ledger is re-queued rather than skipped, and that is
 * deliberate for two of the terminal states: a manager who has corrected an
 * address in Appfolio and clicks sync again is telling us to try that one
 * again, and refusing because we remember failing would make the retry
 * impossible. A job that is already synced is re-queued too, which costs one
 * upsert and keeps the meaning of the button honest — it syncs what is ticked.
 */
export async function enqueue(work_orders) {
  const list = Array.isArray(work_orders) ? work_orders : [];
  const accepted = [];

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    for (const work_order of list) {
      const number = String(work_order?.number || "").trim();
      if (number === "") continue;

      next[number] = {
        ...(next[number] || {}),
        number,
        payload: work_order,
        state: "queued",
        attempts: 0,
        error: null,
        http_status: null,
        queued_at: now(),
        updated_at: now(),
      };

      accepted.push(number);
    }

    return next;
  });

  trigger();

  return { queued: accepted.length, numbers: accepted };
}

/** Drop finished jobs from the ledger, so the popup is not a growing log. */
export async function clear_finished() {
  let removed = 0;

  await update_sync_jobs((jobs) => {
    const next = {};

    for (const [number, job] of Object.entries(jobs)) {
      if (job.state === "synced") {
        removed++;
        continue;
      }

      next[number] = job;
    }

    return next;
  });

  return { removed };
}

/**
 * Empty the ledger completely.
 *
 * Called when the configured web app changes, because every row in here
 * describes work orders in a *particular* app — their ids, their statuses, and
 * whether they arrived at all. Carrying that across to a different address
 * would be carrying answers to a question nobody asked.
 */
export async function clear_all() {
  let removed = 0;

  await update_sync_jobs((jobs) => {
    removed = Object.keys(jobs).length;

    return {};
  });

  return { removed };
}

/** Put one job back in the queue by hand — the Retry button. */
export async function retry(numbers) {
  const wanted = new Set((Array.isArray(numbers) ? numbers : [numbers]).map(String));

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    for (const number of wanted) {
      if (!next[number]) continue;

      next[number] = {
        ...next[number],
        state: "queued",
        attempts: 0,
        error: null,
        http_status: null,
        updated_at: now(),
      };
    }

    return next;
  });

  trigger();
}

export function trigger() {
  run().catch(() => {
    /* run() records its own failures in the ledger; an escaped one must not
       take the service worker's message handler down with it. */
  });
}

/**
 * Send everything that is waiting, in batches, then reconcile.
 *
 * Single-flight: a second trigger while a run is in progress sets a flag and
 * the current run loops again rather than two runs racing for the same rows.
 */
export async function run() {
  if (running) {
    rerun = true;

    return;
  }

  running = true;

  try {
    do {
      rerun = false;
      await drain();
    } while (rerun);
  } finally {
    running = false;
  }
}

async function drain() {
  const config = await settings();

  if (String(config.app_url || "").trim() === "") {
    await block_all("No web app address is set. Open Settings to add one.");

    return;
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const due = await due_jobs();
    if (due.length === 0) break;

    const chunk = due.slice(0, BATCH_SIZE);

    await mark(chunk.map((job) => job.number), (job) => ({
      ...job,
      state: "sending",
      updated_at: now(),
    }));

    let response;

    try {
      response = await api.send_batch(chunk.map((job) => job.payload));
    } catch (error) {
      /* Never got an answer, so nothing is known about any row in the chunk.
         All of them go to retry — the reconcile below would tell us more, but
         the network is down and it cannot run either. */
      await defer(chunk, error instanceof NetworkError ? error.message : String(error));

      return;
    }

    if (!response.ok) {
      await apply_request_failure(chunk, response);

      /* A whole-request refusal applies to every later chunk too. Carrying on
         would spend the same 401 forty times. */
      return;
    }

    await apply_results(chunk, response.body?.results || []);
    await reconcile(chunk.map((job) => job.number));
    await announce(chunk.map((job) => job.number));
  }

  /* Anything still due — because the ceiling above was reached, or because a
     row's backoff has not elapsed — is left for the alarm. */
  const remaining = await due_jobs();
  if (remaining.length > 0) schedule(BACKOFF[0]);
}

/** Jobs eligible to send now — retriable, and past their backoff. */
async function due_jobs() {
  const jobs = await sync_jobs();
  const stamp = Date.now();

  return Object.values(jobs)
    .filter((job) => RETRIABLE.has(job.state))
    .filter((job) => !job.retry_after || Date.parse(job.retry_after) <= stamp)
    .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
}

/**
 * What one row's answer means.
 *
 * The mapping is the contract with the web app, and it is the reason the batch
 * endpoint returns a per-row status instead of one HTTP code for the request:
 * these four outcomes need four different things to happen next, and three of
 * them need a person.
 */
function state_for(result) {
  switch (result?.status) {
    case "created":
    case "updated":
      return "synced";

    case "flagged":
      return "conflict";

    default:
      return "rejected";
  }
}

async function apply_results(chunk, results) {
  /* Matched by index rather than by number. The web app returns one result per
     input in the order sent, including for rows it could not read a number out
     of — and those are exactly the rows whose number we cannot match on. */
  const by_index = new Map();

  for (const result of results) {
    if (typeof result?.index === "number") by_index.set(result.index, result);
  }

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    chunk.forEach((job, index) => {
      const current = next[job.number];
      if (!current) return;

      const result = by_index.get(index);

      if (!result) {
        next[job.number] = {
          ...current,
          state: "retry",
          attempts: (current.attempts || 0) + 1,
          error: "The web app did not answer for this work order.",
          retry_after: new Date(
            Date.now() + backoff_seconds(current.attempts || 0) * 1000,
          ).toISOString(),
          updated_at: now(),
        };

        return;
      }

      next[job.number] = {
        ...current,
        state: state_for(result),
        created: result.created === true,
        work_order_id: result.id ?? current.work_order_id ?? null,
        error: Array.isArray(result.errors) ? result.errors.join(" ") : null,
        existing: result.existing || null,
        retry_after: null,
        updated_at: now(),
      };
    });

    return next;
  });
}

/**
 * A refusal of the whole request, which is about the credential or the shape of
 * the call and never about one row.
 */
async function apply_request_failure(chunk, response) {
  const message =
    response.body?.error || `The web app answered ${response.status}.`;

  if (response.status === 401 || response.status === 403) {
    await block_all(message, chunk);

    notify(
      "Sync stopped",
      response.status === 401
        ? "The web app no longer accepts this device. Sign in again from the extension's settings."
        : message,
    );

    return;
  }

  /* 429 and 5xx are the server asking for time. Everything else at this level
     — a 400 or a 413 — is this extension calling wrongly, which retrying
     cannot fix, so it is recorded against the rows rather than looped over. */
  if (response.status === 429 || response.status >= 500) {
    await defer(chunk, message);

    return;
  }

  await mark(chunk.map((job) => job.number), (job) => ({
    ...job,
    state: "rejected",
    error: message,
    http_status: response.status,
    retry_after: null,
    updated_at: now(),
  }));
}

async function defer(chunk, message) {
  let soonest = Infinity;

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    for (const job of chunk) {
      const current = next[job.number];
      if (!current) continue;

      const attempts = (current.attempts || 0) + 1;
      const wait = backoff_seconds(attempts - 1);
      soonest = Math.min(soonest, wait);

      next[job.number] = {
        ...current,
        state: "retry",
        attempts,
        error: message,
        retry_after: new Date(Date.now() + wait * 1000).toISOString(),
        updated_at: now(),
      };
    }

    return next;
  });

  schedule(soonest === Infinity ? BACKOFF[0] : soonest);
}

async function block_all(message, chunk = null) {
  const numbers = chunk
    ? chunk.map((job) => job.number)
    : Object.keys(await sync_jobs());

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    for (const number of numbers) {
      const current = next[number];
      /* Only rows that were going to be sent. A conflict or a rejection is
         already a decision a person has to act on, and overwriting it with
         "blocked" would lose the reason. */
      if (!current) continue;
      if (!RETRIABLE.has(current.state) && current.state !== "sending") continue;

      next[number] = {
        ...current,
        state: "blocked",
        error: message,
        retry_after: null,
        updated_at: now(),
      };
    }

    return next;
  });
}

async function mark(numbers, mutator) {
  const wanted = new Set(numbers.map(String));

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    for (const number of wanted) {
      if (!next[number]) continue;

      next[number] = mutator(next[number]);
    }

    return next;
  });
}

/**
 * Read the web app's own answer for these numbers and store it as the truth.
 *
 * This is the step that makes an interrupted batch recoverable. Whatever the
 * responses said, or failed to say, the ledger afterwards reflects what the web
 * app actually holds: a row that says synced was found there, and a row that
 * went missing is put back in the queue rather than left looking done.
 *
 * A lookup that fails changes nothing. It is a read, so being unable to
 * perform it is simply not knowing more than we did — never a reason to
 * downgrade what we already recorded.
 */
export async function reconcile(numbers) {
  const wanted = [...new Set((numbers || []).map(String).filter((n) => n !== ""))];
  if (wanted.length === 0) return { ok: true, found: 0 };

  let response;

  try {
    response = await api.lookup(wanted);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof NetworkError ? error.message : String(error),
    };
  }

  if (!response.ok)
    return {
      ok: false,
      status: response.status,
      error: response.body?.error || `The web app answered ${response.status}.`,
    };

  const found = response.body?.work_orders || {};

  await update_sync_jobs((jobs) => {
    const next = { ...jobs };

    for (const number of wanted) {
      const current = next[number];
      if (!current) continue;

      const server = found[number] || null;

      if (server) {
        next[number] = {
          ...current,

          /* Present on the server settles it, whatever the POST appeared to
             say — including for a row whose response was lost. */
          state: current.state === "conflict" ? "conflict" : "synced",
          work_order_id: server.id,
          server,
          updated_at: now(),
        };

        continue;
      }

      /* Not on the server. A row we believed synced is therefore not, and
         saying so — and queueing it again — is the entire point of this pass.

         It is queued with a backoff and a spent attempt, not as a fresh job.
         Without that, a row the web app keeps accepting and keeps not returning
         — a mismatched `client` between the two would do it — would be re-sent
         by drain()'s loop with no pause and no ceiling, which is a hot loop
         against the API rather than a retry. */
      if (current.state === "synced" || current.state === "sending") {
        const attempts = (current.attempts || 0) + 1;

        next[number] = {
          ...current,
          state: attempts > GIVE_UP_AFTER ? "rejected" : "queued",
          attempts,
          server: null,
          error:
            attempts > GIVE_UP_AFTER
              ? "The web app kept accepting this work order without storing it. Check that the extension and the web app agree on the client name."
              : "The web app does not have this work order. Queued again.",
          retry_after: new Date(
            Date.now() + backoff_seconds(attempts - 1) * 1000,
          ).toISOString(),
          updated_at: now(),
        };
      }
    }

    return next;
  });

  return { ok: true, found: Object.keys(found).length };
}

/**
 * What the web app currently holds for a page of numbers, for the badges.
 *
 * Separate from reconcile() because it must not write anything: this answers a
 * question about Appfolio rows the manager has not chosen to sync, and folding
 * them into the ledger would fill it with jobs nobody asked for.
 *
 * The failure is reported rather than swallowed, because the badges must be
 * able to say "unknown" instead of showing a remembered value as current.
 *
 * It also carries `scope` straight through from the answer — which population
 * the web app will accept, and the marker that identifies it. Passed along
 * rather than stored for the same reason the statuses are: a page that acted on
 * a remembered mode would be acting on a question it had not asked. An empty
 * page of numbers short-circuits before the call and therefore has no scope,
 * which is correct — it also has no rows to send.
 */
export async function statuses(numbers) {
  const wanted = [...new Set((numbers || []).map(String).filter((n) => n !== ""))];
  if (wanted.length === 0) return { ok: true, work_orders: {}, scope: null };

  try {
    const response = await api.lookup(wanted);

    if (response.status === 401)
      return { ok: false, reason: "signed_out", error: "Sign in to see status." };

    if (!response.ok)
      return {
        ok: false,
        reason: "error",
        error: response.body?.error || `The web app answered ${response.status}.`,
      };

    return {
      ok: true,
      work_orders: response.body?.work_orders || {},
      scope: response.body?.scope || null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      error: error instanceof NetworkError ? error.message : String(error),
    };
  }
}

/**
 * Tell the manager how a batch went, through the OS rather than the popup.
 *
 * The popup closes the instant focus moves back to the page, which in v1 meant
 * every outcome message was delivered to nothing and a manager learned that a
 * sync had worked by noticing a row disappear. A notification survives that.
 *
 * Only counts, and only once per chunk. Twenty notifications for twenty rows
 * would be worse than none.
 */
async function announce(numbers) {
  const jobs = await sync_jobs();
  const counts = { synced: 0, conflict: 0, rejected: 0, retry: 0 };

  for (const number of numbers) {
    const state = jobs[number]?.state;
    if (state && counts[state] !== undefined) counts[state]++;
  }

  const parts = [];

  if (counts.synced > 0) parts.push(`${counts.synced} synced`);
  if (counts.conflict > 0) parts.push(`${counts.conflict} need a look`);
  if (counts.rejected > 0) parts.push(`${counts.rejected} rejected`);
  if (counts.retry > 0) parts.push(`${counts.retry} will retry`);

  if (parts.length === 0) return;

  const needs_attention = counts.conflict > 0 || counts.rejected > 0;

  notify(
    needs_attention ? "Sync finished — some need a look" : "Sync finished",
    parts.join(", ") + ".",
  );
}

function schedule(seconds) {
  /* Chrome clamps alarms to a minute for unpacked extensions in some versions,
     so a short backoff may fire late. That is acceptable — it delays a retry,
     it never loses one — and an alarm is the only timer that survives the
     service worker being evicted, which setTimeout does not. */
  chrome.alarms.create(ALARM, { delayInMinutes: Math.max(seconds, 1) / 60 });
}

/**
 * The whole ledger, for the popup to render.
 *
 * Re-exported from here rather than having the service worker import the store
 * directly, so that everything about the sync ledger enters and leaves through
 * one module and its shape stays this file's business.
 */
export function sync_jobs_snapshot() {
  return sync_jobs();
}

/** Counts for the toolbar badge and the popup header. */
export async function summary() {
  const jobs = Object.values(await sync_jobs());
  const counts = {
    total: jobs.length,
    queued: 0,
    sending: 0,
    synced: 0,
    conflict: 0,
    rejected: 0,
    retry: 0,
    blocked: 0,
  };

  for (const job of jobs) {
    if (counts[job.state] !== undefined) counts[job.state]++;
  }

  counts.pending = counts.queued + counts.sending + counts.retry;
  counts.attention = counts.conflict + counts.rejected + counts.blocked;

  return counts;
}

export { ALARM };
