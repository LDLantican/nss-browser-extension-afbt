/**
 * The appfolio_pm adapter's reach into AppFolio's own JavaScript, run in the
 * page's world ("world": "MAIN" in the manifest) on the inspection list, the
 * New Inspection form and an inspection. page.js cannot do these from the extension's isolated
 * world, and the worker's tab is a background tab in the ASH group (kept open
 * since 4.1.11, because Chrome freezes a collapsed group's tabs),
 * where the page's own controls do not behave as they do under a person's hand.
 *
 * Three things, each found by a live run on 2026-10-22:
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
 *   network   Pressing OK or FOLLOW-UP saves at once, and the page shows the
 *             switch on before AppFolio has stored it. A note saved in that
 *             gap was undone when the switch's save landed after it (Toilet's
 *             note on 925). So every request that writes — anything but a GET,
 *             by fetch or XMLHttpRequest — is counted from the moment the page
 *             sends it until its answer arrives, and page.js waits for the
 *             count to come back to nothing before it goes on. This runs at
 *             document_start, before AppFolio's own scripts can keep a fetch
 *             of their own.
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

  /*
   * Every request that writes, from send to answer. A GET never stores
   * anything, and a page that polls with one would otherwise never be quiet.
   * `failed` counts only this site's own writes refused or lost, because an
   * analytics beacon a blocker drops says nothing about a save.
   */
  const net = { inflight: 0, started: 0, failed: 0, last_failure: null, last_at: performance.now() };

  const writes = (method) => String(method || "GET").toUpperCase() !== "GET" && String(method || "").toUpperCase() !== "HEAD";
  const own = (url) => {
    try {
      return new URL(String(url), location.href).origin === location.origin;
    } catch {
      return false;
    }
  };
  const begin = () => {
    net.inflight++;
    net.started++;
    net.last_at = performance.now();
  };
  const end = (url, failure) => {
    net.inflight = Math.max(0, net.inflight - 1);
    net.last_at = performance.now();

    if (failure && own(url)) {
      net.failed++;
      net.last_failure = failure;
    }
  };

  const native_fetch = window.fetch;

  if (typeof native_fetch === "function") {
    window.fetch = function (input, init) {
      const method = init?.method || (input instanceof Request ? input.method : "GET");
      const url = input instanceof Request ? input.url : String(input);

      if (!writes(method)) return native_fetch.apply(this, arguments);

      begin();

      return native_fetch.apply(this, arguments).then(
        (response) => {
          end(url, response.ok ? null : `HTTP ${response.status}`);

          return response;
        },
        (error) => {
          end(url, String(error?.message || error));

          throw error;
        },
      );
    };
  }

  const xhr_open = XMLHttpRequest.prototype.open;
  const xhr_send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.ash_request = { method, url };

    return xhr_open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const request = this.ash_request;

    if (request && writes(request.method)) {
      begin();
      this.addEventListener(
        "loadend",
        () => end(request.url, this.status >= 200 && this.status < 400 ? null : this.status ? `HTTP ${this.status}` : "no answer"),
        { once: true },
      );
    }

    return xhr_send.apply(this, arguments);
  };

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

    /* How the page's writes stand: page.js decides what "stored" means. */
    network() {
      return {
        ok: true,
        inflight: net.inflight,
        started: net.started,
        failed: net.failed,
        last_failure: net.last_failure,
        idle_ms: Math.round(performance.now() - net.last_at),
      };
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
