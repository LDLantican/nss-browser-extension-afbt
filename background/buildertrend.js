/**
 * Driving the Buildertrend new-job page.
 *
 * This is v1's background orchestration, kept almost as it was, and that is a
 * deliberate decision rather than laziness. Whether ASH keeps using
 * Buildertrend at all is undecided — the web app exists to replace the billing
 * work that is the only reason Buildertrend is involved — so the sequence of
 * selectors and waits in content/buildertrend_add_job.js is expensive knowledge
 * about a system that may be retired. Rewriting it would re-earn every timing
 * quirk against a live account, for a coin flip.
 *
 * Three things did change.
 *
 * It opens **its own tab** instead of navigating the tab the manager is on.
 * v1 called tabs.update on the active tab, so starting a fill from Appfolio
 * took Appfolio away — which is where she was working, and where she was about
 * to tick the next twenty rows.
 *
 * It **asks** the page whether it is ready rather than waiting to be told. v1
 * had to arm a listener before the navigation began, because a fast load would
 * otherwise finish before anyone was listening; opening a tab starts the
 * navigation at once, so that trick is unavailable — and asking has no window
 * to miss, since the page memoizes its own verdict.
 *
 * And it returns its outcome to the caller instead of broadcasting to the
 * popup. The popup is usually shut by then; notifications are how a finished
 * run gets seen now.
 *
 * ## The scope check is here, not at queue time
 *
 * A row is ticked on Appfolio and filled from the popup, and those are two
 * different moments — sometimes an hour apart, with a queue that survives the
 * browser restarting in between. The scope that was true when it was ticked is
 * not evidence about the scope that is true when a real Buildertrend job is
 * created, so it is asked again here, from the server, immediately before.
 *
 * Buildertrend has **no test mode**: a job built from one of Dustin's samples
 * is a real job in the same list as everything else. So a sample gets a title
 * prefix — the only thing that will let anybody find them again and delete
 * them.
 */

import { check_signed_in, show_sign_in } from "./portals.js";
import { scope as current_scope } from "./auth.js";
import { marked, scope_admits, SAMPLE_TITLE_PREFIX } from "./scope.js";
import { close_owned_tab, hand_over, lock, open_owned_tab } from "./owned_tabs.js";

const ADD_JOB_URL = "https://buildertrend.net/app/JobPage/0/1?openCondensed=true";
const ADD_JOB_PATH = "/app/JobPage/0/";

/** Where Buildertrend sends you after saving a new job. Not to the job. */
const LANDING = /^https:\/\/buildertrend\.net\/app\/Landing/i;
const LANDING_URL = "https://buildertrend.net/app/Landing";

/** Matches the stamp content/buildertrend_landing.js puts on its replies. */
const LANDING_REPLY = "buildertrend_landing";

const HANDSHAKE_MS = 50000;

/**
 * How long one job may take from the moment the page accepts it.
 *
 * Nothing used to cap the fill at all. The content script's own waits add up to
 * roughly 145 seconds in the worst case — twelve selector lookups at ten
 * seconds each, plus two settles and a twenty-second save watch — and a queue
 * cannot be built on a step that might never end. Generous enough that a slow
 * BuilderTrend is not mistaken for a broken one.
 */
const SAVE_BUDGET_MS = 180000;

/** Tabs whose content script already explained itself, so we do not talk over it. */
const reported_tabs = new Set();

export async function fill_job(work_order, config, reuse_tab_id = null) {
  if (!work_order || typeof work_order !== "object")
    return { ok: false, error: "Invalid work order." };

  /* Asked now rather than trusted from when the row was queued. Null for every
     failure — signed out, unreachable, anything — because the answer to all of
     them is the same and it is not "carry on". */
  const scope = await current_scope();

  if (scope === null)
    return {
      ok: false,
      error:
        "The web app has not said which work orders it may hold, so nothing was created in Buildertrend.",
    };

  if (!scope_admits(work_order.description, scope))
    return {
      ok: false,
      error:
        scope.mode === "sample"
          ? "Sample mode is on, and that work order is not marked as a test work order. Nothing was created."
          : "That is a test work order and the web app is set to real work only. Nothing was created.",
    };

  /* Buildertrend has no test mode, so the mark has to be in the job's name. */
  const job = marked(work_order.description, scope.marker)
    ? { ...work_order, title_prefix: SAMPLE_TITLE_PREFIX }
    : work_order;

  /* A tab of our own, opened **unfocused** and focused a moment later.
   *
   * It used to be created focused, because the fill dims the page and blocks
   * clicks while it runs and a manager should see that happening rather than
   * discover it later in a background tab. That is still true of a fill — but
   * it meant a lapsed session took over her screen to show her a login page,
   * which is the one case where stealing focus buys nothing.
   *
   * So the tab is opened quietly, asked what it is, and only then brought
   * forward — for the fill, or for the sign-in page, and the answer decides
   * which. One tab either way, and it is the same tab: being redirected to
   * login.buildertrend.com is what produced the verdict, so it is already
   * sitting on the page she needs. */
  /* A tab of this run's own, or the one the sequencer is already using.
     
     Reusing it is not tidiness: twenty ticked rows used to mean twenty tabs,
     because every job created its own and nothing ever closed them. Navigating
     the one tab back to the new-job page is also what re-injects the content
     script, since it is only declared for /JobPage/0/*. */
  /* Locked from the moment it opens: see background/owned_tabs.js. */
  const label = `Creating the Buildertrend job for work order ${job.number || ""}`.trim();

  /* Opened on Landing, not the new-job page: the job is looked for before one
     is created. See look_before_creating(). */
  const tab = reuse_tab_id === null
    ? await open_owned_tab("buildertrend", LANDING_URL, { active: false, label })
    : await navigate_tab(reuse_tab_id, LANDING_URL);

  if (!tab?.id) return { ok: false, error: "Could not open a Buildertrend tab." };

  lock(tab.id, label);
  reported_tabs.delete(tab.id);

  await wait_for_load(tab.id);

  const portal = await check_signed_in("buildertrend", tab.id);

  if (portal.state === "signed_out") {
    /* Hers now: unlocked, and not closed or reused by anything after this. */
    await hand_over(tab.id);
    await show_sign_in(tab.id);

    return {
      ok: false,
      error: "You are signed out of Buildertrend. Sign in on the tab just opened, then try again.",
    };
  }

  const title = expected_title(job);
  const existing = await look_before_creating(tab.id, { title, number: job.number });

  if (existing.ok === true)
    return { ok: true, created: true, existing: true, tab_id: tab.id, url: existing.url, title };

  if (existing.absent !== true) {
    const refusal = {
      ok: false,
      created: false,
      error:
        existing.error
          ? `Nothing was created in Buildertrend. ${existing.error}`
          : "Buildertrend's job list could not be checked, so nothing was created.",
      detail: { ...(existing.detail || {}), stage: "find_before_create" },
    };

    await close_owned_tab(tab.id, {
      owner: "buildertrend",
      label,
      number: job.number || "",
      state: "failed",
      step: "find_before_create",
      error: refusal.error,
      detail: refusal.detail,
      run: "manual",
    });

    return refusal;
  }

  if (!(await navigate_tab(tab.id, ADD_JOB_URL)))
    return { ok: false, error: "The Buildertrend tab was closed before the job was created." };

  const outcome = await drive(tab.id, job, config);

  if (outcome.ok === true) return { ...outcome, tab_id: tab.id };

  /* Anything short of a linked job closes the tab, with a report of what it
     showed. That includes a job that saved but could not be identified: the
     job is fine, but the tab is the only evidence of why the lookup missed,
     and the run carries on in a fresh tab either way. */
  await close_owned_tab(tab.id, {
    owner: "buildertrend",
    label,
    number: job.number || "",
    state: outcome.created === true ? "unidentified" : "failed",
    step: outcome.detail?.stage || "",
    error: outcome.error || "",
    detail: outcome.detail || null,
    run: "manual",
  });

  const { tab_id: _closed, ...rest } = outcome;

  return rest;
}

/** Everything after the tab is open and signed in, as one outcome. */
async function drive(tab_id, job, config) {
  const tab = { id: tab_id };

  /* `unknown` goes on. It is the answer for a slow page as much as an
     unrecognised one, and report_not_ready() below already words every way
     this can fail from here. */
  await chrome.tabs.update(tab.id, { active: true }).catch(() => null);

  /* Asked directly rather than waited for.
   *
   * v1 armed a listener for the page's ADD_JOB_PAGE_READY broadcast before
   * starting the navigation, because a fast load would otherwise finish before
   * anybody was listening. Creating the tab starts the navigation immediately,
   * so that arrangement is no longer available — and it was always the awkward
   * half of the design.
   *
   * Asking is strictly better and costs nothing, because the page memoizes its
   * own verdict: whether it worked it out a second ago or is still polling for
   * it, ADD_JOB_PAGE_STATUS returns the same promise. There is no window in
   * which the answer can be missed. */
  const state = await ask_page_state(tab.id);

  if (state !== "ready") return report_not_ready(tab.id);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "FILL_OUT_JOB",

      /* Only the four facts that page needs. It runs on buildertrend.net, and
         handing it the web app's address and anything else in settings would be
         giving a third party's page our configuration for no reason. */
      payload: {
        work_order: job,
        config: {
          job_type: config?.job_type,
          job_group: config?.job_group,
          bt_client_name: config?.bt_client_name,
          bt_client_row_id: config?.bt_client_row_id,
        },
      },
    });

    if (response?.accepted === false)
      return { ok: false, error: response.error || "The page refused the request." };

    /* And now wait for it to actually happen.
     *
     * This used to return here, the moment the page said `accepted: true` —
     * an *acceptance*, tens of seconds before anything was saved. The
     * background never learned the outcome at all: the page proved its own
     * save, sent a fire-and-forget UNQUEUE_FROM_BT, and that was the end of it.
     *
     * Which cannot support a queue. Something has to know when one job is done
     * before it starts the next, and it cannot be a message from a tab that is
     * in the act of navigating away — that message races the very navigation
     * the save causes, and loses if the tab is closed in the window. */
    return watch_for_saved_job(tab.id, { title: expected_title(job), number: job.number });
  } catch {
    return {
      ok: false,
      error: "The Buildertrend page stopped responding. Please reload it and try again.",
    };
  }
}

/**
 * The title the filler is about to type, which is also the only handle on the
 * saved job afterwards.
 *
 * Buildertrend never puts the new job's id in a URL, so this string is what
 * identifies it in the picker later. The two have to agree exactly, which is
 * why one function builds it and both legs call that function.
 */
function expected_title(work_order) {
  return `${work_order.title_prefix || ""}(${work_order.number || ""}) ${work_order.street || ""}`;
}

function watch_for_saved_job(tab_id, wanted, timeout = SAVE_BUDGET_MS) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(on_updated);
      chrome.tabs.onRemoved.removeListener(on_removed);
      chrome.runtime.onMessage.removeListener(on_message);

      resolve(outcome);
    };

    const on_updated = (id, info, tab) => {
      if (id !== tab_id) return;

      const url = info.url || tab?.url || "";

      /* Landing means saved. Asking it *which* job takes another round trip,
         so that happens after this resolves rather than inside a listener. */
      if (LANDING.test(url)) finish({ ok: true, tab_id, landed: true });
    };

    const on_removed = (id) => {
      if (id === tab_id)
        finish({ ok: false, error: "The Buildertrend tab was closed before the job was saved." });
    };

    /* The page's own verdict, when it has one. It reports a refusal far sooner
       than the budget would, and its message names the field. */
    const on_message = (message, sender) => {
      if (sender?.tab?.id !== tab_id) return;
      if (message?.type !== "CRITICAL_ERROR") return;

      finish({ ok: false, tab_id, error: text_of(message.payload) || "The job could not be saved." });
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          tab_id,
          error:
            "Buildertrend did not finish saving in time. Check whether the job was created before "
            + "trying again.",
        }),
      timeout,
    );

    chrome.tabs.onUpdated.addListener(on_updated);
    chrome.tabs.onRemoved.addListener(on_removed);
    chrome.runtime.onMessage.addListener(on_message);
  }).then((outcome) => (outcome.landed === true ? read_saved_job(tab_id, wanted) : outcome));
}

/**
 * Ask the Landing page to find the job by title, and refuse anything else.
 *
 * This asked for the *selected* job until a live run proved that saving one
 * does not select it: after `(19410-1)` was created, Landing still showed
 * `(19409-1)` throughout. Recording that would have pointed two work orders at
 * one job. content/buildertrend_landing.js searches the job picker instead —
 * the reasoning is in that file's header.
 *
 * A job that saved but could not be identified is still a **saved job**. It is
 * reported as a failure so nothing is recorded against the work order, which
 * leaves the link visibly missing rather than quietly wrong. That trade is
 * taken knowingly, and the message says to go and look before re-running.
 */
/**
 * Whether Buildertrend already has this job, asked before creating one.
 *
 * The queue and the one-run-at-a-time guard stop this extension from creating
 * a job twice while it remembers doing so. This covers what they cannot: a
 * worker evicted mid-run, a job somebody made by hand, a link that was lost.
 * Only a definite answer from the page lets a job be created — `absent: true`,
 * meaning the list painted, filtered and showed no match. A duplicate, a list
 * that never loaded or a page that never answered all refuse.
 */
async function look_before_creating(tab_id, wanted) {
  const answer = await read_saved_job(tab_id, wanted, { attempts: 3, stop_on_absent: true });

  if (answer.ok === true) return { ok: true, url: answer.url };

  return { ok: false, absent: answer.absent === true, error: answer.error, detail: answer.detail };
}

async function read_saved_job(tab_id, wanted, { attempts = 12, stop_on_absent = false } = {}) {
  /* Buildertrend is a single-page app, and the redirect to Landing is a
     same-document navigation. `chrome.tabs.onUpdated` reports those — which is
     why the save is detected at all — but **Chrome does not inject content
     scripts on them**, so content/buildertrend_landing.js, declared for
     /app/Landing*, never runs. Every message then lands on no listener, all
     twelve attempts throw, and a job that saved perfectly is reported as
     unidentifiable. That is what it did.

     Reloading gives it a real document load, which injects the script. It is
     done on demand rather than every time: when the navigation happens to be a
     full one the listener is already there, and the reload is a wasted page
     load. The job is saved before any of this, so reloading costs nothing but
     time. */
  let reloaded = false;

  /* What the attempts learned, kept rather than discarded.
   *
   * This loop used to throw away everything it was told and end with one
   * generic sentence, twelve times over — so "the script never ran", "the list
   * was empty" and "the rows read differently from the title" were the same
   * string, and each was diagnosed by guesswork costing a full run. The
   * landing script computes the real reason; this keeps the last one, and
   * `answered` separates a page that refused from a page that was never
   * there, which need opposite fixes. */
  let answered = false;
  let last_error = "";
  let last_detail = null;
  let attempts_used = 0;

  /* Land on Landing properly before asking it anything.
   *
   * Buildertrend's redirect after a save is a **same-document** navigation, so
   * Chrome injects nothing: content/buildertrend_landing.js never runs, and
   * content/buildertrend_add_job.js — declared for the page we just left — is
   * still alive in the document. That script receives LANDING_FIND_JOB, does
   * not recognise it, and falls off the end of its listener without answering,
   * which closes the port and makes `sendMessage` resolve `undefined` instead
   * of throwing. Every recovery here keyed off a throw, so none of them fired,
   * and twelve attempts in a row reported nothing whatsoever. That is the whole
   * reason this leg has never once recorded a link.
   *
   * Navigating to the same URL is a real document load: the stale script goes,
   * the right one is injected. Done up front rather than as a recovery, because
   * a mechanism that has to detect the problem first is a mechanism that can
   * fail to detect it — which is exactly what happened. Two or three seconds,
   * once per job, buys a deterministic starting state. */
  await chrome.tabs.update(tab_id, { url: LANDING_URL }).catch(() => null);
  await wait_for_load(tab_id);

  for (let attempt = 0; attempt < attempts; attempt++) {
    attempts_used = attempt + 1;

    /* The picker is a virtualised list over ~900 jobs, and Chrome does not
       paint a hidden tab — so in a background tab the rows are not merely
       offscreen, they are **absent from the DOM**, and the lookup finds
       nothing. Measured: the identical query returns one row foregrounded and
       zero backgrounded.
   
       So the tab is asked forward before each attempt. On the tab that is
       already active this is a no-op, which is the normal case since the fill
       brought it forward already; it costs a focus change only when something
       actually took focus away, and only for the few seconds this runs. The
       alternative — accepting that a manager who switches tabs mid-batch gets
       jobs created with no link — is the failure this whole path exists to
       prevent. */
    await chrome.tabs.update(tab_id, { active: true }).catch(() => null);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const answer = await chrome.tabs.sendMessage(tab_id, {
        type: "LANDING_FIND_JOB",
        payload: wanted,
      });

      /* Only an answer from the Landing script counts. Anything else means
         some other content script holds the port — which reads as a perfectly
         ordinary "no" unless it is checked for. */
      if (answer?.from !== LANDING_REPLY) {
        last_error =
          "The Buildertrend page that answered was not the job list, so the job could not be looked up.";
        last_detail = { wrong_listener: true };

        if (!reloaded) {
          reloaded = true;

          await chrome.tabs.reload(tab_id).catch(() => null);
          await new Promise((resolve) => setTimeout(resolve, 500));
          await wait_for_load(tab_id);
        }

        continue;
      }

      answered = true;

      if (answer?.ok === true)
        return { ok: true, created: true, tab_id, url: answer.url, title: wanted?.title || "" };

      /* Before creating, a definite miss or a duplicate is the answer and
         asking again changes nothing. After a save, a miss is only a list that
         has not caught up, so it keeps asking as it always did. */
      if (stop_on_absent && (answer?.absent === true || answer?.duplicate === true))
        return {
          ok: false,
          absent: answer.absent === true,
          error: answer.error || "",
          detail: { stage: "find_job", answered: true, reloaded, attempts: attempts_used, ...(answer.detail || {}) },
        };

      /* A page showing the wrong job keeps saying so, and a page still
         rendering says the same thing — so this keeps asking rather than
         believing the first no. The last word is the one worth keeping: by
         then the list has had every chance to render. */
      last_error = answer?.error || "";
      last_detail = answer?.detail || null;
    } catch (error) {
      last_error = `No listener on the Landing page: ${error?.message || error}`;

      /* No listener. Either Landing has not finished loading, or it was
         reached without a document load and never will have one. The first
         resolves by waiting; only the second resolves by reloading, and one
         reload settles both. */
      if (!reloaded) {
        reloaded = true;

        await chrome.tabs.reload(tab_id).catch(() => null);

        /* A tab still reports `complete` for a moment after reload() is called,
           and wait_for_load() returns immediately on `complete` — so without
           this it would wait for the load it was asked to wait for and miss it. */
        await new Promise((resolve) => setTimeout(resolve, 500));

        await wait_for_load(tab_id);
      }
    }
  }

  /* `created: true` is the important half. Reaching this function at all means
     Landing was reached, which means the save went through — so the job exists
     in Buildertrend whatever happened next. The caller needs that to take the
     row out of the queue: leaving it in is how a re-run makes a second real
     job, and two jobs sharing a title make the id unfindable for both. */
  return {
    ok: false,
    created: true,
    tab_id,
    /* The title travels with the failure because it is the only handle left on
       a job whose id could not be read — it is what LINK_NOW searches for. */
    title: wanted?.title || "",
    error:
      last_error
      || "The job was created in Buildertrend but could not be identified afterwards.",
    detail: {
      stage: "find_job",
      answered,
      reloaded,
      attempts: attempts_used,
      ...(last_detail || {}),
    },
  };
}

/** A CRITICAL_ERROR carries a bare string, not an object. */
function text_of(payload) {
  return typeof payload === "string" ? payload : "";
}

/**
 * Ask the page what state it is in, retrying only for a missing listener.
 *
 * The content script runs at document_idle, which is normally in place by the
 * time the tab reports `complete` — but "normally" is not "always", and the
 * failure mode is a thrown "receiving end does not exist" that looks exactly
 * like a signed-out page. A couple of retries tells the two apart.
 */
async function ask_page_state(tab_id, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await with_timeout(
        chrome.tabs.sendMessage(tab_id, { type: "ADD_JOB_PAGE_STATUS" }),
        HANDSHAKE_MS,
      );

      return response?.state || "unconfirmed";
    } catch {
      /* The last attempt's failure is the answer; earlier ones are just early. */
      if (attempt === attempts - 1) return "unconfirmed";

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return "unconfirmed";
}

function with_timeout(promise, timeout) {
  let timer = null;

  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out.")), timeout);
    }),
  ]);
}

/**
 * "Not ready" is not the same as "signed out".
 *
 * v1's insight, kept: Buildertrend redirects a signed-out user off the job page
 * entirely, and the content script only runs on that page — so the redirect is
 * the reliable signal, and a missing handshake on the right URL means something
 * slower and vaguer.
 */
async function report_not_ready(tab_id) {
  const tab = await chrome.tabs.get(tab_id).catch(() => null);
  const url = tab?.url || "";

  if (url !== "" && !url.includes(ADD_JOB_PATH))
    return {
      ok: false,
      error:
        "Buildertrend redirected away from the new job page. Check that you are logged in, then try again.",
    };

  if (reported_tabs.has(tab_id))
    return { ok: false, error: "", already_reported: true };

  return {
    ok: false,
    error: "The Buildertrend job page did not finish loading. Please reload it and try again.",
  };
}

/**
 * Note a page that has explained its own problem.
 *
 * report_not_ready() checks this so the extension does not stack a vaguer
 * message on top of the specific one the page already sent — v1's behaviour,
 * kept, now that both messages end up in the same notification channel.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "ADD_JOB_PAGE_PROBLEM" && sender.tab?.id)
    reported_tabs.add(sender.tab.id);
});

/**
 * Wait for the tab to finish loading, unless it already has.
 *
 * The check first is not a micro-optimisation. The listener is armed after
 * tabs.create has resolved, so a tab that loaded in between would never see a
 * `complete` event and this would sit out its whole fifty-second timeout before
 * carrying on to succeed anyway.
 */
/** Point an existing tab at `url` and wait for it to load. */
async function navigate_tab(tab_id, url) {
  try {
    const tab = await chrome.tabs.update(tab_id, { url });

    if (!tab?.id) return null;

    await wait_for_load(tab.id);

    return tab;
  } catch {
    /* The manager closed it between jobs. The caller opens a fresh one. */
    return null;
  }
}

async function wait_for_load(tab_id, timeout = HANDSHAKE_MS) {
  const current = await chrome.tabs.get(tab_id).catch(() => null);
  if (current?.status === "complete") return;

  return new Promise((resolve) => {
    const settle = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (updated_tab_id, info) => {
      if (updated_tab_id === tab_id && info.status === "complete") settle();
    };

    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(settle, timeout);
  });
}

/**
 * Work the BuilderTrend queue, one job at a time, in one tab.
 *
 * Sequential and not parallel, for the reason the AppFolio scrape is: several
 * tabs filling forms against the same account at once is a way to be
 * rate-limited, and a way to lose track of which one failed.
 *
 * It stops at the first job that does not **save**. A run that carried on
 * would open a fresh tab for every remaining row and fail each the same way,
 * which is the behaviour the delivery drainer's signed-out check exists to
 * avoid — and the causes (signed out of BuilderTrend, the web app unreachable,
 * a renamed field) all fail every job identically.
 *
 * **A job that saved but could not be identified is not that**, and used to be
 * treated as though it were: one unreadable id halted twenty rows that would
 * each have been created perfectly. The job exists, the work is done, and the
 * only thing outstanding is a link the caller can park and retry without
 * touching Buildertrend's form again. So that case counts as created, is
 * carried out through `record`, and the run goes on.
 *
 * @param {(outcome: {number, ok, created, url?, error?, detail?}) => Promise<void>} record
 *   called after each job, so the caller can write the URL back and dequeue
 *   without this knowing anything about either.
 */
export async function run_queue(work_orders, config, record) {
  const summary = {
    created: 0,
    /* Found in Buildertrend before creating, and linked rather than made. */
    already: 0,
    unidentified: 0,
    failed: 0,
    skipped: 0,
    stopped: false,
    reason: "",
  };

  let tab_id = null;

  for (const work_order of work_orders) {
    const number = String(work_order?.number || "").trim();
    if (number === "") continue;

    const outcome = await fill_job(work_order, config, tab_id);

    /* A job that went wrong closed its tab, so the next one opens a fresh tab;
       a job that went right leaves its tab for the next to reuse. */
    tab_id = outcome.tab_id || null;

    /* Created covers both "linked" and "saved but unidentified": Buildertrend
       holds a job either way, and the difference is only whether we know where
       it is. */
    const created = outcome.ok === true || outcome.created === true;

    if (outcome.existing) summary.already += 1;
    else if (outcome.ok) summary.created += 1;
    else if (created) summary.unidentified += 1;
    else summary.failed += 1;

    await record({
      number,
      ok: outcome.ok === true,
      created,
      existing: outcome.existing === true,
      url: outcome.url,
      title: outcome.title,
      error: outcome.error,
      detail: outcome.detail,
    });

    if (!created) {
      summary.stopped = true;
      summary.reason = outcome.error || "A job could not be created.";
      summary.skipped = Math.max(
        0,
        work_orders.length - summary.created - summary.already - summary.unidentified - summary.failed,
      );

      break;
    }
  }

  /* Closed however the run ended. A stopped run closed its failing tab already. */
  await close_owned_tab(tab_id);

  return summary;
}

/**
 * Find a job that already exists, so a missing link can be repaired.
 *
 * This is the same picker search the run uses, in the one condition that suits
 * it: a tab opened for this and brought to the front, with no fill racing it
 * and nothing queued behind it. The run's lookup gets one chance in the
 * seconds after a save; this one can simply be tried again, which is why a
 * failure here is recoverable and a failure there was not.
 *
 * It never opens the add-job page, so it cannot create a job — the property
 * that makes it safe to put behind a button somebody may press twice.
 */
export async function find_existing_job(number, title) {
  const wanted = String(title || "").trim();

  if (wanted === "")
    return {
      ok: false,
      error: `Nothing is known about what ${number} is called in Buildertrend, so it cannot be found.`,
    };

  const label = `Looking up work order ${number} in Buildertrend`;
  const tab = await open_owned_tab("buildertrend", LANDING_URL, { active: true, label });

  if (!tab?.id) return { ok: false, error: "Could not open a Buildertrend tab." };

  await wait_for_load(tab.id);

  const portal = await check_signed_in("buildertrend", tab.id);

  if (portal.state === "signed_out") {
    await hand_over(tab.id);

    return {
      ok: false,
      error: "You are signed out of Buildertrend. Sign in on the tab just opened, then try again.",
    };
  }

  const outcome = await read_saved_job(tab.id, { title: wanted, number: String(number) });

  /* Closed either way. A lookup that missed used to leave its tab open as the
     evidence; the report is the evidence now, and it is written first. */
  await close_owned_tab(
    tab.id,
    outcome.ok
      ? null
      : {
          owner: "buildertrend",
          label,
          number: String(number),
          state: "failed",
          step: "find_job",
          error: outcome.error || "",
          detail: outcome.detail || null,
          run: "manual",
        },
  );

  if (!outcome.ok) return { ok: false, error: outcome.error, detail: outcome.detail };

  return { ok: true, url: outcome.url };
}

export { ADD_JOB_URL, ADD_JOB_PATH };
