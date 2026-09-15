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

const HANDSHAKE_MS = 50000;

/** Tabs whose content script already explained itself, so we do not talk over it. */
const reported_tabs = new Set();

export async function fill_job(work_order, config) {
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
  const tab = await chrome.tabs.create({ url: ADD_JOB_URL, active: false });

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

    return { ok: true, tab_id: tab.id };
  } catch {
    return {
      ok: false,
      error: "The Buildertrend page stopped responding. Please reload it and try again.",
    };
  }
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

export { ADD_JOB_URL, ADD_JOB_PATH };
