/**
 * Draining approved work into Buildertrend estimates.
 *
 * A sibling of background/delivery.js rather than a generalisation of it. That
 * file bills Camelot, it works, and it is the one path in this extension where
 * a mistake costs money — so it is left alone and this one borrows its shape:
 * the same claim -> submitting -> result handshake, the same "one at a time in
 * one tab", the same refusal vocabulary. The same reasoning kept
 * ApiDeliveriesController::invoice() where it is while the estimate projection
 * moved into a class of its own.
 *
 * ## This leg does not drive the screen, and that is the whole design
 *
 * It did, and it failed six consecutive times in that one layer: an Ant Design
 * item drawer whose dropdowns open on mousedown, a virtualised job picker whose
 * rows are absent from the DOM in a tab nobody is painting, and an "Unsaved
 * changes" modal that a cancelled drawer left behind to block the *next* run.
 * Three of those failures were caused by leftover state from the one before.
 *
 * Buildertrend's estimate screen is served by its own API, so every step is
 * addressed to it instead:
 *
 * - `GET /api/Proposals/<jobId>/Worksheet` — the worksheet id to write to, the
 *   builder id, the account's cost codes, and what the estimate already holds.
 * - `POST /apix/v2/LineItems/add-estimate-line-items` — the lines.
 * - `SetJobPickerData` — which job the screen shows, which is now courtesy
 *   rather than a precondition (see select()).
 *
 * Nothing is read off the rendered page. The first real write is why: the line
 * was stored perfectly and the reloaded screen came back showing only its job
 * picker, with no estimate body and no money on it anywhere, so scraping "Total
 * price" found nothing and a correct write was reported `unconfirmed`.
 *
 * The tab exists only to make same-origin authenticated calls from, so it never
 * needs focus and never takes anybody's.
 *
 * ## Where the boundary is
 *
 * The API has no rehearsal: there is nothing to read until something is posted,
 * so a dry run proves the job, the empty estimate and the payload it would send
 * — and stops. `submitting` is therefore recorded before the **first POST**.
 *
 * What the drawer gave for free was arithmetic checked before committing.
 * Posting replaces it with **line one first**: one line, read back from the
 * worksheet, both its figures checked to the cent, and only then the rest. A
 * wrong figure costs one line instead of an estimate.
 *
 * Anything uncertain after that first POST is `unconfirmed`, never a clean
 * failure — a clean failure is claimable, and a retry would write the lines a
 * second time.
 */

import { api } from "./api.js";
import { check_signed_in, show_sign_in } from "./portals.js";
import { SAMPLE_TITLE_PREFIX } from "./scope.js";
import { settings, save_bt_last_estimate_run } from "./store.js";

const ESTIMATE_URL = "https://buildertrend.net/app/Estimate";
const TARGET = "buildertrend";

/** Long enough for a page load and a run of authenticated calls. */
const STEP_MS = 120000;
const HANDSHAKE_MS = 30000;

/** One run at a time, for the reason delivery.js has the same flag. */
let running = false;
let estimate_tab_id = null;

export async function deliver_estimates_now({ manual = false } = {}) {
  if (running) return { ok: true, skipped: "already running" };

  running = true;

  try {
    /* One recording point for the whole run.
     *
     * `remember()` used to be called at four of this function's twelve exits,
     * so eight refusals — Buildertrend switched off, the queue unreadable,
     * paused, scope unknown, no tab, and signed out of either system — left
     * `bt_last_estimate_run` holding whatever the *previous* run had put there.
     * That is worse than reporting nothing: a manager who pressed the button,
     * got sent to a Buildertrend sign-in page and reopened the popup read the
     * last run's unrelated problem as though it were this one's.
     *
     * The sign-out refusal is the case that makes this structural rather than
     * tidy: it opens a tab, opening a tab closes the popup, so the banner it
     * says its piece into is guaranteed to be destroyed before anybody reads
     * it. The durable record is the only account of that run there will ever
     * be. Hence a wrapper rather than eight more `remember()` calls — the
     * ninth exit somebody adds is recorded whether or not they remember to. */
    return await remember(await attempt_estimates());
  } finally {
    running = false;

    /* Left open on a manual run so somebody can see what happened; closed on a
       scheduled one so an unattended queue does not leave a tab behind. */
    if (!manual) await close_tab();
  }
}

/** The run itself. Every exit is a plain outcome; the caller records it. */
async function attempt_estimates() {
  /* `signed_out` is declared rather than left to spring into existence on
     first use. It used to be absent here and incremented below, which is
     legal JavaScript and was the whole bug: the tally existed, the run
     still returned ok, and the popup announced "Nothing was waiting for an
     estimate." over a queue nothing had touched. */
  const summary = {
    delivered: 0, failed: 0, unconfirmed: 0, blocked: 0, skipped: 0, rehearsed: 0, signed_out: 0,
  };
  const reports = [];

  try {
    const config = await settings();

    if (config.buildertrend_enabled === false)
      return { ok: false, error: "Buildertrend is switched off in Settings.", summary };

    const response = await api.deliveries(TARGET);

    /* Both of these carried a bare token and nothing else, and the popup's
       estimate button prints `summary.reason || result.error` — so a manager
       was shown the literal word "signed_out". Every refusal in this function
       now says a sentence, which is the idiom the three below already use. */
    if (response.status === 401)
      return {
        ok: false,
        error: "signed_out",
        summary: {
          ...summary,
          reason: "This device is no longer signed in to the web app. Open Settings and sign in again.",
        },
      };

    if (response.status === 403)
      return {
        ok: false,
        error: "not_permitted",
        summary: { ...summary, reason: "This account is not allowed to write estimates." },
      };
    if (!response.ok)
      return { ok: false, error: response.body?.error || "The estimate queue could not be read.", summary };

    if (response.body?.paused === true)
      return { ok: true, summary: { ...summary, paused: true, reason: response.body.reason || "" } };

    const queue = Array.isArray(response.body?.deliveries) ? response.body.deliveries : [];
    if (queue.length === 0) return { ok: true, summary, reports };

    /* Same gate the invoice drainer uses, and in the same place: before
       anything is claimed, because a claim spends an attempt. */
    const scope = response.body?.scope || null;

    if (scope?.mode !== "sample" && scope?.mode !== "live")
      return {
        ok: false,
        error: "scope_unknown",
        summary: {
          ...summary,
          reason: "The web app did not say which work orders it may estimate, so nothing was written.",
        },
      };

    const options = {
      dry_run: response.body?.dry_run === true,
      scope,
      config,
    };

    const tab = await ensure_tab();
    if (tab === null) return { ok: false, error: "Could not open a Buildertrend tab.", summary };

    const portal = await check_signed_in(TARGET, tab);

    if (portal.state === "signed_out") {
      await show_sign_in(tab);

      return {
        ok: false,
        error: "buildertrend_signed_out",
        summary: {
          ...summary,
          reason: "You are signed out of Buildertrend. Sign in on the tab just opened, then try again.",
        },
      };
    }

    for (const delivery of queue) {
      const outcome = await write_one(delivery, options, reports);

      summary[outcome] = (summary[outcome] || 0) + 1;

      /* A rehearsal puts the job straight back, so a second one would pick the
         same row up and rehearse it for ever. One pass is the whole run. */
      if (options.dry_run) break;

      /* Signed out part way through fails every remaining row identically and
         would burn the queue's attempts proving it. */
      if (outcome === "signed_out") break;
    }

    /* The break above left the run returning `ok: true`, so a session that
       expired half way through reported as "Nothing was waiting for an
       estimate." while every remaining row sat untouched. The rows that were
       written are still counted — this says the run stopped early, not that it
       did nothing. */
    if (summary.signed_out > 0)
      return {
        ok: false,
        error: "signed_out",
        summary: {
          ...summary,
          reason: "This device is no longer signed in to the web app, so the rest were left queued. "
            + "Open Settings and sign in again.",
        },
        reports,
      };

    return { ok: true, summary, reports };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), summary, reports };
  }
}

/**
 * Keep the run where somebody can read it afterwards.
 *
 * The popup's banner is cleared by its own heartbeat on the next open, so a
 * result announced only there is a result announced to nobody — which is what
 * happened to the first rehearsal.
 */
async function remember(outcome) {
  await save_bt_last_estimate_run({
    at: Date.now(),
    ok: outcome.ok === true,
    error: outcome.error || "",
    summary: outcome.summary || {},
    reports: (outcome.reports || []).slice(0, 10),
  }).catch(() => null);

  return outcome;
}

/**
 * One work order's estimate.
 *
 * Every refusal before the first Save is a plain failure or a block, and both
 * are honest: nothing has been written. Everything after it is `unconfirmed` on
 * any doubt, because the rows may exist and a retry would add them twice.
 */
async function write_one(delivery, options, reports) {
  const claim = await api.claim_delivery(delivery.id);

  /* 409 is the ordinary answer when two browsers drain the same queue. */
  if (claim.status === 409) return "skipped";
  if (claim.status === 401) return "signed_out";
  if (!claim.ok) return finish(delivery, options, reports, "failed", "That estimate could not be claimed.");

  const estimate = delivery.estimate || null;

  if (estimate === null || !Array.isArray(estimate.items) || estimate.items.length === 0)
    return finish(delivery, options, reports, "blocked", "That job produced no estimate lines.");

  /* The job to attach to. drain() only offers a row that has one, so its
     absence here means the queue and this code disagree — refuse rather than
     pick a job. */
  const title = expected_title(delivery);

  if (title === "")
    return finish(delivery, options, reports, "blocked",
      "Nothing is known about what this work order is called in Buildertrend.");

  const tab = await ensure_tab();
  if (tab === null) return finish(delivery, options, reports, "failed", "Could not open a Buildertrend tab.");

  const ready = await wait_until_ready(tab);

  if (ready !== "ready")
    return finish(delivery, options, reports, "failed",
      ready === "no_listener"
        ? "Buildertrend's estimate screen did not answer. Reload the extension and try again."
        : "Buildertrend's estimate screen did not finish loading.");

  const job_id = job_id_from(delivery.buildertrend_url);

  if (job_id === null)
    return finish(delivery, options, reports, "blocked",
      "That work order has no Buildertrend job to put an estimate on.");

  /* Putting the screen on this job, and **not** a condition of writing to it.
     That is the difference the API made: the write is addressed to the
     worksheet that `job_id` returns, so which job the page happens to be
     showing changes nothing about where the lines land. Selecting is now
     courtesy to whoever opens the tab afterwards, so a failure is a note on
     the report rather than a refusal — and there is no picker fallback, which
     is what used to bring the tab forward and take somebody's focus. */
  const chosen = await select(tab, delivery, title, options);

  if (await wait_until_ready(tab) !== "ready")
    return finish(delivery, options, reports, "failed",
      "Buildertrend's estimate screen stopped answering.");

  /* The one read every decision below is made from. */
  const before = await ask(tab, "ESTIMATE_WORKSHEET", { job_id }, STEP_MS);
  const refusal = gate(before, job_id, title);

  if (refusal !== null) return finish(delivery, options, reports, refusal.state, refusal.error);

  /* The point of no return, recorded before the **first POST** rather than
     before a Save. The boundary has not moved, only the thing on the other
     side of it: a browser that dies from here leaves a row saying "may already
     be part-written" instead of one a retry would double. Not for a rehearsal,
     which sends nothing. */
  if (!options.dry_run) {
    const permitted = await api.submitting_delivery(delivery.id);

    if (!permitted.ok)
      return finish(delivery, options, reports, "failed",
        "The web app did not confirm it was safe to write this estimate.");
  }

  const written = await ask(tab, "ESTIMATE_WRITE", {
    job_title: title,
    buildertrend_job_id: job_id,
    items: estimate.items,
    cost_code: options.config.bt_cost_code,
    dry_run: options.dry_run === true,
  }, STEP_MS);

  if (options.dry_run) {
    reports.push({
      number: delivery.number,
      ok: written?.ok === true,
      expected: estimate.expected_total,
      error: written?.error || "",
      note: [
        written?.ok === true ? `would send ${written.would_send} line(s): ${written.first}` : "",
        chosen.ok === true ? "" : `the screen was not switched to that job (${chosen.error})`,
      ].filter(Boolean).join("; "),
    });

    await api.release_delivery(delivery.id).catch(() => null);

    return written?.ok === true ? "rehearsed" : "failed";
  }

  if (written?.ok !== true) {
    /* `stage` is what separates a clean retry from a person having to look.
       "none" means the refusal happened before anything was sent. */
    if (written?.blocked === true) return finish(delivery, options, reports, "blocked", written.error);

    return written?.stage === "none"
      ? finish(delivery, options, reports, "failed", written?.error || "The estimate could not be written.")
      : finish(delivery, options, reports, "unconfirmed",
          written?.error || "Part of that estimate may have been written. Check Buildertrend before retrying.");
  }

  /* One line is in. Everything from here reports `unconfirmed` on doubt, never
     `failed`, because `failed` is claimable and a retry would write it again.

     Read back off the page rather than trusting the answer: the page is
     reloaded so it shows what Buildertrend actually stored, which is the check
     the drawer used to give for free before each Save. */
  const after_first = await reread(tab, job_id);

  if (after_first === null)
    return finish(delivery, options, reports, "unconfirmed",
      "The first estimate line was written and Buildertrend would not say what it stored. Check Buildertrend.");

  if (after_first.line_count !== 1)
    return finish(delivery, options, reports, "unconfirmed",
      `One estimate line was sent and Buildertrend now holds ${after_first.line_count}. `
      + "Nothing further was written — check Buildertrend.");

  const first_line = after_first.lines[0];

  /* Both figures, not the total. They are two different claims — what ASH was
     charged and what the client is charged — and a markup applied wrongly can
     leave the one we check right while the other is wrong. */
  if (first_line.builder_cost_cents !== written.expected_first_builder_cents
    || first_line.client_price_cents !== written.expected_first_cents)
    return finish(delivery, options, reports, "unconfirmed",
      `"${first_line.title}" reads ${money(first_line.builder_cost_cents)} builder cost and `
      + `${money(first_line.client_price_cents)} client price; it should read `
      + `${money(written.expected_first_builder_cents)} and ${money(written.expected_first_cents)}. `
      + "Nothing further was written — check Buildertrend.");

  const rest = Array.isArray(written.rest) ? written.rest : [];

  if (rest.length > 0) {
    const remainder = await ask(tab, "ESTIMATE_WRITE_REST", {
      worksheet_id: written.worksheet_id,
      items: rest,
    }, STEP_MS);

    if (remainder?.ok !== true)
      return finish(delivery, options, reports, "unconfirmed",
        remainder?.error || "Only part of that estimate was written. Check Buildertrend before retrying.");
  }

  const finished = await reread(tab, job_id);

  if (finished === null)
    return finish(delivery, options, reports, "unconfirmed",
      "The estimate was written and Buildertrend would not say what it stored. Check Buildertrend.");

  if (finished.line_count !== estimate.items.length)
    return finish(delivery, options, reports, "unconfirmed",
      `That estimate should hold ${estimate.items.length} line(s) and Buildertrend holds `
      + `${finished.line_count}. Check Buildertrend.`);

  if (finished.total_cents !== estimate.expected_total_cents)
    return finish(delivery, options, reports, "unconfirmed",
      `Buildertrend totals that estimate at ${money(finished.total_cents)} and it should be `
      + `${money(estimate.expected_total_cents)}. Check Buildertrend.`);

  return finish(delivery, options, reports, "delivered", "", {
    external_ref: String(written.worksheet_id || ""),
    expected: estimate.expected_total,
    note: chosen.ok === true ? "" : `written, but the screen was not switched to that job (${chosen.error})`,
  });
}


/**
 * Put the estimate screen on the right job.
 *
 * Courtesy, not safety. Every line is addressed to the worksheet that this
 * job's id returns, so the estimate lands in the right place whether or not the
 * screen ever catches up — which is why a failure here is a note on the report
 * and not a refusal.
 *
 * It matters anyway: the tab is left open, and somebody who opens it should see
 * the job that was just estimated rather than whichever one was selected last.
 *
 * One POST that needs no painting, then a reload, so the tab can stay in the
 * background exactly as the invoice drainer's does. **There is no picker
 * fallback.** Driving the picker needed the tab brought forward, took the focus
 * of whoever was working, and could leave an "Unsaved changes" modal that
 * blocked the *next* run — real costs, paid for a check that the job id now
 * answers outright.
 */
async function select(tab_id, delivery, title, options) {
  const job_id = job_id_from(delivery.buildertrend_url);

  if (job_id === null) return { ok: false, error: "no Buildertrend job id" };

  /* The builder id comes from Buildertrend's own answer rather than from
     settings: the worksheet read returns it beside the worksheet id, so there
     is nothing to configure and nothing to go stale. */
  const sheet = await ask(tab_id, "ESTIMATE_WORKSHEET", { job_id }, STEP_MS);

  if (sheet?.ok !== true || !sheet.builder_id)
    return { ok: false, error: sheet?.error || "Buildertrend did not say which builder that job belongs to" };

  const switched = await ask(tab_id, "ESTIMATE_SELECT_JOB", { job_id, builder_id: sheet.builder_id }, STEP_MS);

  if (switched?.ok !== true) return { ok: false, error: switched?.error || "Buildertrend would not switch to it" };

  await chrome.tabs.reload(tab_id).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await wait_for_load(tab_id);

  return { ok: true };
}

/**
 * Everything that can refuse this estimate, decided from the worksheet read.
 *
 * One function because these are one question — *may this be written?* — and
 * they used to be four scattered ones asked of three different things: the
 * picker for the job, the rendered page for the header, the rendered page
 * again for emptiness. Each could answer wrongly for its own reason.
 *
 * `null` means write. Anything else names the state and says why, and the
 * split between `blocked` and `failed` is the one that matters: `failed` is
 * claimable, so a job that is *gone* must never be one, or it is retried every
 * run for ever and trips the circuit breaker on work that cannot succeed.
 */
function gate(sheet, job_id, title) {
  /* No answer at all is not an answer about the job. `ask()` collapses a
     timed-out message, a listener replaced by a navigation and a tab that went
     away all to `null`, and none of them say the job is gone — so classifying
     them below as the deleted-job case strands work the next run would have
     written, under a message sending somebody to look for a deletion that never
     happened. Nothing has been written at the gate, so `failed` is both honest
     and safe: it is claimable, and the retry re-asks the question. */
  if (sheet === null || sheet === undefined)
    return {
      state: "failed",
      error: "Buildertrend's estimate screen did not answer when asked about that job.",
    };

  if (sheet.ok !== true)
    return {
      /* A job whose id Buildertrend will not open is the deleted-job case,
         which is how four of the five test links became dangling. */
      state: "blocked",
      error: `${sheet?.error || "Buildertrend would not open that job's estimate."} The job may have been `
        + "deleted in Buildertrend — restore it, or clear this work order's Buildertrend link so a new "
        + "job is created.",
    };

  /* The identity check, and by API it is the id rather than a name read off a
     header in capitals. The id came from the URL recorded when this extension
     created the job, and Buildertrend echoes back which job it served. */
  if (Number(sheet.job_id) !== Number(job_id))
    return { state: "failed", error: "Buildertrend answered about a different job than the one asked for." };

  /* The title only when Buildertrend gave one; it is carried on a field named
     for an integration, so a blank is "not populated here", not "wrong job" —
     and the id has already answered that. */
  if (sheet.job_title !== "" && sheet.job_title.toLowerCase() !== title.toLowerCase())
    return {
      state: "blocked",
      error: `Buildertrend calls job ${job_id} "${sheet.job_title}" and this work order expects `
        + `"${title}". Nothing was written.`,
    };

  if (sheet.locked === true)
    return { state: "blocked", error: "That estimate is locked in Buildertrend, so nothing was added." };

  if (typeof sheet.line_count !== "number")
    return { state: "failed", error: "Buildertrend did not say what that estimate already holds." };

  if (sheet.line_count > 0)
    return {
      state: "blocked",
      error: `That job's estimate already has ${sheet.line_count} line(s) in it, so nothing was added.`,
    };

  if (!Array.isArray(sheet.cost_codes) || sheet.cost_codes.length === 0)
    return { state: "failed", error: "Buildertrend listed no cost codes for that job." };

  return null;
}

/**
 * Read back what Buildertrend actually stored.
 *
 * Asked of Buildertrend rather than of the page. The first real write proved
 * why: the line was stored correctly and `/app/Estimate`, reloaded, came back
 * showing only its job picker — no estimate body, no money anywhere on it — so
 * the scrape found nothing and a good write reported as `unconfirmed`.
 *
 * Nothing is reloaded now, which also means the content script survives the
 * whole run instead of being replaced twice mid-flow.
 */
async function reread(tab_id, job_id) {
  const seen = await ask(tab_id, "ESTIMATE_WORKSHEET", { job_id }, STEP_MS);

  return seen?.ok === true && Array.isArray(seen.lines) ? seen : null;
}

function money(cents) {
  const absolute = Math.abs(Number(cents) || 0);

  return `$${Math.floor(absolute / 100).toLocaleString()}.${String(absolute % 100).padStart(2, "0")}`;
}

/** The job id out of the URL recorded when the job was created. */
function job_id_from(url) {
  const match = String(url || "").match(/\/JobPage\/(\d+)/i);

  return match ? Number(match[1]) : null;
}

/**
 * What this work order is called in Buildertrend.
 *
 * Built the same way background/buildertrend.js builds it when it *creates* the
 * job — one spelling, or the estimate leg searches for a title the job leg
 * never typed.
 *
 * The sample prefix comes from the server's frozen `is_sample`, not from
 * re-reading a description. The title was decided when the job was created and
 * cannot change afterwards, so the question is "what was true at intake", which
 * is the one thing is_sample is for. Re-deriving it would also mean carrying
 * the work order's description on a payload that has never had one.
 */
function expected_title(delivery) {
  const number = String(delivery.number || "").trim();
  const street = String(delivery.payload?.street || "").trim();

  if (number === "") return "";

  return `${delivery.is_sample === true ? SAMPLE_TITLE_PREFIX : ""}(${number}) ${street}`.trim();
}

async function finish(delivery, options, reports, state, error, extra = {}) {
  /* Every outcome is reported, not only a rehearsal's. It used to push a
     report on the dry-run branch alone, so the first real write produced a
     summary line reading "1 unconfirmed" and no word anywhere about which work
     order or why — the reason was in the database and nowhere a person looking
     at the popup could see it. A run that writes is the run whose account
     matters most. */
  reports.push({
    number: delivery.number,
    ok: state === "delivered",
    expected: extra.expected || "",
    error,
    note: extra.note || "",
  });

  if (options.dry_run) {
    await api.release_delivery(delivery.id).catch(() => null);

    return state === "blocked" ? "blocked" : "failed";
  }

  await api.delivery_result(delivery.id, {
    state,
    error,
    external_ref: extra.external_ref || "",
    payload_hash: delivery.payload_hash,
  }).catch(() => null);

  return state;
}

/* ---- tab plumbing, the same shape delivery.js uses ---------------------- */

async function ensure_tab() {
  /* Module state is not enough on its own. The service worker is evicted after
     about thirty seconds idle, so `estimate_tab_id` is null on the next press
     and a fresh tab was opened every single time — four of them during one
     afternoon's testing. The tab itself is the durable record, so it is found
     by looking for it. */
  if (estimate_tab_id === null) {
    const open = await chrome.tabs.query({ url: `${ESTIMATE_URL}*` }).catch(() => []);

    if (open.length > 0) estimate_tab_id = open[0].id;
  }

  if (estimate_tab_id !== null) {
    const existing = await chrome.tabs.get(estimate_tab_id).catch(() => null);

    if (existing) {
      if (!String(existing.url || "").startsWith(ESTIMATE_URL)) {
        await chrome.tabs.update(estimate_tab_id, { url: ESTIMATE_URL }).catch(() => null);
        await wait_for_load(estimate_tab_id);
      }

      return estimate_tab_id;
    }

    estimate_tab_id = null;
  }

  const tab = await chrome.tabs.create({ url: ESTIMATE_URL, active: false }).catch(() => null);
  if (!tab?.id) return null;

  estimate_tab_id = tab.id;
  await wait_for_load(tab.id);

  return tab.id;
}

async function close_tab() {
  if (estimate_tab_id === null) return;

  await chrome.tabs.remove(estimate_tab_id).catch(() => null);
  estimate_tab_id = null;
}

function wait_for_load(tab_id, timeout = HANDSHAKE_MS) {
  return new Promise((resolve) => {
    const settle = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (updated, info) => {
      if (updated === tab_id && info.status === "complete") settle();
    };

    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(settle, timeout);
  });
}

/**
 * Wait for the estimate screen to be usable, rather than asking once.
 *
 * Asking once was wrong and failed the very first run inside a second: the page
 * answers `loading` until its job picker has rendered, which takes a few
 * seconds, and a single question treats that as a broken page. delivery.js has
 * always retried its equivalent handshake for exactly this reason.
 *
 * The two unhappy answers are kept apart because they need different fixes:
 * `loading` means wait longer, and `no_listener` means the content script is
 * not there at all — which is a reload, not a retry. Collapsing them into one
 * message is how the landing lookup stayed undiagnosed for six runs.
 */
async function wait_until_ready(tab_id, attempts = 20) {
  let answered = false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const status = await ask(tab_id, "ESTIMATE_PAGE_STATUS", {}, HANDSHAKE_MS);

    if (status?.state === "ready") return "ready";
    if (status !== null) answered = true;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return answered ? "loading" : "no_listener";
}

/** A message with a ceiling, so one unresponsive page cannot stall the queue. */
async function ask(tab_id, type, payload, timeout) {
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tab_id, { type, payload }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);
  } catch {
    return null;
  }
}
