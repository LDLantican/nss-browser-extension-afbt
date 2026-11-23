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
 * @param {object|string|null} diag  the page's answer, BUSY, or null when the
 *                                   page takes no status checks (the vendor
 *                                   portal, the fixture), which adds nothing
 * @param {string} command           the command that went unanswered
 * @return {string}                  to follow the failure's first clause
 */
export function explain_silence(diag, command) {
  if (diag === BUSY) return ", and did not answer a status check either: its main thread is busy, or Chrome has frozen it";
  if (!diag || typeof diag !== "object") return "";

  const parts = [];
  const mine = (diag.active || []).find((entry) => entry.command === command) || (diag.active || [])[0];

  parts.push(mine ? `it was at "${mine.stage}" for ${seconds(mine.stage_for_ms)} s` : "it had finished every command, so the answer was lost on the way");
  parts.push(`the page was ${diag.visibility || "of unknown visibility"}`);
  parts.push(diag.worst_timer_lag_ms >= 1000 ? `its timers ran up to ${seconds(diag.worst_timer_lag_ms)} s late` : "its timers were on time");
  if (diag.long_tasks?.count) parts.push(`long tasks held it for ${seconds(diag.long_tasks.total_ms)} s of the last minute`);
  if (diag.freezes) parts.push(`Chrome froze it ${diag.freezes} times`);

  return `: ${parts.join("; ")}`;
}
