/**
 * The appfolio_pm adapter's reach into AppFolio's own JavaScript, run in the
 * page's world ("world": "MAIN" in the manifest) on the inspection list and the
 * New Inspection form. page.js cannot do these from the extension's isolated
 * world, and the worker's tab is a background tab in the collapsed ASH group,
 * where the page's own controls do not behave as they do under a person's hand.
 *
 * Two things, each found by a live run on 2026-10-22:
 *
 *   select2   The address box is select2 3, which searches only while its box
 *             has focus — which a background tab never gives it — so typed
 *             text found "no property or unit at 415 Boyce". Its API (open,
 *             search.val, updateResults, highlight, selectHighlighted) works
 *             without focus, but lives on the page's jQuery.
 *   row_url   A list row opens its inspection with window.open, which Chrome's
 *             popup blocker refuses for a script's click in a background tab,
 *             so the verification after a killed Start found INS-000004 on the
 *             list but could never open it. The row's own click is made with
 *             window.open intercepted for that moment, and the address it
 *             would have opened is handed back; nothing is opened.
 *
 * It decides nothing: which result fits, which row is meant and what the address
 * says are page.js's and adapter.js's rules. It is asked with an `ash:bridge`
 * event on document, the detail a JSON string (objects do not cross worlds), and
 * answers with `ash:bridge:done` naming the same id. Whatever it cannot find to
 * drive is "unavailable", and page.js falls back to the old way.
 */

(() => {
  if (window.ash_page_bridge) return;

  window.ash_page_bridge = true;

  const METHODS = ["opened", "open", "updateResults", "highlight", "selectHighlighted"];

  const answer = (id, reply) => {
    document.dispatchEvent(new CustomEvent("ash:bridge:done", { detail: JSON.stringify({ id, ...reply }) }));
  };

  const select2_of = (selector) => {
    const input = document.querySelector(selector);
    const select2 = input && typeof window.jQuery === "function" ? window.jQuery(input).data("select2") : null;

    if (!select2 || !select2.search || METHODS.some((name) => typeof select2[name] !== "function")) return null;

    return select2;
  };

  const requests = {
    search(ask) {
      const select2 = select2_of(String(ask.input || ""));

      if (!select2) return { ok: false, reason: "unavailable" };

      if (!select2.opened()) select2.open();
      select2.search.val(String(ask.term || ""));
      select2.updateResults();

      return { ok: true };
    },

    pick(ask) {
      const select2 = select2_of(String(ask.input || ""));

      if (!select2) return { ok: false, reason: "unavailable" };

      const results = [...document.querySelectorAll(String(ask.results || ""))];
      const index = results.findIndex((li) => li.hasAttribute("data-ash-pick"));

      if (index < 0) return { ok: false, reason: "No result is marked to pick." };

      select2.highlight(index);
      select2.selectHighlighted({ noFocus: true });

      return { ok: true };
    },

    row_url() {
      const target = document.querySelector("[data-ash-open]");

      if (!target) return { ok: false, reason: "No row is marked to open." };

      const open = window.open;
      let url = null;

      window.open = (address) => {
        url = String(address ?? "");

        return null;
      };

      try {
        target.click();
      } finally {
        window.open = open;
      }

      return url ? { ok: true, url: new URL(url, location.href).href } : { ok: false, reason: "The row opened nothing." };
    },
  };

  document.addEventListener("ash:bridge", (event) => {
    let ask;

    try {
      ask = JSON.parse(String(event.detail));
    } catch {
      return;
    }

    const request = requests[ask.op];

    if (!request) return answer(ask.id, { ok: false, reason: `Unknown request ${ask.op}.` });

    try {
      return answer(ask.id, request(ask));
    } catch (error) {
      return answer(ask.id, { ok: false, reason: String(error?.message || error) });
    }
  });
})();
