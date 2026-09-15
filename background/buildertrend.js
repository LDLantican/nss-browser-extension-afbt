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

const ADD_JOB_URL = "https://buildertrend.net/app/JobPage/0/1?openCondensed=true";
const ADD_JOB_PATH = "/app/JobPage/0/";

/** Where Buildertrend sends you after saving a new job. Not to the job. */
const LANDING = /^https:\/\/buildertrend\.net\/app\/Landing/i;

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
  const tab = reuse_tab_id === null
    ? await chrome.tabs.create({ url: ADD_JOB_URL, active: false })
    : await navigate_to_new_job(reuse_tab_id);

  if (!tab?.id) return { ok: false, error: "Could not open a Buildertrend tab." };

  reported_tabs.delete(tab.id);

  await wait_for_load(tab.id);

  const portal = await check_signed_in("buildertrend", tab.id);

  if (portal.state === "signed_out") {
    await show_sign_in(tab.id);

    return {
      ok: false,
      error: "You are signed out of Buildertrend. Sign in on the tab just opened, then try again.",
    };
  }

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
async function read_saved_job(tab_id, wanted) {
  /* The redirect has fired; Landing renders its job picker afterwards. */
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const answer = await chrome.tabs.sendMessage(tab_id, {
        type: "LANDING_FIND_JOB",
        payload: wanted,
      });

      if (answer?.ok === true) return { ok: true, tab_id, url: answer.url };

      /* A page showing the wrong job keeps saying so, and a page still
         rendering says the same thing — so this keeps asking rather than
         believing the first no. */
    } catch {
      /* No listener yet: Landing has not finished loading. */
    }
  }

  return {
    ok: false,
    tab_id,
    error:
      "The job was created in Buildertrend but could not be identified afterwards, so nothing was "
      + "recorded against the work order. Check Buildertrend before running it again.",
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
/** Point an existing tab back at the blank new-job page and wait for it. */
async function navigate_to_new_job(tab_id) {
  try {
    const tab = await chrome.tabs.update(tab_id, { url: ADD_JOB_URL, active: false });

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
 * It stops at the first job that does not save. A run that carried on would
 * open a fresh tab for every remaining row and fail each the same way, which is
 * the behaviour the delivery drainer's signed-out check exists to avoid — and
 * the common causes here (signed out of BuilderTrend, the web app unreachable,
 * a renamed field) are all conditions that fail every job identically.
 *
 * @param {(outcome: {number: string, ok: boolean, url?: string, error?: string}) => Promise<void>} record
 *   called after each job, so the caller can write the URL back and dequeue
 *   without this knowing anything about either.
 */
export async function run_queue(work_orders, config, record) {
  const summary = { created: 0, failed: 0, skipped: 0, stopped: false, reason: "" };

  let tab_id = null;

  for (const work_order of work_orders) {
    const number = String(work_order?.number || "").trim();
    if (number === "") continue;

    const outcome = await fill_job(work_order, config, tab_id);

    /* Whatever happened, the tab it used is the tab the next one should use. */
    if (outcome.tab_id) tab_id = outcome.tab_id;

    if (outcome.ok) summary.created += 1;
    else summary.failed += 1;

    await record({ number, ok: outcome.ok === true, url: outcome.url, error: outcome.error });

    if (!outcome.ok) {
      summary.stopped = true;
      summary.reason = outcome.error || "A job could not be created.";
      summary.skipped = Math.max(0, work_orders.length - summary.created - summary.failed);

      break;
    }
  }

  return summary;
}

export { ADD_JOB_URL, ADD_JOB_PATH };
