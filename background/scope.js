/**
 * Which work orders this web app will accept — the service worker's copy.
 *
 * There are three implementations of this comparison and that is the Manifest
 * V3 tax, not a design:
 *
 *   App\Support\WorkOrderScope         the server, and the only authority
 *   content/appfolio_scrape.js         the content scripts, which cannot import
 *                                      an ES module (no "type": "module" for
 *                                      declarative content scripts)
 *   this file                          the worker, which cannot reach a content
 *                                      script's globals
 *
 * **Keep the two JavaScript copies identical but for indentation** — the other
 * one is nested inside a content script's IIFE — so a real difference between
 * them is obvious at a glance. And keep both subordinate to the server, which
 * re-checks every work order it is sent and every delivery it hands out.
 *
 * Drift is safe in both directions by construction: stricter here refuses a row
 * visibly, looser here is caught by the server. Neither silently bills.
 */

/**
 * Does this description carry the marker?
 *
 * Substring rather than equality, normalised first. A sentence appended to a
 * test work order must not un-mark it, and a non-breaking space or a word
 * processor's apostrophe is invisible in a browser and fatal to `===`.
 */
export function marked(description, marker) {
  const text = normalize_marker(description);
  const wanted = normalize_marker(marker);

  return wanted !== "" && text.includes(wanted);
}

/**
 * May this work order be acted on, given a scope the server stated?
 *
 * A missing or unrecognised scope answers **false**, always. Not knowing which
 * population this installation is pointed at is not a reason to guess.
 */
export function scope_admits(description, scope) {
  const mode = scope?.mode;
  if (mode !== "sample" && mode !== "live") return false;

  return marked(description, scope?.marker) === (mode === "sample");
}

/**
 * What to call a job created from a test work order, where it is going.
 *
 * Buildertrend has no test mode, so a job built from one of Dustin's samples is
 * a real Buildertrend job sitting in the same list as everything else. The
 * prefix is the only thing that will let somebody find them again and delete
 * them, so it goes on the title rather than anywhere subtler.
 */
export const SAMPLE_TITLE_PREFIX = "[TEST] ";

function normalize_marker(value) {
  return String(value ?? "")
    .replace(/[\u00a0\u200b]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
