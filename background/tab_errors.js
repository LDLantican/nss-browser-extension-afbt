/**
 * What a tab looked like when a run gave up on it.
 *
 * Every tab this extension opens is closed when something goes wrong, so the
 * page — which used to be left open as the evidence — is gone by the time
 * anybody asks what happened. This keeps an account of it instead: where the
 * tab was, what the run was doing, what it was told, and as much of the page
 * as can be had without stealing anybody's focus.
 *
 * ## Sinks
 *
 * A report is one plain JSON object, built once and handed to every sink in
 * `SINKS`. There is one today: this browser's own storage, read by the
 * Diagnostics card in Settings. Sending them to the web app as well, so every
 * user's reports can be read in one place, is one more function in that array
 * and a route on the server — deliberately not built yet. `v` is on the object
 * so that server can tell the shape it is given.
 *
 * A sink must never throw into the run that is reporting. A run that failed
 * once must not fail a second time for being unable to say so.
 *
 * ## The screenshot, and why it is usually missing
 *
 * `chrome.tabs.captureVisibleTab` photographs the tab that is showing in a
 * window, and nothing else. The delivery and estimate tabs run in the
 * background on purpose — a queue that steals focus for every job is unusable —
 * and bringing one forward just to photograph it would steal focus at the
 * worst possible moment. So a screenshot is taken only when the tab is already
 * the visible one, and the DOM snapshot is what is there otherwise.
 */

import { update_tab_errors } from "./store.js";

/** How many reports are kept. Older ones drop off the end. */
const KEEP = 50;

/**
 * How many of the newest keep their screenshot and snapshot.
 *
 * The heavy parts, a few hundred kilobytes each. Everything older keeps the
 * words and loses the pictures, which is the useful half of an old report.
 */
const KEEP_HEAVY = 10;

const SINKS = [local_sink];

/**
 * Record one report. Never throws.
 *
 * @param {object} report
 *   `owner`, `label`, `number`, `step`, `state`, `error`, `detail`, `run`, and
 *   whatever capture() found — the caller supplies the words, this adds the
 *   envelope.
 */
export async function record_tab_error(report) {
  const entry = {
    v: 1,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    extension_version: chrome.runtime.getManifest().version,
    owner: report.owner || "",
    label: report.label || "",
    number: report.number || "",
    step: report.step || "",
    state: report.state || "",
    error: report.error || "",
    detail: report.detail ?? null,
    run: report.run || "",
    url: report.url || "",
    title: report.title || "",
    tab_closed_by_person: report.tab_closed_by_person === true,
    screenshot: report.screenshot || null,
    screenshot_note: report.screenshot_note || "",
    snapshot: report.snapshot || null,
    snapshot_note: report.snapshot_note || "",
  };

  for (const sink of SINKS) {
    try {
      await sink(entry);
    } catch {
      /* See the note at the top. */
    }
  }

  return entry;
}

async function local_sink(entry) {
  await update_tab_errors((current) => {
    const list = [entry, ...(Array.isArray(current) ? current : [])].slice(0, KEEP);

    return list.map((item, index) =>
      index < KEEP_HEAVY || (item.screenshot === null && item.snapshot === null)
        ? item
        : {
            ...item,
            screenshot: null,
            screenshot_note: item.screenshot ? "dropped — only the newest reports keep one" : item.screenshot_note,
            snapshot: null,
            snapshot_note: item.snapshot ? "dropped — only the newest reports keep one" : item.snapshot_note,
          },
    );
  });
}

/**
 * Everything that can be read off a tab before it is closed.
 *
 * Called with the guard already lifted, so a screenshot shows the page and not
 * the overlay over it. Each half fails on its own and says why, because "no
 * screenshot" with no reason reads as a bug in this file.
 */
export async function capture(tab_id) {
  const result = {
    url: "",
    title: "",
    screenshot: null,
    screenshot_note: "",
    snapshot: null,
    snapshot_note: "",
  };

  const tab = await chrome.tabs.get(tab_id).catch(() => null);

  if (!tab) {
    result.screenshot_note = "the tab was already closed";
    result.snapshot_note = "the tab was already closed";

    return result;
  }

  result.url = tab.url || "";
  result.title = tab.title || "";

  try {
    const snapshot = await with_timeout(
      chrome.tabs.sendMessage(tab_id, { type: "TAB_SNAPSHOT" }),
      5000,
    );

    if (typeof snapshot?.html === "string") result.snapshot = snapshot.html;
    else result.snapshot_note = "the page did not answer";
  } catch (error) {
    /* A sign-in page on another origin has no content script at all, which is
       the common reason, and is not worth more words than the error gives. */
    result.snapshot_note = `no snapshot: ${error?.message || error}`;
  }

  if (!tab.active) {
    result.screenshot_note = "unavailable — the tab was in the background";

    return result;
  }

  try {
    result.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
  } catch (error) {
    result.screenshot_note = `refused: ${error?.message || error}`;
  }

  return result;
}

function with_timeout(promise, timeout) {
  let timer = null;

  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), timeout);
    }),
  ]);
}
