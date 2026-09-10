/**
 * The AppFolio vendor portal, as a set of small commands.
 *
 * The web app decides what is billed and what the figures are. This script
 * types them, reads back what AppFolio computed, and reports. It does no
 * arithmetic of its own beyond parsing a figure off the page to compare.
 *
 * ## Why this is commands and not one long procedure
 *
 * Notes and invoices are separate routes — `/workOrders/{id}/notes` and
 * `/workOrders/{id}/invoices` — so a delivery spans several page loads. An
 * earlier version assumed one page and held a promise across the whole job,
 * which cannot survive the navigation that re-injects this file.
 *
 * So background/delivery.js owns the sequence and the state, and every handler
 * here answers one question about the page it is on, idempotently. Each is
 * separately testable, and a failure between two of them is a clean boundary
 * rather than a half-filled form.
 *
 * ## Selectors: AppFolio's own `js-*` classes
 *
 * There is no `data-testid` anywhere in the portal, but there are `js-*`
 * classes throughout and they are semantic — `.js-description-field`,
 * `.js-note-field`, `.js-notes-form-save`, `.js-done-button`. Those are the
 * hooks. Text matching is used only for the three controls that have none
 * (Accept, Decline, Add Line Item), and the hashed CSS-module classes
 * (`__Gv96I`, `__exU4x`) are never a primary selector because their suffix
 * changes on every AppFolio deploy.
 *
 * Two asymmetries in that map are the easiest things to get wrong, so they are
 * spelt out in SELECTORS: the class is on the *input* for Description and
 * Quantity, and on the *wrapper* for Rate and Amount.
 *
 * ## It fails closed
 *
 * Anything not found stops the job with a specific message. Nothing is
 * submitted whose total does not reconcile to the cent, and nothing that has
 * already been invoiced is invoiced again. A job stuck in the queue costs a
 * conversation; a wrong invoice reaching the client costs a client.
 *
 * ## React
 *
 * This is a Next.js SPA with no `<form>` on the invoice and `type="button"` on
 * its submit, so every action is a dispatched click and every value goes
 * through the native setter (see set_value). Assigning `.value` directly is
 * invisible to React's value tracker, which then reverts the field on its next
 * render — the bug documented as deliberately unfixed in
 * content/buildertrend_add_job.js. It must not be repeated here.
 */

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    /**
     * Every hook this script uses.
     *
     * The one place to correct if AppFolio's markup moves. Grouped by the page
     * each belongs to, because the handlers below are grouped the same way.
     */
    SELECTORS: {
      /* the list at / */
      list: ".js-work-orders",
      list_row: ".js-work-orders a[href*='/workOrders/']",
      /* NOT unique to a list row — the same class heads "Submitted Invoices",
         "Job Details" and "Submit New Invoice". It is only ever queried inside
         one row's <a>, never against the document. */
      list_row_number: "h2.card-title",
      tab_in_progress: ".js-nav-in-progress a",
      tab_estimates: ".js-nav-estimated a",
      tab_completed: ".js-nav-completed a",

      /* a work order */
      number: "span.js-work-order-number-display",
      status: "span.js-work-order-status",
      maintenance_limit: ".js-maintenance-limit",
      datapair: ".js-datapair",
      work_done: "button.js-done-button",
      notes_button: "button.js-notes-button",
      invoices_button: ".js-invoices-button",

      /* Accept and Decline are the only controls on the site with no js- hook,
         so they are found by a prefix match on the container plus the Bootstrap
         variant, and confirmed by their text. */
      pending_actions: "[class*='work-order-pending-actions']",

      /* the notes page */
      note_field: "textarea.js-note-field",
      note_dropzone: "#react-dropzone",
      note_file_input: "#react-dropzone input[name='file-input-field']",
      note_save: "button.js-notes-form-save",
      notes_list: "div.js-notes-list",

      /* the invoices page */
      create_invoice: "button.js-create-invoice-btn",
      description: "input.js-description-field",
      quantity: "input.js-quantity-field",

      /* class on the wrapper, not the input — the asymmetry above */
      rate: ".js-rate-field input",
      amount: ".js-amount-field input",

      submit_toolbar: "div[role='toolbar'] button.btn-primary",
    },

    /** AppFolio's own limit on one note. */
    PHOTOS_PER_NOTE: 10,

    /** How long a control may take to appear after a click. */
    WAIT_MS: 15000,

    init() {
      /* Remembered whenever a person is on a vendor work order, because that is
         the only moment the web app can learn this page's address — the
         displayed number cannot be turned into a URL. Fire and forget. */
      const number = app.page_number();

      if (number !== "" && /\/workOrders\/\d+/.test(location.pathname))
        chrome.runtime.sendMessage({
          type: "VENDOR_PAGE_SEEN",
          payload: { number, url: app.work_order_url() },
        });

      chrome.runtime.onMessage.addListener(app.handle_message);
    },

    /**
     * Every branch returns true.
     *
     * Even the synchronous ones. Returning false closes the message channel,
     * and the earlier version's probe did exactly that — which is why its
     * report arrived empty and looked like a page with no controls on it.
     * content/buildertrend_add_job.js has always returned true here.
     */
    handle_message(message, _sender, respond) {
      const handlers = {
        VENDOR_PAGE_STATUS: () => ({ state: app.read_state() }),
        VENDOR_PAGE_PROBE: () => app.probe(),
        VENDOR_INSPECT: () => app.inspect(message.payload || {}),
        VENDOR_ACCEPT: () => app.accept(),
        VENDOR_POST_NOTE: () => app.post_note(message.payload || {}),
        VENDOR_SUBMIT_INVOICE: () => app.submit_invoice(message.payload || {}),
        VENDOR_WORK_DONE: () => app.work_done(),
      };

      const handler = handlers[message?.type];

      if (!handler) return false;

      Promise.resolve()
        .then(handler)
        .then((result) => respond(result))
        .catch((error) =>
          respond({ ok: false, error: error?.message || "That page could not be read." }),
        );

      return true;
    },

    /* ---- the commands --------------------------------------------------- */

    /**
     * What this page has, touching nothing.
     *
     * Safe against a live client's work order, which is the point: ASH has no
     * AppFolio sandbox, so the alternative to a passive check is finding out by
     * submitting something. It reports per hook rather than per label now, so
     * the answer names the thing to fix.
     */
    probe() {
      const found = {};

      for (const [key, selector] of Object.entries(app.SELECTORS))
        found[key] = document.querySelectorAll(selector).length;

      const page = app.page_kind();

      /* Which hooks *should* be here. Without this the report is 25 counts and
         mostly zeroes, because every page holds a quarter of the map — and a
         reader cannot tell an expected zero from a broken selector. */
      const expected = {
        list: ["list", "list_row", "tab_in_progress"],
        work_order: ["number", "status", "work_done", "notes_button", "invoices_button", "datapair"],
        notes: ["note_field", "note_dropzone", "note_file_input", "note_save", "notes_list"],
        invoices: found.description > 0
          ? ["number", "description", "quantity", "rate", "amount", "submit_toolbar"]
          : ["number", "create_invoice"],
      }[page] || [];

      return {
        ok: true,
        state: app.read_state(),
        url: location.href,
        page,
        number: app.page_number(),
        status: app.text(app.SELECTORS.status),
        maintenance_limit_cents: app.maintenance_limit_cents(),
        already_invoiced: app.already_invoiced(),
        expected,
        missing: expected.filter((key) => found[key] === 0),
        found,
        hint:
          page === "invoices" && found.description === 0
            ? "This is the invoices page before the form opens. Click Create Invoice, then check again."
            : page === "unknown"
              ? "This does not look like a work order, a notes page, an invoices page or the list."
              : "",
      };
    },

    /**
     * Which work order this is, and anything that should stop it.
     *
     * On the list it resolves a number to its href instead, which is the only
     * way to get from `#19207 - 1` to `/2433121/workOrders/19633` — the two ids
     * are unrelated.
     */
    inspect(job) {
      if (app.read_state() === "signed_out") return { ok: false, signed_out: true };

      if (app.page_kind() === "list") {
        const href = app.find_in_list(job.number || "");

        return {
          ok: href !== null,
          page: "list",
          href,
          error: href === null
            ? `Work order ${job.number} is not in the portal list. It may be on another tab, or not assigned yet.`
            : "",
        };
      }

      return {
        ok: true,
        page: app.page_kind(),
        number: app.page_number(),
        url: app.work_order_url(),
        status: app.text(app.SELECTORS.status),
        needs_accepting: /accept/i.test(app.text(app.SELECTORS.status)),
        maintenance_limit_cents: app.maintenance_limit_cents(),
      };
    },

    /**
     * Accept the work order.
     *
     * Only ever called for a job the web app has already approved, so the work
     * demonstrably happened and accepting commits ASH to nothing new. These are
     * the weakest selectors on the site — no js- hook at all — so the text is
     * confirmed as well as the container and the variant.
     */
    async accept() {
      const container = document.querySelector(app.SELECTORS.pending_actions);

      if (container === null)
        return { ok: false, error: "This work order has no Accept button; it may already be accepted." };

      const button = [...container.querySelectorAll("button.btn-success")].find(
        (candidate) => app.clean(candidate.textContent) === "accept",
      );

      if (!button) return { ok: false, error: "Could not find the Accept button." };

      button.click();

      /* Confirmed by the status badge changing, not by the click returning. */
      const moved = await app.wait_for(() =>
        /accept/i.test(app.text(app.SELECTORS.status)) ? null : true,
      );

      return moved === null
        ? { ok: false, error: "Accept was pressed but the work order still needs accepting." }
        : { ok: true, status: app.text(app.SELECTORS.status) };
    },

    /**
     * One note, with up to ten photographs.
     *
     * The dropzone is react-dropzone, so the reliable path is its own hidden
     * input plus a change event; a synthetic drop is the fallback for a build
     * that stops rendering the input.
     */
    async post_note(payload) {
      const field = document.querySelector(app.SELECTORS.note_field);

      if (field === null)
        return { ok: false, error: "Could not find the note box on the notes page." };

      app.set_value(field, payload.message || "");

      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      const files = [];

      for (const photo of photos.slice(0, app.PHOTOS_PER_NOTE)) {
        const file = await app.fetch_photo(photo);

        /* A photograph that will not download is not a reason to abandon a
           correct invoice. The rest go on, and the count comes back so the
           caller can say so. */
        if (file !== null) files.push(file);
      }

      if (files.length > 0) {
        const attached = app.attach(files);

        if (!attached) return { ok: false, error: "Could not attach photos to the note." };
      }

      const save = document.querySelector(app.SELECTORS.note_save);

      if (save === null) return { ok: false, error: "Could not find the Save Note button." };

      save.click();

      /* The empty-state text disappearing is the save landing. Waiting on the
         textarea clearing would also work and is less specific. */
      const saved = await app.wait_for(() => {
        const list = document.querySelector(app.SELECTORS.notes_list);

        if (list === null) return null;

        return /no notes/i.test(list.textContent || "") ? null : true;
      });

      return saved === null
        ? { ok: false, error: "Save Note was pressed but the note did not appear." }
        : { ok: true, photos_attached: files.length, photos_offered: photos.length };
    },

    /**
     * The invoice: refuse, fill, verify, then submit.
     *
     * Four ways this returns without submitting, and each is a refusal rather
     * than a failure — nothing was sent, and retrying would not help:
     * AppFolio already holds an invoice, the property's maintenance limit is
     * smaller than the bill, the fields are missing, or the total does not
     * reconcile.
     */
    async submit_invoice(job) {
      const items = job?.items || [];

      if (items.length === 0) return { ok: false, error: "No invoice items were sent." };

      /* AppFolio's own answer to "have I billed this already?", and a better
         guard than anything the web app can hold: it survives a database
         restore and it is true even if somebody invoiced by hand. */
      if (app.already_invoiced())
        return {
          ok: false,
          blocked: true,
          error: "AppFolio already holds an invoice for this work order, so nothing was submitted.",
        };

      const limit = app.maintenance_limit_cents();
      const expected = Number(job.expected_total_cents || 0);

      if (limit !== null && expected > limit && job.on_over_limit !== "send")
        return {
          ok: false,
          blocked: true,
          error:
            `This invoice is ${app.dollars(expected)} and the property's maintenance limit is `
            + `${app.dollars(limit)}. Nothing was submitted.`,
        };

      /* Step 1 of the page offers a PDF upload OR Create Invoice; the form only
         mounts after the second. Skipped when the form is already open, so this
         handler can be re-sent safely. */
      if (document.querySelector(app.SELECTORS.description) === null) {
        const create = document.querySelector(app.SELECTORS.create_invoice);

        if (create === null)
          return { ok: false, error: "Could not find the Create Invoice button." };

        create.click();

        const mounted = await app.wait_for(() => document.querySelector(app.SELECTORS.description));

        if (mounted === null) return { ok: false, error: "The invoice form did not appear." };
      }

      const added = await app.ensure_rows(items.length);

      if (added !== true) return { ok: false, error: added };

      const rows = app.rows();

      for (const [index, item] of items.entries()) {
        const row = rows[index];

        app.set_value(row.description, String(item.description || "").slice(0, 255));
        app.set_value(row.quantity, String(item.quantity || ""));
        app.set_value(row.rate, String(item.rate || ""));
      }

      /* Read back from the page, never from what was typed. That is the whole
         point: a field React reverted looks filled and is not. */
      const total = await app.wait_for(() => {
        const read = app.invoice_total_cents();

        return read === expected ? read : null;
      });

      if (total === null) {
        const shown = app.invoice_total_cents();

        return {
          ok: false,
          error:
            shown === null
              ? `Could not read the invoice total back off the page. It should be ${app.dollars(expected)}.`
              : `AppFolio totalled this at ${app.dollars(shown)} and it should be `
                + `${app.dollars(expected)}. Nothing was submitted.`,
          read_back: shown === null ? "" : app.dollars(shown),
        };
      }

      /* Per line as well as in total, so two lines that are wrong by equal and
         opposite amounts cannot pass. */
      const line_error = app.check_lines(items);

      if (line_error !== null) return { ok: false, error: line_error };

      if (job.dry_run === true)
        return {
          ok: true,
          dry_run: true,
          read_back: app.dollars(total),
          expected: app.dollars(expected),
        };

      const submit = app.find_submit();

      if (submit === null) return { ok: false, error: "Could not find the Submit Invoice button." };

      if (job.auto_submit === false)
        return {
          ok: false,
          error:
            "Filled in and checked, but automatic submitting is switched off. "
            + "Press Submit Invoice on the vendor page.",
          read_back: app.dollars(total),
        };

      /* The point of no return. The worker records it before the click, so a
         browser that dies now leaves a row saying "may already be billed"
         rather than one that gets retried into a second invoice. */
      const permitted = await app.ask_to_submit(job.delivery_id);

      if (permitted !== true)
        return { ok: false, error: permitted || "The web app did not confirm it was safe to submit." };

      submit.click();

      /* Everything past the click reports `unconfirmed` on doubt, never
         `failed`. Save has been pressed and nobody on this side can know
         whether it took. */
      const done = await app.wait_for(() =>
        app.already_invoiced() || document.querySelector(app.SELECTORS.description) === null
          ? true
          : null,
      );

      if (done === null)
        return {
          ok: false,
          unconfirmed: true,
          error: "Submit Invoice was pressed and the page did not change. Check AppFolio before retrying.",
        };

      return { ok: true, external_ref: app.invoice_reference() };
    },

    /**
     * Move the job to Work Done.
     *
     * Scoped by class rather than text: the status dropdown carries a menu item
     * with the same words, and clicking that one opens a menu instead.
     */
    work_done() {
      const button = document.querySelector(app.SELECTORS.work_done);

      if (button === null) return { ok: false, error: "Could not find the Work Done button." };

      button.click();

      return { ok: true };
    },

    /* ---- reading the page ----------------------------------------------- */

    page_kind() {
      if (/\/workOrders\/\d+\/invoices/.test(location.pathname)) return "invoices";
      if (/\/workOrders\/\d+\/notes/.test(location.pathname)) return "notes";
      if (/\/workOrders\/\d+/.test(location.pathname)) return "work_order";
      if (document.querySelector(app.SELECTORS.list) !== null) return "list";

      return "unknown";
    },

    read_state() {
      if (document.querySelector("input[type='password']")) return "signed_out";
      if (/sign in|log in/i.test(document.title || "")) return "signed_out";

      return "ready";
    },

    /**
     * The work-order number, normalised.
     *
     * The portal renders `19327 - 1 | Camelot Properties, LLC` on a work order
     * and `#19207 - 1, Camelot Properties, LLC` on a list card — spaces around
     * the hyphen, and a `#` on one of them. The web app holds `19327-1`. An
     * earlier version matched `\b\d+-\d+\b`, which matches neither, so its
     * wrong-page guard found nothing and skipped itself.
     */
    page_number() {
      const source = app.text(app.SELECTORS.number) || document.title || "";
      const match = source.match(/(\d+)\s*-\s*(\d+)/);

      return match ? `${match[1]}-${match[2]}` : "";
    },

    /** The work order's own URL, without /notes or /invoices on the end. */
    work_order_url() {
      const match = location.pathname.match(/^(\/[^/]+\/workOrders\/\d+)/);

      return match ? `${location.origin}${match[1]}` : location.href;
    },

    /** A number's row in the list, as an absolute URL. */
    find_in_list(number) {
      const wanted = app.normalize_number(number);

      if (wanted === "") return null;

      for (const row of document.querySelectorAll(app.SELECTORS.list_row)) {
        const label = row.querySelector(app.SELECTORS.list_row_number);

        if (label === null) continue;
        if (app.normalize_number(label.textContent) !== wanted) continue;

        const href = row.getAttribute("href") || "";

        return href === "" ? null : new URL(href, location.origin).href;
      }

      return null;
    },

    /** `#19207 - 1, Camelot Properties, LLC` and `19207-1` to the same thing. */
    normalize_number(text) {
      const match = String(text || "").match(/(\d+)\s*-\s*(\d+)/);

      return match ? `${match[1]}-${match[2]}` : "";
    },

    /**
     * The property's maintenance limit in cents, or null when there is none.
     *
     * Read from the hook first and from the banner second, because the banner
     * is the thing a person sees and the hook is the thing that might move.
     */
    maintenance_limit_cents() {
      const hook = app.text(app.SELECTORS.maintenance_limit);
      const direct = app.to_cents(hook);

      if (direct !== null) return direct;

      for (const pair of document.querySelectorAll(app.SELECTORS.datapair)) {
        const text = pair.textContent || "";

        if (!/maintenance limit/i.test(text)) continue;

        const found = app.to_cents(text);

        if (found !== null) return found;
      }

      const banner = (document.body?.innerText || "").match(
        /maintenance limit of\s*\$?\s*([\d,]+\.\d{2})/i,
      );

      return banner ? app.to_cents(banner[1]) : null;
    },

    /**
     * Whether AppFolio already holds an invoice for this work order.
     *
     * Keyed on the *absence* of the empty-state sentence rather than on
     * spotting an invoice, because the empty state is one fixed string and an
     * invoice row could look like anything. So an unreadable page reads as
     * "already invoiced" and refuses, which is the safe direction.
     */
    already_invoiced() {
      const text = document.body?.innerText || "";

      if (!/submitted invoices/i.test(text)) return false;

      return !/an invoice has not been uploaded for this work order/i.test(text);
    },

    /**
     * The invoice's item rows, as sets of the four fields.
     *
     * Zipped from four parallel NodeLists in document order rather than found
     * inside a row container. Nothing on the row wrapper is stable — no js-
     * class, no index, no name attribute anywhere on these inputs — and no
     * capture exists of a two-row invoice, so a structure this does not depend
     * on is a structure that cannot be wrong about it.
     */
    rows() {
      const descriptions = [...document.querySelectorAll(app.SELECTORS.description)];
      const quantities = [...document.querySelectorAll(app.SELECTORS.quantity)];
      const rates = [...document.querySelectorAll(app.SELECTORS.rate)];
      const amounts = [...document.querySelectorAll(app.SELECTORS.amount)];

      return descriptions.map((description, index) => ({
        description,
        quantity: quantities[index] || null,
        rate: rates[index] || null,
        amount: amounts[index] || null,
      }));
    },

    async ensure_rows(wanted) {
      for (let guard = 0; guard < wanted + 2; guard++) {
        const rows = app.rows();

        if (rows.length >= wanted) {
          const incomplete = rows
            .slice(0, wanted)
            .some((row) => row.description === null || row.quantity === null || row.rate === null);

          return incomplete ? "An invoice row was missing one of its fields." : true;
        }

        const add = app.find_add_row();

        if (add === null)
          return `This invoice needs ${wanted} items and the Add Line Item button could not be found.`;

        const before = rows.length;

        add.click();

        const grew = await app.wait_for(() => (app.rows().length > before ? true : null));

        if (grew === null) return "An invoice row did not appear after adding it.";
      }

      return "Could not add enough invoice rows.";
    },

    /**
     * The Add Line Item button.
     *
     * By its text, because its only class is a build-hashed CSS-module name
     * (`invoiceform_add-row-border__Gv96I`) whose suffix changes on every
     * AppFolio deploy. The text lives in a child span.
     */
    find_add_row() {
      for (const button of document.querySelectorAll("button")) {
        if (!app.visible(button)) continue;
        if (app.clean(button.textContent) === "add line item") return button;
      }

      return null;
    },

    find_submit() {
      for (const button of document.querySelectorAll(app.SELECTORS.submit_toolbar)) {
        if (!app.visible(button)) continue;
        if (app.clean(button.textContent) === "submit invoice") return button;
      }

      return null;
    },

    /**
     * The total AppFolio computed, in cents.
     *
     * **Read from an input's value**, which is the correction that matters
     * most here. The total is a `disabled` input with the `$` in a sibling
     * span, so it does not appear in `innerText` at all — an earlier version
     * scanned the page text for it, found nothing, and fell back to the largest
     * money-looking string on the page, which is the maintenance limit.
     */
    invoice_total_cents() {
      for (const label of document.querySelectorAll("div.text-muted")) {
        if (app.clean(label.textContent) !== "total") continue;

        const container = label.parentElement;

        if (container === null) continue;

        const input = container.querySelector("input[disabled]");

        if (input !== null) {
          const cents = app.to_cents(input.value);

          if (cents !== null) return cents;
        }
      }

      /* No labelled total found. The per-line amounts are also computed by
         React, so their sum is the same number by a different route. */
      const amounts = [...document.querySelectorAll(app.SELECTORS.amount)];

      if (amounts.length === 0) return null;

      let sum = 0;

      for (const amount of amounts) {
        const cents = app.to_cents(amount.value);

        if (cents === null) return null;

        sum += cents;
      }

      return sum;
    },

    /** Each line's computed amount against what it should be. */
    check_lines(items) {
      const rows = app.rows();

      for (const [index, item] of items.entries()) {
        const amount = rows[index]?.amount;

        if (!amount) continue;

        const shown = app.to_cents(amount.value);
        const wanted = Number(item.expected_total_cents || 0);

        if (shown === null || shown === wanted) continue;

        return (
          `Line ${index + 1} came to ${app.dollars(shown)} and should be `
          + `${app.dollars(wanted)}. Nothing was submitted.`
        );
      }

      return null;
    },

    /** Whatever AppFolio called the invoice, if the page says. */
    invoice_reference() {
      const match = (document.body?.innerText || "").match(/invoice\s*#\s*([A-Za-z0-9-]{1,32})/i);

      return match ? match[1] : "";
    },

    async ask_to_submit(delivery_id) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "DELIVERY_ABOUT_TO_SUBMIT",
          payload: { delivery_id },
        });

        if (response?.ok === true) return true;

        return response?.status === 409
          ? "Somebody else is already delivering this job."
          : "The web app could not be told this was about to be submitted.";
      } catch {
        return "Lost contact with the extension just before submitting.";
      }
    },

    /* ---- writing to the page -------------------------------------------- */

    /**
     * Set a field's value so React notices.
     *
     * Through the native property setter, then `input` and `change`. Assigning
     * `.value` directly bypasses React's value tracker, which then believes the
     * field never changed and reverts it on the next render — the field looks
     * filled and the form holds something else. This is the fix for the bug
     * `content/buildertrend_add_job.js` documents as deliberately unfixed.
     */
    set_value(element, value) {
      if (!element) return;

      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      element.focus();

      if (setter) setter.call(element, String(value));
      else element.value = String(value);

      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.blur();
    },

    /**
     * Put photographs on the note.
     *
     * react-dropzone renders its own hidden `input[type=file]`, and setting
     * that plus a `change` event is the documented way in. The synthetic `drop`
     * is a fallback for a build that stops rendering the input — dropzone
     * listens for both.
     *
     * A file input's `files` cannot take an array; DataTransfer is the only way
     * to build a FileList.
     */
    attach(files) {
      const transfer = new DataTransfer();

      for (const file of files) transfer.items.add(file);

      const input = document.querySelector(app.SELECTORS.note_file_input);

      if (input !== null) {
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        return true;
      }

      const zone = document.querySelector(app.SELECTORS.note_dropzone);

      if (zone === null) return false;

      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });

      zone.dispatchEvent(drop);

      return true;
    },

    /**
     * A photograph, as a File.
     *
     * The bytes come from the service worker: a fetch from here would be *this
     * page's* request and would meet CORS, which is why every network call in
     * this extension lives in the worker. They arrive base64'd because a Blob
     * cannot cross chrome.runtime.sendMessage, and are decoded here rather than
     * fetched as a data: URL so the page's own CSP has no say in it.
     */
    async fetch_photo(photo) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "DELIVERY_PHOTO",
          payload: { id: photo.id },
        });

        if (response?.ok !== true || !response.base64) return null;

        const binary = atob(response.base64);
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

        return new File([bytes], photo.name || `photo-${photo.id}.jpg`, {
          type: response.mime_type || photo.mime_type || "image/jpeg",
        });
      } catch {
        return null;
      }
    },

    /* ---- small helpers --------------------------------------------------- */

    text(selector) {
      const element = document.querySelector(selector);

      return element === null ? "" : (element.textContent || "").trim();
    },

    clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    },

    /**
     * "$1,234.56", "1234.56", "…limit of $250.00" to cents. Null when absent.
     *
     * A figure has to look like money to count: either a `$` in front of it or
     * two decimal places behind it. Without that requirement this reads
     * "Work Order #19327 - 1" as nineteen thousand dollars — and it is pointed
     * at page text on purpose, including the maintenance-limit banner, so a
     * bare integer somewhere on the page must not become a figure.
     *
     * Integer arithmetic, deliberately: App\Support\Money does the same, and a
     * check that parsed money as a float would be a check that disagrees with
     * the thing it is checking.
     */
    to_cents(text) {
      const source = String(text ?? "");

      /* With a currency symbol, the fraction is optional. */
      let match = source.match(/(-)?\$\s*(\d[\d,]*)(?:\.(\d{2}))?(?!\d)/);

      /* Without one, two decimal places are the only thing that makes it money
         rather than a work-order number or a count. */
      if (!match) match = source.match(/(-)?(\d[\d,]*)\.(\d{2})(?!\d)/);

      if (!match) return null;

      const whole = Number(match[2].replace(/,/g, ""));

      if (!Number.isFinite(whole)) return null;

      const cents = whole * 100 + Number((match[3] || "0").padEnd(2, "0"));

      return match[1] === "-" ? -cents : cents;
    },

    dollars(cents) {
      const absolute = Math.abs(Number(cents) || 0);
      const whole = Math.floor(absolute / 100).toLocaleString("en-US");

      return `${cents < 0 ? "-" : ""}$${whole}.${String(absolute % 100).padStart(2, "0")}`;
    },

    visible(element) {
      if (element.disabled === true || element.hidden === true) return false;

      const box = element.getBoundingClientRect();

      return box.width > 0 && box.height > 0;
    },

    /**
     * Poll until the callback returns something other than null.
     *
     * A MutationObserver would be the fashionable answer and is worse here: the
     * things being waited for are a form mounting and React recomputing a
     * total, both of which produce dozens of mutations, and the observer would
     * re-evaluate the condition on each one anyway. Polling cannot be starved
     * by a chatty page.
     */
    async wait_for(check, timeout = app.WAIT_MS) {
      const deadline = Date.now() + timeout;

      for (;;) {
        let found = null;

        try {
          found = check();
        } catch {
          found = null;
        }

        if (found !== null && found !== undefined && found !== false) return found;
        if (Date.now() > deadline) return null;

        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
});
