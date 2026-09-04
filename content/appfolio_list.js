/**
 * The Appfolio work-order list, with a tick box on every row.
 *
 * This is where the manager's real work happens, and the thing it has to be
 * good at is one job: choosing. Not every work order in Appfolio is ASH's, and
 * there is no field that says which are — so the choice is hers, row by row,
 * and **nothing here is ever ticked for her.** What this can do is make ticking
 * twenty rows and sending them one action instead of twenty rounds of
 * copy-paste, which is the actual cause of the backlog.
 *
 * ## The badges, and why they are allowed to say nothing
 *
 * Each row shows what the web app currently holds for that number. The status
 * is fetched live when the list renders and is **never** filled in from a
 * remembered value: if the web app cannot be reached or this device is signed
 * out, every row says "status unknown" and offers a retry.
 *
 * That is deliberate and it is the whole reason the badges are trustworthy. A
 * manager decides whether to sync a row by reading it, so a badge that might be
 * an hour stale is worse than a badge that admits it does not know — the first
 * causes a wrong decision quietly and the second causes a click.
 */

(() => {
  const nss = globalThis.nss;

  const PANEL_ID = "nss-bar";
  const LIST_PATH = "/maintenance/service_requests/work_orders";

  const app = {
    /** number => the row's own <li>, for the rows currently on screen. */
    rows: new Map(),

    /** number => true, the manager's ticks. Survives a re-render. */
    selected: new Set(),

    /** The last row ticked, so shift-click has a range to work from. */
    anchor: null,

    settings: {},

    /** Set while a sync is in flight, so the bar cannot be double-fired. */
    busy: false,

    async init() {
      const list = await nss.query_element(nss.SELECTORS.list);
      if (!list) return;

      const state = await nss.ask("STATE");
      app.settings = state?.settings || {};

      app.render_rows();
      app.render_bar();

      /* Badges come last and asynchronously: the ticking must work the instant
         the rows are drawn, whether or not the web app answers at all. */
      app.load_statuses();
    },

    /* ---- rows ------------------------------------------------------------ */

    render_rows() {
      app.rows.clear();

      for (const row of nss.list_rows()) {
        app.rows.set(row.number, row);
        app.decorate(row);
      }

      /* A tick for a row that has scrolled out of the page is dropped, so the
         count in the bar can never exceed what is on screen — a manager acting
         on "Sync 20" needs those to be twenty rows she can see. */
      for (const number of [...app.selected]) {
        if (!app.rows.has(number)) app.selected.delete(number);
      }
    },

    decorate(row) {
      if (row.element.querySelector(".nss-row")) return;

      const holder = document.createElement("div");
      holder.className = "nss-row";

      const label = document.createElement("label");
      label.className = "nss-tick";
      label.title = `Select work order ${row.number}`;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "nss-tick__box";
      box.checked = app.selected.has(row.number);
      box.dataset.number = row.number;

      box.addEventListener("click", (event) => app.on_tick(event, row.number));

      const badge = document.createElement("span");
      badge.className = "nss-badge nss-badge--loading";
      badge.dataset.number = row.number;
      badge.textContent = "checking…";

      label.appendChild(box);
      holder.appendChild(label);
      holder.appendChild(badge);

      row.element.classList.add("nss-has-row");
      row.element.appendChild(holder);
    },

    /**
     * Ticking a box, with shift for a range.
     *
     * Shift-click is the difference between selecting eighteen of twenty rows
     * in two clicks and in eighteen — and eighteen clicks is the thing this
     * extension exists to remove.
     */
    on_tick(event, number) {
      const box = event.currentTarget;

      if (event.shiftKey && app.anchor !== null && app.anchor !== number) {
        const numbers = [...app.rows.keys()];
        const from = numbers.indexOf(app.anchor);
        const to = numbers.indexOf(number);

        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const wanted = box.checked;

          for (let index = start; index <= end; index++) {
            if (wanted) app.selected.add(numbers[index]);
            else app.selected.delete(numbers[index]);
          }

          app.sync_boxes();
          app.render_bar();

          return;
        }
      }

      if (box.checked) app.selected.add(number);
      else app.selected.delete(number);

      app.anchor = number;
      app.render_bar();
    },

    sync_boxes() {
      for (const box of document.querySelectorAll(".nss-tick__box")) {
        box.checked = app.selected.has(box.dataset.number);
      }
    },

    select_all(wanted) {
      if (wanted) for (const number of app.rows.keys()) app.selected.add(number);
      else app.selected.clear();

      app.sync_boxes();
      app.render_bar();
    },

    /* ---- badges ---------------------------------------------------------- */

    async load_statuses() {
      const numbers = [...app.rows.keys()];
      if (numbers.length === 0) return;

      app.paint_badges("checking…", "loading");

      const answer = await nss.ask("STATUSES", { numbers });

      if (!answer?.ok) {
        /* The honest state. Not a cached value, not a blank — the row says it
           does not know, and says so identically for every row so a manager
           cannot mistake one for a real answer. */
        app.paint_badges(
          answer?.reason === "signed_out" ? "sign in for status" : "status unknown",
          "unknown",
          answer?.error || "",
        );

        app.render_bar(answer);

        return;
      }

      const found = answer.work_orders || {};

      for (const number of numbers) {
        const server = found[number] || null;

        if (!server) {
          app.paint_badge(number, "not in web app", "absent");

          continue;
        }

        const detail = [server.status_label || server.status];

        if (server.subcontractor) detail.push(server.subcontractor);
        else if ((server.line_count || 0) > 0) detail.push(`${server.line_count} lines`);

        app.paint_badge(
          number,
          detail.join(" · "),
          server.status === "approved" ? "done" : "present",
          `${server.title || number} — ${server.street || ""}`.trim(),
        );
      }

      app.render_bar(answer);
    },

    paint_badge(number, label, kind, title = "") {
      const badge = document.querySelector(`.nss-badge[data-number="${css_escape(number)}"]`);
      if (!badge) return;

      badge.className = `nss-badge nss-badge--${kind}`;
      badge.textContent = label;
      badge.title = title;
    },

    /** Every badge on the page to the same thing — used only for "unknown". */
    paint_badges(label, kind, title = "") {
      for (const badge of document.querySelectorAll(".nss-badge")) {
        badge.className = `nss-badge nss-badge--${kind}`;
        badge.textContent = label;
        badge.title = title;
      }
    },

    /* ---- the action bar -------------------------------------------------- */

    render_bar(status_answer = undefined) {
      let bar = document.getElementById(PANEL_ID);

      if (!bar) {
        bar = document.createElement("div");
        bar.id = PANEL_ID;
        bar.className = "nss-bar";
        document.body.appendChild(bar);
      }

      if (status_answer !== undefined) bar.dataset.statusError = status_answer?.ok ? "" : "1";

      const count = app.selected.size;
      const all_ticked = count > 0 && count === app.rows.size;
      const bt = app.settings.buildertrend_enabled !== false;

      bar.innerHTML = "";

      const left = document.createElement("div");
      left.className = "nss-bar__left";

      const tally = document.createElement("span");
      tally.className = "nss-bar__count";
      tally.textContent =
        count === 0
          ? `${app.rows.size} work orders on this page`
          : `${count} selected`;

      left.appendChild(tally);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nss-bar__link";
      toggle.textContent = all_ticked ? "Clear selection" : "Select all on page";
      toggle.addEventListener("click", () => app.select_all(!all_ticked));
      left.appendChild(toggle);

      if (bar.dataset.statusError === "1") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "nss-bar__link";
        retry.textContent = "Retry status";
        retry.addEventListener("click", () => app.load_statuses());
        left.appendChild(retry);
      }

      const right = document.createElement("div");
      right.className = "nss-bar__right";

      if (bt) {
        const also = document.createElement("label");
        also.className = "nss-bar__also";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.id = "nss-also-bt";
        box.checked = bar.dataset.alsoBt === "1";
        box.addEventListener("change", () => {
          bar.dataset.alsoBt = box.checked ? "1" : "";
        });

        also.appendChild(box);
        also.appendChild(document.createTextNode(" also queue for Buildertrend"));
        right.appendChild(also);
      }

      const send = document.createElement("button");
      send.type = "button";
      send.className = "nss-bar__go";
      send.disabled = count === 0 || app.busy;
      send.textContent = app.busy
        ? "Reading Appfolio…"
        : count === 0
          ? "Sync to web app"
          : `Sync ${count} to web app`;

      send.addEventListener("click", () => app.send());
      right.appendChild(send);

      bar.appendChild(left);
      bar.appendChild(right);

      app.note(bar);
    },

    note(bar) {
      const existing = bar.querySelector(".nss-bar__note");
      if (existing) existing.remove();

      if (!app.message) return;

      const note = document.createElement("p");
      note.className = `nss-bar__note nss-bar__note--${app.message.kind}`;
      note.textContent = app.message.text;
      bar.appendChild(note);
    },

    say(text, kind = "info") {
      app.message = { text, kind };
      app.render_bar();
    },

    /* ---- sending --------------------------------------------------------- */

    /**
     * Read the ticked rows and hand them to the service worker.
     *
     * The reading is the slow part and it happens here, because only a content
     * script can read Appfolio. Rows are read one at a time on purpose: forty
     * parallel fetches against the portal a manager is working in is a way to
     * be rate-limited, and the progress is worth more than the seconds.
     *
     * A row that cannot be read is reported and skipped. It is not sent as a
     * blank work order — the web app would take it, and a job with no address
     * is worse in a billing record than a job that is missing.
     */
    async send() {
      if (app.busy || app.selected.size === 0) return;

      app.busy = true;
      app.message = null;
      app.render_bar();

      const numbers = [...app.rows.keys()].filter((number) => app.selected.has(number));
      const work_orders = [];
      const failed = [];

      for (const [index, number] of numbers.entries()) {
        app.paint_badge(number, `reading ${index + 1} of ${numbers.length}…`, "loading");

        try {
          work_orders.push(await nss.scrape_row(app.rows.get(number)));
          app.paint_badge(number, "sending…", "loading");
        } catch (error) {
          failed.push(number);
          app.paint_badge(number, "could not read", "error", error?.message || "");
        }
      }

      if (work_orders.length === 0) {
        app.busy = false;
        app.say("Could not read any of the selected work orders from Appfolio.", "error");

        return;
      }

      const result = await nss.ask("SYNC", { work_orders });

      if (app.settings.buildertrend_enabled !== false) {
        const bar = document.getElementById(PANEL_ID);

        if (bar?.dataset.alsoBt === "1")
          await nss.ask("QUEUE_FOR_BT", { work_orders });
      }

      app.busy = false;

      /* Cleared only for the rows that were actually handed over. A row that
         could not be read stays ticked, because it still needs doing and
         un-ticking it would hide that. */
      for (const work_order of work_orders) app.selected.delete(work_order.number);
      app.sync_boxes();

      const sent = result?.queued ?? work_orders.length;

      app.say(
        failed.length === 0
          ? `${sent} sent to the web app. Watch the toolbar icon for the result.`
          : `${sent} sent. ${failed.length} could not be read and are still selected: ${failed.join(", ")}.`,
        failed.length === 0 ? "ok" : "warn",
      );

      /* Re-read from the web app rather than assuming the send worked. The
         badges then show what the app actually holds, which is the same
         principle the sync ledger's reconcile step runs on. */
      setTimeout(() => app.load_statuses(), 1200);
    },

    /* ---- the page is a SPA ----------------------------------------------- */

    watch_url() {
      let last = location.href;

      new MutationObserver(() => {
        if (location.href === last) return;
        if (!location.pathname.includes(LIST_PATH)) return;

        last = location.href;
        app.message = null;

        /* The rows are new, so the ticks belong to work orders that are no
           longer on screen. Keeping them would let "Sync 12" mean twelve rows
           the manager cannot see. */
        app.selected.clear();
        app.anchor = null;

        app.init();
      }).observe(document.body, { childList: true, subtree: true });
    },
  };

  /**
   * Appfolio's numbers are digits and a dash, so this is belt and braces — but
   * the selector is built from page content and CSS.escape is what stops a
   * surprising character from turning it into a different selector.
   */
  function css_escape(value) {
    return typeof CSS?.escape === "function"
      ? CSS.escape(value)
      : String(value).replace(/["\\]/g, "\\$&");
  }

  window.addEventListener("load", () => {
    app.init();
    app.watch_url();
  });
})();
