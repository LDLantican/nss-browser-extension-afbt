/**
 * The appfolio_vendor adapter's page half: a content script on
 * vendor.appfolio.com (roadmap phase 9; ADR-008).
 *
 * It answers one small command at a time from the service worker (adapter.js),
 * reached as `ASH_PAGE_COMMAND`, and keeps nothing between commands except the
 * photographs staged for the note being posted — which a reload throws away,
 * and the adapter stages again. Every command waits for the page to be ready
 * first (legacy's readiness gate): a React page that has not rendered yet is
 * not an empty one.
 *
 * Exactly four commands press something AppFolio keeps — accept, save_note,
 * submit_invoice and work_done — and each presses once and answers at once.
 * The adapter sends them with `once`, after the web app's commit, and never
 * asks again. Everything else only reads, or types into a form nobody has
 * saved.
 *
 * It also tells the worker, whenever a vendor page has loaded, that this
 * browser is signed in to the portal (`ASH_VENDOR_SEEN`), which is what lets a
 * person's own browsing keep the session fresh without a probe tab.
 *
 * The same script runs on the pretend portal packaged in the extension
 * (site/), where it is told apart by its `?frame=` and reads its route from
 * the hash — an extension page cannot have AppFolio's paths.
 */

(() => {
  const S = globalThis.ash_vendor?.SELECTORS;
  const T = globalThis.ash_vendor?.TEXT;

  if (!S || !T || globalThis.ash_vendor.page_started) return;

  globalThis.ash_vendor.page_started = true;

  const READY_MS = 15000;
  const TAB_MS = 10000;
  const ATTACH_MS = 8000;
  const DIALOG_MS = 10000;

  const fixture = location.protocol === "chrome-extension:";
  const frame = fixture ? new URLSearchParams(location.search).get("frame") : null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const refuse = (message, error_class = "adapter_broken") => Object.assign(new Error(message), { error_class });

  const app = {
    staged: [],

    init() {
      chrome.runtime.onMessage.addListener(app.on_message);
      if (!fixture) app.announce();
    },

    on_message(message, sender, respond) {
      if (message?.type !== "ASH_PAGE_COMMAND") return false;
      if (sender?.id !== chrome.runtime.id) return false;
      if (fixture && (message.frame ?? null) !== frame) return false;

      app
        .handle(message.command, message.args || {})
        .then((result) => respond({ ok: true, result }))
        .catch((error) => respond({ ok: false, error: error?.message || String(error), error_class: error?.error_class || "adapter_broken" }));

      return true;
    },

    async handle(command, args) {
      if (command === "probe") return app.probe();

      await app.ready();

      switch (command) {
        case "state":
          return app.state();
        case "find_in_list":
          return app.find_in_list(args);
        case "accept":
          return app.press(app.accept_button(), "Accept");
        case "notes":
          return app.notes(args);
        case "stage_photo":
          return app.stage_photo(args);
        case "attach_staged":
          return app.attach_staged();
        case "fill_note":
          return app.fill_note(args);
        case "save_note":
          return app.press(document.querySelector(S.note_save), "Save Note");
        case "invoice_state":
          return app.invoice_state();
        case "fill_invoice":
          return app.fill_invoice(args);
        case "read_total":
          return app.read_total();
        case "submit_invoice":
          return app.press(app.toolbar(T.submit_invoice), "Submit Invoice");
        case "work_done":
          return app.work_done();
        default:
          throw refuse(`Unknown command: ${command}`);
      }
    },

    /** The route: AppFolio's path, or the fixture's hash. */
    route() {
      return fixture ? location.hash.replace(/^#/, "") || "/" : location.pathname;
    },

    kind() {
      const route = app.route();

      if (/\/workOrders\/\d+\/invoices/.test(route)) return "invoices";
      if (/\/workOrders\/\d+\/notes/.test(route)) return "notes";
      if (/\/workOrders\/\d+/.test(route)) return "work_order";
      if (/^\/?$/.test(route)) return "list";

      return "other";
    },

    signed_out() {
      const password = document.querySelector(S.password);

      return Boolean(password && password.offsetParent !== null) || (T.signed_out_title.test(document.title) && !document.querySelector(S.portal));
    },

    loading() {
      return document.querySelector(S.loading) !== null;
    },

    /** Is the page this route promises actually on screen? */
    rendered() {
      if (app.loading()) return false;

      switch (app.kind()) {
        case "list":
          return document.querySelector(S.list) !== null;
        case "work_order":
          return app.text(S.number) !== "";
        case "notes":
          return app.text(S.number) !== "" && document.querySelector(S.note_field) !== null;
        case "invoices":
          return app.text(S.number) !== "" && document.querySelector(S.invoices_page) !== null;
        default:
          return document.querySelector(S.portal) !== null;
      }
    },

    async ready() {
      const until = Date.now() + READY_MS;

      while (!app.rendered()) {
        if (app.signed_out()) return;
        if (Date.now() > until) throw refuse(`The ${app.kind()} page did not finish loading.`, "transient");

        await sleep(200);
      }
    },

    /** "19576 - 1 | Camelot Properties, LLC" → "19576-1". */
    normalize_number(text) {
      const match = T.number.exec(String(text || ""));

      return match ? `${match[1]}-${match[2]}` : "";
    },

    /** The vendor account every work-order URL starts with: this page's, or the list's first row's. */
    account() {
      return T.path.exec(app.route())?.[2] || T.path.exec(app.rows()[0]?.getAttribute("href") || "")?.[2] || null;
    },

    state() {
      if (app.signed_out()) return { signed_in: false, kind: app.kind() };

      const route = T.path.exec(app.route());

      return {
        signed_in: true,
        kind: app.kind(),
        path: route ? route[1] : null,
        account: app.account(),
        id: route ? route[3] : null,
        number: app.normalize_number(app.text(S.number)),
        status: app.text(S.status),
        description: app.description(),
        limit_cents: app.limit_cents(),
      };
    },

    /** The work order's description, wherever this page shows it; null if nowhere. */
    description() {
      const detail = document.querySelector(S.detail_description);

      if (detail) return detail.textContent.trim();

      for (const pair of document.querySelectorAll(S.datapair)) {
        const label = pair.querySelector(S.datapair_label);

        if (label && T.description_label.test(label.textContent.trim()))
          return pair.textContent.replace(label.textContent, "").trim();
      }

      return null;
    },

    /** The property's maintenance limit in cents; null when there is none, or none shown. */
    limit_cents() {
      const alert = document.querySelector(S.limit_alert);
      const alert_match = alert ? T.limit.exec(alert.textContent) : null;

      if (alert_match) return app.cents(alert_match[1]);

      const pair = document.querySelector(S.maintenance_limit);
      const pair_match = pair ? T.money.exec(pair.textContent) : null;

      return pair_match ? app.cents(pair_match[1]) : null;
    },

    // -- The list -------------------------------------------------------------

    rows() {
      return [...document.querySelectorAll(S.list_row)];
    },

    /** Which rows the list shows, so a tab switch is seen landing (the skeleton lies). */
    identity() {
      const rows = app.rows();

      return `${rows.length}|${rows[0]?.getAttribute("href") || ""}|${rows[rows.length - 1]?.getAttribute("href") || ""}`;
    },

    active_tab() {
      for (const [name, selector] of Object.entries(S.tabs))
        if (document.querySelector(selector)?.classList.contains("active")) return name;

      return null;
    },

    async show_tab(name) {
      if (app.active_tab() === name && document.querySelector(S.list)) return true;

      const link = document.querySelector(S.tabs[name]);

      if (!link) return false;

      const before = app.identity();

      link.click();

      const until = Date.now() + TAB_MS;

      while (Date.now() < until) {
        await sleep(200);

        if (app.active_tab() !== name || app.loading() || !document.querySelector(S.list)) continue;

        /* A tab with no rows is landed once the empty list has rendered. */
        if (app.identity() !== before || app.rows().length === 0) return true;
      }

      return app.active_tab() === name && document.querySelector(S.list) !== null;
    },

    /**
     * Find a work order on the list by its number. The URL id is not the
     * number (#18779 - 2 lives at /workOrders/19369), so the list is the only
     * way from one to the other. The active tab first, then the rest.
     */
    async find_in_list({ number }) {
      if (app.kind() !== "list") throw refuse("Not on the work-order list.");

      const wanted = String(number || "");
      const order = [app.active_tab(), "in_progress", "completed", "estimates"].filter((name, i, all) => name && all.indexOf(name) === i);
      const looked = [];

      for (const name of order) {
        if (!(await app.show_tab(name))) continue;

        looked.push(name);

        for (const row of app.rows()) {
          if (app.normalize_number(row.querySelector(S.row_title)?.textContent) !== wanted) continue;

          const path = T.path.exec(row.getAttribute("href") || "");

          return { path: path ? path[1] : null, tab: name, status: row.querySelector(S.row_status)?.textContent.trim() || "" };
        }
      }

      return { path: null, looked };
    },

    // -- Accept ---------------------------------------------------------------

    accept_button() {
      const box = document.querySelector(S.pending_actions);

      return [...(box || document).querySelectorAll(S.accept_button)].find((button) => T.accept_button.test(button.textContent.trim())) || null;
    },

    // -- Notes ----------------------------------------------------------------

    /** The notes posted so far, and whether one says exactly `text`. */
    notes({ text = null } = {}) {
      const list = document.querySelector(S.notes_list);

      if (!list) throw refuse("This is not a work order's notes page.");

      /* A saved note's body is AppFolio's header — "Note for Work Order #…",
         "Posted by: …" — then what was typed. Ours is the one with a line
         that says exactly the payload's text (read on the live portal,
         2026-10-16, after a whole-body comparison missed it). */
      const wanted = app.squash(text);
      const notes = [...list.querySelectorAll(S.note)].map((note) => ({
        lines: String(note.querySelector(S.note_body)?.textContent || "").split(/\n+/).map(app.squash),
        images: note.querySelectorAll(S.note_image).length,
      }));
      const match = wanted === "" ? null : notes.find((note) => note.lines.includes(wanted)) || null;

      /* "No Notes" is the list saying so; an empty list without it has not
         rendered yet, and is not evidence of anything. */
      const settled = notes.length > 0 || T.no_notes.test(list.textContent.trim());

      return { count: notes.length, settled, match: match ? { images: match.images } : null };
    },

    stage_photo({ name, mime_type, b64 }) {
      const binary = atob(String(b64 || ""));
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      app.staged.push(new File([bytes], String(name || "photo.jpg"), { type: String(mime_type || "image/jpeg") }));

      return { staged: app.staged.length };
    },

    /**
     * Put every staged photograph into the note's file input, and wait for the
     * page to say it has them all ("3/10 images selected"). A note is never
     * saved short: that is how four invoices went out with bare notes.
     */
    async attach_staged() {
      const input = document.querySelector(S.file_input);

      if (!input) throw refuse("The note form has no file input.");

      const wanted = app.staged.length;
      const transfer = new DataTransfer();

      for (const file of app.staged) transfer.items.add(file);

      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      app.staged = [];

      const until = Date.now() + ATTACH_MS;

      while (Date.now() < until) {
        if (app.attached() === wanted) return { attached: wanted };

        await sleep(200);
      }

      return { attached: app.attached() };
    },

    attached() {
      const counter = T.selected.exec(document.body.innerText);

      return counter ? Number(counter[1]) : document.querySelectorAll(S.selected_photo).length;
    },

    fill_note({ text }) {
      const field = document.querySelector(S.note_field);

      if (!field) throw refuse("The note form has no text box.");

      app.type(field, text);

      return { text: field.value };
    },

    // -- Invoices -------------------------------------------------------------

    invoice_state() {
      const page = document.querySelector(S.invoices_page);

      if (!page) throw refuse("This is not a work order's invoices page.");

      const bills = [...page.querySelectorAll(S.invoice_file)].map((link) => {
        const text = link.textContent.trim();

        return { file: text, number: T.billable.exec(text)?.[1] || null };
      });
      /* Absent only when the page says so in words. A list with no file links
         and no such sentence is a page that has not finished, or has changed,
         and an inference about what is absent is not an observation. */
      const none = T.no_invoice.test(page.textContent);

      return {
        invoiced: bills.length > 0,
        none: bills.length === 0 && none,
        bills,
        limit_cents: app.limit_cents(),
        form_open: document.querySelector(S.line_description) !== null,
      };
    },

    async open_form() {
      if (document.querySelector(S.line_description)) return;

      app.press(document.querySelector(S.create_invoice), "Create Invoice");

      const until = Date.now() + READY_MS;

      while (!document.querySelector(S.line_description)) {
        if (Date.now() > until) throw refuse("Create Invoice did not open the form.", "transient");

        await sleep(200);
      }
    },

    /** Each invoice line's whole row — the one that also holds its Delete button. */
    line_rows() {
      return [...document.querySelectorAll(S.line_description)].map((description) => description.closest(S.line_row)).filter(Boolean);
    },

    add_line_button() {
      return [...document.querySelectorAll("button")].find((button) => T.add_line.test(button.textContent.trim())) || null;
    },

    /**
     * Type the invoice the web app projected, line for line: exactly as many
     * rows as items, each written through the native setter so React sees it.
     * Nothing is computed; the adapter checks the page's arithmetic after.
     */
    async fill_invoice({ items = [] }) {
      await app.open_form();

      while (app.line_rows().length < items.length) {
        const count = app.line_rows().length;

        app.press(app.add_line_button(), "Add Line Item");
        await app.until(() => app.line_rows().length > count, "Add Line Item did not add a row.");
      }

      while (app.line_rows().length > items.length && items.length > 0) {
        const rows = app.line_rows();
        const count = rows.length;

        app.press(rows[count - 1].querySelector(S.line_delete), "Delete");
        await app.until(() => app.line_rows().length < count, "Delete did not remove a row.");
      }

      app.line_rows().forEach((row, i) => {
        app.type(row.querySelector(S.line_description), items[i].description);
        app.type(row.querySelector(S.line_quantity), items[i].quantity);
        app.type(row.querySelector(S.line_rate), items[i].rate);
      });

      await sleep(300);

      return { lines: app.line_rows().length };
    },

    /** The page's own arithmetic: each line's Amount and the Total, in cents. */
    read_total() {
      const label = [...document.querySelectorAll(S.total_label)].find((div) => T.total.test(div.textContent.trim()));
      const total = label?.parentElement?.querySelector(S.total_input);

      return {
        total_cents: total ? app.cents(total.value) : null,
        amounts: app.line_rows().map((row) => app.cents(row.querySelector(S.line_amount)?.value)),
        rates: app.line_rows().map((row) => row.querySelector(S.line_rate)?.value ?? null),
      };
    },

    toolbar(pattern) {
      return [...document.querySelectorAll(S.toolbar_button)].find((button) => pattern.test(button.textContent.trim())) || null;
    },

    // -- Work Done ------------------------------------------------------------

    /**
     * Work Done is two presses — the button, then Yes on "Submit this Work
     * Order as Done?" — and both are this one command, sent once. A dialog
     * that never comes is an error after the first press, which the adapter
     * reports as unknown; a verification reads the status.
     */
    async work_done() {
      app.press(document.querySelector(S.done_button), "Work Done");

      const yes = await app.until(() => {
        const dialog = [...document.querySelectorAll(S.dialog)].find((d) => T.done_dialog.test(d.textContent));

        return dialog?.querySelector(S.dialog_yes) || null;
      }, "The Work Done dialog did not open.", DIALOG_MS);

      yes.click();

      return { clicked: true };
    },

    // -- The probe ------------------------------------------------------------

    /** Read-only: which hooks this page has. Clicks nothing, waits for nothing. */
    probe() {
      const expected = {
        list: ["portal", "list", "list_row", "row_title", "row_status"],
        work_order: ["portal", "number", "status", "datapair", "done_button"],
        notes: ["portal", "number", "status", "notes_page", "note_field", "file_input", "note_save", "notes_list"],
        invoices: ["portal", "number", "status", "invoices_page", "create_invoice"],
      }[app.kind()] || ["portal"];
      const found = [];
      const missing = [];

      for (const name of expected) (document.querySelector(S[name]) ? found : missing).push(name);

      if (app.kind() === "list")
        for (const [name, selector] of Object.entries(S.tabs)) (document.querySelector(selector) ? found : missing).push(`tab:${name}`);

      return { kind: app.kind(), signed_in: !app.signed_out(), loading: app.loading(), found, missing };
    },

    // -- Small things ---------------------------------------------------------

    /** Say once, after the page has rendered, that this browser is signed in here. */
    async announce() {
      const until = Date.now() + READY_MS;

      while (Date.now() < until) {
        if (app.signed_out()) return app.tell("expired");
        if (document.querySelector(S.portal) && !app.loading()) return app.tell("live");

        await sleep(500);
      }

      return undefined;
    },

    tell(state) {
      chrome.runtime.sendMessage({ type: "ASH_VENDOR_SEEN", payload: { state, account: app.account() } }).catch(() => null);
    },

    press(button, what) {
      if (!button) throw refuse(`There is no ${what} button to press.`);
      if (button.disabled) throw refuse(`The ${what} button is disabled.`, "permanent");

      button.click();

      return { clicked: true };
    },

    async until(look, message, timeout = READY_MS) {
      const until = Date.now() + timeout;

      for (;;) {
        const seen = look();

        if (seen) return seen;
        if (Date.now() > until) throw refuse(message, "transient");

        await sleep(150);
      }
    },

    /** Write a value the way React will notice: the native setter, then input and change. */
    type(input, value) {
      if (!input) throw refuse("A form field is missing.");

      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;

      if (setter) setter.call(input, String(value ?? ""));
      else input.value = String(value ?? "");

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },

    text(selector) {
      return document.querySelector(selector)?.textContent.trim() || "";
    },

    /** Whitespace and case folded, so a note is matched by what it says. */
    squash(text) {
      return String(text ?? "").replace(/[ ​]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    },

    /** "1,234.56" or "$30.85" as cents; null if it is not an amount. */
    cents(text) {
      const match = /^(-?)(\d+)\.(\d{2})$/.exec(String(text ?? "").replace(/[$,\s]/g, ""));

      if (!match) return null;

      const cents = Number(match[2]) * 100 + Number(match[3]);

      return match[1] === "-" ? -cents : cents;
    },
  };

  if (document.readyState === "complete") app.init();
  else window.addEventListener("load", () => app.init(), { once: true });
})();
