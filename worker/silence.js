/**
 * A silent page's status check, in words (4.1.9).
 *
 * When a page takes a command and does not answer in time, chrome_env.js's
 * page.send asks it for a status check (`ASH_PAGE_DIAG`), which a page script
 * that is running at all answers at once. This puts the answer after "did not
 * answer": where the command was, whether the page was hidden, how late its
 * timers ran, how long long tasks held its main thread, and whether Chrome
 * froze it — or, when even the status check went unanswered, that the page's
 * main thread is held. That reaches the delivery's timeline, so a silent page
 * is a diagnosis, not a shrug.
 *
 * Pure, so it is tested under Node (tests/worker/silence_test.js). A page
 * whose main thread is held cannot be staged on the extension's own test page:
 * every extension page shares one renderer process, so holding one holds the
 * test page too.
 */

const seconds = (ms) => String(Math.round(Number(ms || 0) / 100) / 10);

/** What page.send's status check came back with when the page could not answer it. */
export const BUSY = "busy";

/**
 * What Chrome itself says about the tab (4.1.10): frozen or not, discarded,
 * still loading, in front or behind, its group open or collapsed. On
 * 2026-11-24 the list page went silent five times with no answer to the status
 * check, which a frozen tab and a busy one both give; Chrome's own flag tells
 * them apart.
 *
 * @param {{frozen: ?boolean, discarded: boolean, status: ?string, active: boolean, group_collapsed: ?boolean}|null} tab
 */
export function describe_tab(tab) {
  if (!tab) return "";

  const parts = [];

  if (tab.frozen === true) parts.push("Chrome reports the tab frozen");
  else if (tab.frozen === false) parts.push("Chrome reports the tab not frozen");
  if (tab.discarded) parts.push("Chrome had discarded it");
  if (tab.status && tab.status !== "complete") parts.push(`it was still ${tab.status}`);
  parts.push(tab.active ? "it was the tab in front" : "it was a background tab");
  if (tab.group_collapsed === true) parts.push("in a collapsed group");
  else if (tab.group_collapsed === false) parts.push("in an open group");

  return parts.join(", ");
}

/**
 * @param {object|string|null} diag  the page's answer, BUSY, or null when the
 *                                   page takes no status checks (the vendor
 *                                   portal, the fixture), which adds nothing
 * @param {string} command           the command that went unanswered
 * @param {object|null} tab          what Chrome says about the tab (describe_tab)
 * @return {string}                  to follow the failure's first clause
 */
export function explain_silence(diag, command, tab = null) {
  const chrome_says = describe_tab(tab);

  if (diag === BUSY)
    return `, and did not answer a status check either: its main thread is busy, or Chrome has frozen it${chrome_says ? ` (${chrome_says})` : ""}`;
  if (!diag || typeof diag !== "object") return chrome_says ? `: ${chrome_says}` : "";

  return `${page_says(diag, command)}${chrome_says ? `; ${chrome_says}` : ""}`;
}

/** What the page said of itself in its status check. */
function page_says(diag, command) {
  const parts = [];
  const mine = (diag.active || []).find((entry) => entry.command === command) || (diag.active || [])[0];

  parts.push(mine ? `it was at "${mine.stage}" for ${seconds(mine.stage_for_ms)} s` : "it had finished every command, so the answer was lost on the way");
  parts.push(`the page was ${diag.visibility || "of unknown visibility"}`);
  parts.push(diag.worst_timer_lag_ms >= 1000 ? `its timers ran up to ${seconds(diag.worst_timer_lag_ms)} s late` : "its timers were on time");
  if (diag.long_tasks?.count) parts.push(`long tasks held it for ${seconds(diag.long_tasks.total_ms)} s of the last minute`);
  if (diag.freezes) parts.push(`Chrome froze it ${diag.freezes} times`);

  return `: ${parts.join("; ")}`;
}
