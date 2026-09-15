/**
 * The Appfolio work-order list, with a badge on every row.
 *
 * This is where the manager's real work happens, and the thing it has to be
 * good at is one job: choosing. Not every work order in Appfolio is ASH's, and
 * there is no field that says which are — so the choice is hers, row by row,
 * and **nothing here is ever ticked for her.** What this can do is make ticking
 * twenty rows and sending them one action instead of twenty rounds of
 * copy-paste, which is the actual cause of the backlog.
 *
 * ## The ticking is Appfolio's, and that is the point
 *
 * This used to inject a checkbox of its own onto every row. Appfolio's list
 * already has one — it drives their header select-all, their "N Selected"
 * counter and their Bulk Actions menu — so every row carried two boxes a
 * thumb's width apart, and ours sat at the bottom edge of the card where it
 * read as nearly belonging to the next work order. A manager cannot be expected
 * to know which of two identical controls means "sync" and which one is next to
 * "Cancel", so there is now only one, and it is hers.
 *
 * So the selection is not state here. It is read off the page at the moment it
 * is needed, and the only things this ever writes to it are completing a range
 * she started with shift, and clearing the rows it has just sent.
 *
 * Reading rather than mirroring is also the only version that works.
 * **Appfolio's select-all sets all fifty row boxes and fires no `change` on any
 * of them** — a mirrored Set fed by per-box listeners would sit there saying
 * "0 selected" with the whole page ticked. What select-all always updates is
 * the counter, so the counter is what is watched.
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
 *
 * ## Scope, which follows exactly that rule
 *
 * The web app is set to one population of work orders — Dustin's test ones, or
 * real ones — and it says which on the same answer the badges come from. The
 * bar states it permanently, and a row the scope does not admit is refused
 * here, on the row, rather than being sent and bounced.
 *
 * **With no scope in hand nothing can be sent at all.** Not knowing which
 * population this app is pointed at is not a reason to guess: the button says
 * "mode unknown" and is disabled, and the retry link that was already there for
 * the badges recovers both at once. The cost is a click; the alternative is a
 * real client's work order posted to a machine that only wanted tests, or the
 * reverse.
 */

(() => {
  const nss = globalThis.nss;

  const PANEL_ID = "nss-bar";
  const LIST_PATH = "/maintenance/service_requests/work_orders";

  const app = {
    /** number => the row, for the rows currently on screen. */
    rows: new Map(),

    /** The last row clicked, so shift-click has a range to work from. */
    anchor: null,

    settings: {},

    message: null,

    /** Set while a sync is in flight, so the bar cannot be double-fired. */
    busy: false,

    /**
     * Which work orders this web app may hold, as it last said.
     *
     * Null until the status lookup answers, and back to null the moment it
     * fails — never a remembered value, for the same reason the badges beside
     * it are never remembered. Sending the wrong population is not a mistake a
     * retry fixes, so with no scope in hand the bar refuses to send at all.
     */
    scope: null,

    /** Kept so a re-init cannot leave two observers counting the same page. */
    selection_observer: null,

    async init() {
      const list = await nss.query_element(nss.SELECTORS.list);
      if (!list) return;

      const state = await nss.ask("STATE");
      app.settings = state?.settings || {};

      app.render_rows();
      app.watch_selection(list);
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
    },

    /**
     * The badge strip under a row.
     *
     * The guard is on the badge's number rather than on the strip's existence,
     * because Appfolio reusing an `<li>` for a different work order would
     * otherwise leave a badge that is confidently about the wrong job — which
     * is the one thing a badge is not allowed to be.
     */
    decorate(row) {
      const existing = row.element.querySelector(".nss-row");

      if (existing) {
        const badge = existing.querySelector(".nss-badge");
        if (badge?.dataset.number === row.number) return;

        existing.remove();
      }

      const holder = document.createElement("div");
      holder.className = "nss-row";

      const badge = document.createElement("span");
      badge.className = "nss-badge nss-badge--loading";
      badge.dataset.number = row.number;
      badge.textContent = "checking…";

      holder.appendChild(badge);

      row.element.classList.add("nss-has-row");
      row.element.appendChild(holder);
    },

    /* ---- the selection, which belongs to Appfolio ------------------------- */

    /** Ticked rows, in page order — the order a manager reads them in. */
    selected_rows() {
      return [...app.rows.values()].filter((row) => row.box?.checked);
    },

    row_of(box) {
      for (const row of app.rows.values()) if (row.box === box) return row;

      return null;
    },

    /**
     * Tick or untick a row as Appfolio would have — by clicking it.
     *
     * This used to assign `checked` and dispatch a bubbling `change`, on the
     * reasoning that Appfolio keeps its own "N Selected" and its own Bulk
     * Actions state and a box changed behind its back leaves the page
     * disagreeing with itself. The reasoning was right and the method did not
     * work, which is worth writing down because it looks like it should.
     *
     * Measured against the live list on 15 September 2026, one row, fresh load:
     *
     *   a real click                       0 Selected -> 1 Selected
     *   checked = false + change event     1 Selected -> 1 Selected   (box unticked)
     *   native setter + change event       2 Selected -> 2 Selected   (box unticked)
     *   box.click()                        2 Selected -> 1 Selected
     *
     * So this is **not** the React value-tracker problem that
     * content/buildertrend_add_job.js had, and the native-setter fix that cured
     * that one does nothing here: Appfolio's counter is driven by a click
     * handler, not by a controlled input's value. Only a click event updates it.
     *
     * The cost is that every programmatic tick now dispatches a real click that
     * bubbles to our own listener too, which is why on_click() ignores anything
     * that is not `isTrusted`.
     *
     * What this was leaving behind: after every sync, the rows the extension
     * had just cleared stayed in Appfolio's count and in its Bulk Actions
     * selection — a menu whose items are Complete, Ready to Bill, Assign,
     * Cancel and Print.
     */
    set_checked(row, wanted) {
      if (!row?.box || row.box.checked === wanted) return;

      row.box.click();
    },

    watch_selection(list) {
      app.selection_observer?.disconnect();

      let pending = false;

      const recount = () => {
        if (pending) return;

        pending = true;

        setTimeout(() => {
          pending = false;
          app.render_bar();
        }, 0);
      };

      /* Bubble phase on purpose: Appfolio's own handler has run by then, so the
         box's `checked` is the value the manager just chose. */
      list.addEventListener("change", (event) => {
        if (event.target?.matches?.(nss.SELECTORS.row_select)) recount();
      });

      list.addEventListener("click", app.on_click);

      /* The one signal select-all leaves behind. There are two counter nodes —
         the same figure at two breakpoints — and watching both costs nothing. */
      app.selection_observer = new MutationObserver(recount);

      for (const counter of document.querySelectorAll(nss.SELECTORS.selected_count)) {
        app.selection_observer.observe(counter, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    },

    /**
     * Shift-click for a range, over Appfolio's boxes.
     *
     * Appfolio does not do this itself — clicking row 1 and shift-clicking row
     * 5 leaves two rows ticked, not five. It is the difference between
     * selecting eighteen of twenty rows in two clicks and in eighteen, and
     * eighteen clicks is the thing this extension exists to remove, so it is
     * worth putting back on top of their control.
     */
    on_click(event) {
      const box = event.target;
      if (!box?.matches?.(nss.SELECTORS.row_select)) return;

      /* set_checked() ticks by clicking now, so our own writes arrive here as
         well. Only a person starts a range or moves the anchor — an untrusted
         click has no shiftKey to read and no intent behind it, and letting one
         move `anchor` would leave the next shift-click measuring from a row
         nobody touched. */
      if (!event.isTrusted) return;

      const row = app.row_of(box);
      if (!row) return;

      if (event.shiftKey && app.anchor !== null && app.anchor !== row.number) {
        const numbers = [...app.rows.keys()];
        const from = numbers.indexOf(app.anchor);
        const to = numbers.indexOf(row.number);

        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const wanted = box.checked;

          for (let index = start; index <= end; index++) {
            app.set_checked(app.rows.get(numbers[index]), wanted);
          }
        }
      }

      app.anchor = row.number;
    },

    /* ---- badges ---------------------------------------------------------- */

    async load_statuses() {
      const numbers = [...app.rows.keys()];
      if (numbers.length === 0) return;

      app.paint_badges("checking…", "loading");

      const answer = await nss.ask("STATUSES", { numbers });

      app.scope = answer?.ok ? answer.scope || null : null;

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
          app.paint_badge(number, "not imported", "absent");

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

      const count = app.selected_rows().length;
      const bt = app.settings.buildertrend_enabled !== false;
      const mode = app.scope?.mode === "sample" || app.scope?.mode === "live" ? app.scope.mode : null;

      bar.innerHTML = "";

      const left = document.createElement("div");
      left.className = "nss-bar__left";

      /* With no control of our own on the row, the empty bar is the only thing
         that says this feature exists — so it names Appfolio's checkboxes
         rather than only counting rows. */
      const tally = document.createElement("span");
      tally.className = "nss-bar__count";
      tally.textContent =
        count === 0
          ? `${app.rows.size} work orders on this page — tick rows to sync`
          : `${count} selected`;

      left.appendChild(tally);

      /* Always shown, including when it is `live`. A mode indicator that only
         appears in the unusual case teaches nobody what the usual case is, and
         the question this answers — "is what I am about to send real?" — is
         worth a permanent answer rather than an occasional one. */
      const scope = document.createElement("span");
      scope.className = `nss-bar__scope nss-bar__scope--${mode || "unknown"}`;
      scope.textContent =
        mode === "sample"
          ? "sample mode — test work orders only"
          : mode === "live"
            ? "live — real work orders only"
            : "mode unknown";
      scope.title =
        mode === null
          ? "The web app has not said which work orders it may hold, so nothing can be sent."
          : `Only work orders whose description ${mode === "sample" ? "carries" : "does not carry"} `
            + `"${app.scope.marker || ""}" will be accepted.`;

      left.appendChild(scope);

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

      /* There used to be an "also queue for Buildertrend" checkbox here, and it
         was the wrong shape twice over: it made the second destination optional
         when a job has to exist in both, and its state lived only in the bar's
         dataset, so it reset on every re-render and every page change. A
         manager who ticked it, sorted the list, and pressed Sync got the web
         app and nothing else.

         Syncing now means both. This says so, rather than asking. */
      if (bt) {
        const also = document.createElement("span");
        also.className = "nss-bar__also";
        also.textContent = "and Buildertrend";
        right.appendChild(also);
      }

      const send = document.createElement("button");
      send.type = "button";
      send.className = "nss-bar__go";
      send.disabled = count === 0 || app.busy || mode === null;
      send.textContent = app.busy
        ? "Reading Appfolio…"
        : mode === null
          ? "Mode unknown — cannot sync"
          : count === 0
            ? "Sync"
            : `Sync ${count}`;

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

    /** One wording for the two places that report a scope refusal. */
    refusal_reason(count) {
      const rows = count === 1 ? "1 is" : `${count} are`;

      return app.scope?.mode === "sample"
        ? `${rows} not marked as a test work order, and sample mode is on.`
        : `${rows} a test work order, and this web app is set to real work only.`;
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
     *
     * **A row outside the web app's scope is skipped the same way**, and for
     * the same reason: it is better refused here, on the row, than accepted and
     * bounced. The check has to happen after the scrape rather than before,
     * because the description only exists on the work order's own page — the
     * list row does not carry it, and fetching fifty detail pages to paint
     * fifty badges nobody asked for would hammer the portal a manager is
     * working in. The server checks it again anyway.
     */
    async send() {
      const rows = app.selected_rows();
      if (app.busy || rows.length === 0) return;

      /* The bar already disables the button; this is the second answer to the
         same question, because the button's state is a render away from the
         truth and this is not. */
      if (app.scope === null) {
        app.say("The web app has not said which work orders it may hold. Retry status first.", "error");

        return;
      }

      app.busy = true;
      app.message = null;
      app.render_bar();

      const work_orders = [];
      const handed_over = [];
      const failed = [];
      const refused = [];

      for (const [index, row] of rows.entries()) {
        app.paint_badge(row.number, `reading ${index + 1} of ${rows.length}…`, "loading");

        try {
          const work_order = await nss.scrape_row(row);

          if (!nss.scope_admits(work_order.description, app.scope)) {
            refused.push(row.number);
            app.paint_badge(
              row.number,
              app.scope.mode === "sample" ? "not a test work order" : "test work order",
              "error",
              app.scope.mode === "sample"
                ? "Sample mode is on, so only work orders whose description carries the test marker are sent."
                : "This is a test work order, and this web app is set to real work only.",
            );

            continue;
          }

          work_orders.push(work_order);
          handed_over.push(row);
          app.paint_badge(row.number, "sending…", "loading");
        } catch (error) {
          failed.push(row.number);
          app.paint_badge(row.number, "could not read", "error", error?.message || "");
        }
      }

      if (work_orders.length === 0) {
        app.busy = false;
        app.say(
          refused.length === 0
            ? "Could not read any of the selected work orders from Appfolio."
            : `None of those can be sent: ${app.refusal_reason(refused.length)}`,
          "error",
        );

        return;
      }

      const result = await nss.ask("SYNC", { work_orders });

      /* Both destinations, every time. The web app first because it is the
         system of record and the fast, reliable half — if Buildertrend then
         fails, the gap is recorded rather than lost, and `buildertrend_url IS
         NULL` on the server is what names it.

         Not awaited: the run opens a tab and works through the queue one job at
         a time, which takes minutes for a full page of rows. Holding the bar
         busy for that would stop a manager doing anything else in Appfolio, and
         the queue is durable — a browser closed mid-run picks up where it left
         off. The notification at the end is the report. */
      if (app.settings.buildertrend_enabled !== false) {
        await nss.ask("QUEUE_FOR_BT", { work_orders });
        nss.ask("RUN_BT_QUEUE");
      }

      app.busy = false;

      /* Cleared only for the rows that were actually handed over. A row that
         could not be read stays ticked, because it still needs doing and
         un-ticking it would hide that. */
      for (const row of handed_over) app.set_checked(row, false);

      const sent = result?.queued ?? work_orders.length;
      const notes = [`${sent} sent to the web app.`];

      if (refused.length > 0) notes.push(app.refusal_reason(refused.length) + ` ${refused.join(", ")}.`);
      if (failed.length > 0) notes.push(`${failed.length} could not be read: ${failed.join(", ")}.`);

      notes.push(
        refused.length === 0 && failed.length === 0
          ? "Watch the toolbar icon for the result."
          : "Anything not sent is still selected.",
      );

      app.say(notes.join(" "), refused.length === 0 && failed.length === 0 ? "ok" : "warn");

      /* Re-read from the web app rather than assuming the send worked. The
         badges then show what the app actually holds, which is the same
         principle the sync ledger's reconcile step runs on. */
      setTimeout(() => app.load_statuses(), 1200);
    },

    /* ---- the page is a SPA ----------------------------------------------- */

    /**
     * Sorting, filtering and paging are full navigations here — the URL changes
     * and the document is replaced — so this runs almost never. It is kept
     * because it costs one observer and it is what would catch Appfolio moving
     * to in-place rendering without telling anybody.
     */
    watch_url() {
      let last = location.href;

      new MutationObserver(() => {
        if (location.href === last) return;
        if (!location.pathname.includes(LIST_PATH)) return;

        last = location.href;
        app.message = null;
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
