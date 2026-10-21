/**
 * The appfolio_pm adapter's reach into the New Inspection form's address box,
 * run in the page's own JavaScript world ("world": "MAIN" in the manifest).
 *
 * AppFolio's address box is select2 3, which searches only while its search
 * box really has focus. The worker's tab is a background tab in the collapsed
 * ASH group, where select2 leaves its dropdown hidden and focus cannot land,
 * so typed text and synthetic key events are ignored — found by the dry run of
 * 2026-10-22, which came back "found no property or unit at 415 Boyce" for a
 * house AppFolio has. select2's own API (open, search.val, updateResults,
 * highlight, selectHighlighted) works without focus, but it lives on the
 * page's jQuery, which page.js cannot see from the extension's isolated world.
 *
 * So this does two things when asked, and decides nothing: run a search, and
 * pick the result page.js marked with `data-ash-pick`. Which result fits is
 * page.js's rule, as is everything about the form. It is asked with an
 * `ash:select2` event on document, the detail a JSON string (objects do not
 * cross worlds), and answers with `ash:select2:done` naming the same id. No
 * jQuery, no select2 on the input or a method missing is "unavailable", and
 * page.js falls back to typing.
 */

(() => {
  if (window.ash_select2_bridge) return;

  window.ash_select2_bridge = true;

  const METHODS = ["opened", "open", "updateResults", "highlight", "selectHighlighted"];

  const answer = (id, reply) => {
    document.dispatchEvent(new CustomEvent("ash:select2:done", { detail: JSON.stringify({ id, ...reply }) }));
  };

  const instance = (selector) => {
    const input = document.querySelector(selector);
    const select2 = input && typeof window.jQuery === "function" ? window.jQuery(input).data("select2") : null;

    if (!select2 || !select2.search || METHODS.some((name) => typeof select2[name] !== "function")) return null;

    return select2;
  };

  document.addEventListener("ash:select2", (event) => {
    let ask;

    try {
      ask = JSON.parse(String(event.detail));
    } catch {
      return;
    }

    const select2 = instance(String(ask.input || ""));

    if (!select2) return answer(ask.id, { ok: false, reason: "unavailable" });

    try {
      if (ask.op === "search") {
        if (!select2.opened()) select2.open();
        select2.search.val(String(ask.term || ""));
        select2.updateResults();

        return answer(ask.id, { ok: true });
      }

      if (ask.op === "pick") {
        const results = [...document.querySelectorAll(String(ask.results || ""))];
        const index = results.findIndex((li) => li.hasAttribute("data-ash-pick"));

        if (index < 0) return answer(ask.id, { ok: false, reason: "No result is marked to pick." });

        select2.highlight(index);
        select2.selectHighlighted({ noFocus: true });

        return answer(ask.id, { ok: true });
      }

      return answer(ask.id, { ok: false, reason: `Unknown request ${ask.op}.` });
    } catch (error) {
      return answer(ask.id, { ok: false, reason: String(error?.message || error) });
    }
  });
})();
