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

/* Not the DOMContentLoaded closure the rest of this project uses as its module
   scope, and the difference is not stylistic. A content script declared
   `run_at: document_idle` is injected *after* DOMContentLoaded has fired, so a
   listener for that event is registered too late and its callback never runs —
   taking the whole module with it, message handlers included. The symptom is
   the popup saying "That page did not answer" forever, on a page whose markup
   is perfectly fine. content/buildertrend_add_job.js has always bootstrapped
   the way this now does. */
(() => {
  const app = {
    /**
     * Every hook this script uses.
     *
     * The one place to correct if AppFolio's markup moves. Grouped by the page
     * each belongs to, because the handlers below are grouped the same way.
     */
    SELECTORS: {
      /* whether anything at all has finished loading
         --------------------------------------------------------------------
         Two different loading states, verified against captures of both in
         storage/temporary-items/ (`spinner` and `skeleton list`).

         `loading` is the whole-page spinner a navigation shows: it replaces
         every child of #property-content, so during it there is no nav, no
         number, no anything. role/aria-label rather than a class because an
         accessibility contract is the least likely thing on the page to be
         renamed — and .gears-spinner, its unhashed class, is the fallback.

         `list_placeholder` is the shimmer the list shows when a tab is
         clicked. Its class is a CSS module, so the trailing five characters
         are a BUILD HASH and change on every AppFolio deploy: match the
         component prefix, never the whole string. */
      loading: "[role='status'][aria-label='loading'], .gears-spinner",
      list_placeholder: "[class*='WorkOrderListPlaceholder_']",

      /* Portal furniture, outside #property-content and so present whatever
         the content is doing. Only the probe uses these, to tell "the portal
         is up and this is a page I do not recognise" from "there is nothing
         here at all". */
      navbar: ".js-navbar",
      universal_search: ".js-universal-search",

      /* the list at / */
      /* Also the list's readiness signal, which is why nothing here needs a
         skeleton class to know the rows have arrived. AppFolio adds this hook
         only when it renders real rows: the skeleton capture's container is
         `WorkOrderList_work_order_list__container__pYHFZ` and the settled
         one's is `js-work-orders WorkOrderList_work_order_list__container__…`.
         So hook absent means loading, and hook present with no rows means the
         tab really is empty. */
      list: ".js-work-orders",
      list_row: ".js-work-orders a[href*='/workOrders/']",
      /* NOT unique to a list row — the same class heads "Submitted Invoices",
         "Job Details" and "Submit New Invoice". It is only ever queried inside
         one row's <a>, never against the document. */
      list_row_number: "h2.card-title",
      /* A list row's status badge — `Needs Invoice`, `Under Review`,
         `Payment Sent`. NOT span.js-work-order-status: that is the detail
         page's hook and the two are different vocabularies. Queried inside one
         row's <a> for the same reason the number is. */
      list_row_status: "span.js-summary-status",
      tab_in_progress: ".js-nav-in-progress a",
      tab_estimates: ".js-nav-estimated a",
      tab_completed: ".js-nav-completed a",
      /* The per-tab status filter, and the Clear Filters button beside it.
         The option set differs per tab, but it is a HARDCODED per-tab list,
         not a summary of the rows: Completed offers `Closed` and
         `Needs Invoice` with no such rows in the capture, and Estimates has
         four `Accept/Reject` rows with no such option. So it says which tab's
         shell is up and says nothing about whether the data has arrived --
         the skeleton capture already has all five of Completed's options.
         An earlier version watched it for exactly that and was wrong.

         Clear Filters ships `disabled` when nothing is filtered, so an
         ENABLED one plus zero rows means "filtered to nothing" rather than
         "this tab is empty". */
      status_filter: "select.js-status-input",
      status_filter_option: "select.js-status-input option",
      clear_filters: "button.js-clear-filters",

      /* a work order */
      number: "span.js-work-order-number-display",
      status: "span.js-work-order-status",
      maintenance_limit: ".js-maintenance-limit",
      datapair: ".js-datapair",

      /* The work order's own description, on the invoices page, where it has a
         hook of its own. On the work-order page it is a .js-datapair like any
         other and has to be found by its label — see description_text(). Both
         confirmed in the captures under storage/temporary-items/. */
      detail_description: ".js-detail-description",
      work_done: "button.js-done-button",

      /* Work Done does not change anything by itself: it opens "Submit this
         Work Order as Done?" with Yes and Cancel, and Yes is what sends the
         PATCH. Watched live on 17 September 2026 (19426-1). The id is
         AppFolio's own; the dialog has no js- hook. */
      work_done_yes: "#work-order-modal-yes-button",
      notes_button: "button.js-notes-button",
      invoices_button: ".js-invoices-button",

      /* Accept and Decline are the only controls on the site with no js- hook,
         so they are found by a prefix match on the container plus the Bootstrap
         variant, and confirmed by their text. */
      pending_actions: "[class*='work-order-pending-actions']",

      /* the notes page */
      notes_container: "div.js-notes",
      note_field: "textarea.js-note-field",
      note_dropzone: "#react-dropzone",
      note_file_input: "#react-dropzone input[name='file-input-field']",
      note_save: "button.js-notes-form-save",
      notes_list: "div.js-notes-list",

      /* What the page renders once it has actually taken the photographs.
         The previews are siblings *above* #react-dropzone, not children of it —
         the dropzone keeps saying "Drag Images Here" no matter how many are
         selected — so anything scoped inside it matches nothing. Confirmed
         against the live page on 16 September 2026 by selecting two images and
         reading the result back. See attached_count(). */
      note_thumb: "img[alt='selected']",

      /* the invoices page */
      invoices_container: ".js-invoices",
      /* The limit, where it actually gates a submit. maintenance_limit_cents()
         used to reach this page's figure only through a prose regex over
         document.body.innerText — .js-maintenance-limit and .js-datapair are
         work-order-detail furniture and neither is on the invoices page. */
      invoices_limit_alert: ".js-invoices-maintenance-limit-alert",
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

    /**
     * How long a freshly navigated page may take to bring its data in.
     *
     * Its own budget because it is paid before every command rather than after
     * a click, and because a timeout here is a *failure* — so it should be
     * generous. The portal settles in one to two seconds on a good connection,
     * but that is network-bound and not a number to design against.
     */
    READY_MS: 15000,

    /**
     * The three tabs, in the order a delivery should look.
     *
     * In Progress first because it is what `/` renders on a fresh load, so the
     * common case clicks nothing. Completed second because that is where the
     * jobs this extension exists for actually live — pressing Work Done moves
     * a job off In Progress and onto Completed as `Needs Invoice`. Estimates
     * last because a job being invoiced has no business there at all, and
     * finding one there is a refusal rather than a destination.
     *
     * All three <a> elements are always in the DOM. It is the other tabs'
     * *rows* that are not there until clicked.
     */
    TABS: [
      { key: "in_progress", label: "In Progress", nav: "tab_in_progress" },
      { key: "completed", label: "Completed", nav: "tab_completed" },
      { key: "estimates", label: "Estimates", nav: "tab_estimates" },
    ],

    /**
     * How long one tab may take to render.
     *
     * Its own budget rather than WAIT_MS, because this one is paid on the
     * *miss* path: a number that is genuinely nowhere waits out every tab it
     * visits, and at WAIT_MS that is forty-five seconds added to a job that
     * was going to be refused anyway, times however many are in the queue. Ten
     * seconds covers the 109-row Completed render in the saved captures.
     */
    TAB_WAIT_MS: 10000,

    /**
     * How long the dropzone may take to admit it has the photographs.
     *
     * Its own budget for the opposite reason TAB_WAIT_MS has one: this is paid
     * on the *hit* path, once per note, and react-dropzone's onDrop is a
     * microtask plus a render — it is either there in well under a second or it
     * is not coming. Waiting WAIT_MS on every note to learn that would put
     * fifteen seconds on each job for nothing.
     */
    ATTACH_WAIT_MS: 5000,

    async init() {
      /* Remembered whenever a person is on a vendor work order, because that is
         the only moment the web app can learn this page's address — the
         displayed number cannot be turned into a URL. Fire and forget.

         The pathname is checked first so a list page does not sit out the
         readiness budget for a message it was never going to send. Then it
         waits, for the same reason everything else does: this used to read the
         number at `window load`, which is the document and not the data, and
         fall back to document.title when the hook had not rendered. Both ends
         of that were wrong. The title can still name the *previous* work order
         after a client-side route change, so this would bank number A against
         work order B — poisoning the one field the whole fast path depends on;
         and without the fallback, an unwaited read simply sends nothing, so
         target_url is never learned and every delivery walks the tabs. Waiting
         is what makes dropping the fallback an improvement rather than a
         trade. */
      if (!/\/workOrders\/\d+/.test(location.pathname)) return;
      if (!(await app.await_ready())) return;

      const number = app.page_number();

      if (number !== "")
        chrome.runtime.sendMessage({
          type: "VENDOR_PAGE_SEEN",
          payload: { number, url: app.work_order_url() },
        });
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

      /**
       * Nothing reads a page that has not finished loading.
       *
       * Here rather than in each handler, because there is one funnel and
       * seven things that would each have to remember. Every command below
       * used to be handed a page whose chrome was up and whose data was in
       * flight, where "" and null and 0 are what the DOM answers and every
       * guard in this file reads those as permission to proceed.
       *
       * Two exemptions, for opposite reasons.
       *
       * VENDOR_PAGE_STATUS is the liveness handshake delivery.js retries, and
       * a slow page that stopped answering it is indistinguishable from a page
       * with no script on it at all.
       *
       * VENDOR_PAGE_PROBE is the tool for diagnosing a page nothing else can
       * read — including the case where AppFolio has renamed the very hook
       * readiness is waiting for. Gate it and the one instrument that would
       * show you that refuses to report it. It answers with `loading` and
       * `list_state` instead, and says in its hint when its own readings are
       * not to be trusted.
       */
      const ungated = message.type === "VENDOR_PAGE_STATUS" || message.type === "VENDOR_PAGE_PROBE";

      const gated = ungated
        ? Promise.resolve().then(handler)
        : app.await_ready().then((ready) =>
            ready
              ? handler()
              : {
                  ok: false,
                  error: `That page did not finish loading in ${app.READY_MS / 1000} seconds, `
                    + "so nothing was read from it.",
                },
          );

      gated
        .then((result) => respond(result))
        .catch((error) =>
          respond({ ok: false, error: error?.message || "That page could not be read." }),
        );

      return true;
    },

    /* ---- the commands --------------------------------------------------- */

    /**
     * What this page has, writing nothing.
     *
     * Safe against a live client's work order, which is the point: ASH has no
     * AppFolio sandbox, so the alternative to a passive check is finding out by
     * submitting something. It reports per hook rather than per label, so the
     * answer names the thing to fix.
     *
     * On the list it does click, through all three tabs and back again — the
     * one thing here that is not purely a read. It is still nothing a person
     * could not do with a mouse, and it is the only way to see the other tabs
     * at all, because their rows are not in the DOM until clicked. Nothing on
     * any work order is written, which is the promise that matters.
     */
    async probe() {
      const found = {};

      for (const [key, selector] of Object.entries(app.SELECTORS))
        found[key] = document.querySelectorAll(selector).length;

      const page = app.page_kind();

      /* Which hooks *should* be here. Without this the report is 25 counts and
         mostly zeroes, because every page holds a quarter of the map — and a
         reader cannot tell an expected zero from a broken selector. */
      const expected = {
        list: [
          "list",
          "list_row",
          "list_row_status",
          "tab_in_progress",
          "tab_completed",
          "tab_estimates",
          "status_filter",
        ],
        work_order: ["number", "status", "work_done", "notes_button", "invoices_button", "datapair"],
        notes: ["notes_container", "note_field", "note_dropzone", "note_file_input", "note_save", "notes_list"],
        invoices: found.description > 0
          ? ["number", "invoices_container", "description", "quantity", "rate", "amount", "submit_toolbar"]
          : ["number", "invoices_container", "create_invoice"],

        /* An unknown page used to yield no expected list, so `missing` was
           empty and the report ended with "all present." — on a page holding
           nothing at all. The one tool for telling a loaded page from a blank
           one could not tell them apart. These two are portal chrome, so both
           missing means not even the shell is there. */
        unknown: ["navbar", "universal_search"],
      }[page] || [];

      return {
        ok: true,
        state: app.read_state(),
        url: location.href,
        page,

        /* Reported rather than waited out, because probe() is the one command
           the readiness gate lets through either way: a person pressing Check
           this page on a stuck portal needs to be told it is stuck, not handed
           a timeout. */
        loading: app.loading(),
        list_state: page === "list" ? app.list_state() : "",
        number: app.page_number(),
        status: app.text(app.SELECTORS.status),
        maintenance_limit_cents: app.maintenance_limit_cents(),
        already_invoiced: app.already_invoiced(),
        active_tab: app.active_tab(),
        list: page === "list" ? await app.survey_tabs() : null,
        expected,
        missing: expected.filter((key) => found[key] === 0),
        found,
        hint:
          page === "invoices" && found.description === 0
            ? "This is the invoices page before the form opens. Click Create Invoice, then check again."
            : page === "unknown"
              ? "This does not look like a work order, a notes page, an invoices page or the list."
              : app.loading()
                ? "This page is still loading. Nothing below is a reliable reading of it."
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
    async inspect(job) {
      if (app.read_state() === "signed_out") return { ok: false, signed_out: true };

      if (app.page_kind() === "list") {
        const found = await app.find_in_list(job.number || "");

        return {
          ok: found.href !== null,
          page: "list",
          href: found.href,

          /* Transient, and named apart from the `status` the work-order arm
             below returns: one message type, two shapes, and locate() reads
             both. This one is the list badge (`Needs Invoice`, `Payment Sent`),
             that one is span.js-work-order-status. Neither is ever persisted --
             the only thing that reaches the server from here is the URL, keyed
             on the number, by POST /api/deliveries/url. */
          list_tab: found.tab,
          list_status: found.status,
          tabs: found.scanned,
          searched_all: found.searched_all,

          error: found.href === null ? app.not_found_reason(job.number, found) : "",
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
        description: app.description_text(),
      };
    },

    /**
     * Every tab's row count and status badges, by actually clicking through.
     *
     * The rehearsal for the tab-switching a delivery now depends on, run
     * somewhere it cannot cost anything: a tab click is a client-side view
     * change that writes nothing, exactly what a person does with a mouse. It
     * is also the only way to see the other tabs at all, since their rows are
     * not in the DOM until clicked.
     *
     * And it is the only check that can tell whether js-summary-status still
     * reads the words delivery classifies on. A histogram that comes back
     * `{"(no badge)": 109}` is the warning; a delivery finding out instead is a
     * queue full of refusals.
     *
     * Unlike the delivery path this puts the tab back. "Check this page" runs
     * against the tab a person is looking at, and moving her view out from
     * under her and leaving it moved is startling for no gain. A restore that
     * does not land harms nothing.
     */
    async survey_tabs() {
      const started_on = app.active_tab();
      const tabs = [];

      for (const tab of app.TABS) {
        const confirmed = await app.show_tab(tab.key);

        tabs.push({
          tab: tab.key,
          label: tab.label,
          confirmed,

          /* The state, not just the count. A bare `0 rows` was the output that
             sent everyone looking for a broken selector when the real answer
             was "asked too early" — and it read `ok` while it did it. */
          state: app.list_state(),
          rows: document.querySelectorAll(app.SELECTORS.list_row).length,
          statuses: app.status_histogram(),
          filter_options: [...document.querySelectorAll(app.SELECTORS.status_filter_option)]
            .map((option) => option.value)
            .filter((value) => value !== ""),
        });
      }

      if (started_on !== "") await app.show_tab(started_on);

      return { started_on, tabs };
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
        return { ok: false, error: "Could not find the Accept button on this work order." };

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
     * The dropzone is react-dropzone; attach() puts the files on its hidden
     * input and waits for the page to say it has them.
     *
     * **Save is not pressed until the photographs are visibly on the form.**
     * That ordering is the whole point of this function: a note saved without
     * its photographs cannot be repaired afterwards, because a retry posts a
     * *second* note rather than filling in the first. So a failure to attach is
     * a failure of the note, taken before anything is written — which is cheap,
     * because notes are posted before the invoice and nothing has been billed
     * yet.
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

      /* Every photograph failed to fetch. Saving now would post exactly the
         text-only note this path exists to prevent, so it is a failure — and a
         safely retryable one, because notes go before the invoice and nothing
         has been written to AppFolio yet. */
      if (photos.length > 0 && files.length === 0)
        return {
          ok: false,
          error: `None of the ${photos.length} photographs for this note could be fetched.`,
        };

      let attached = 0;

      if (files.length > 0) {
        attached = await app.attach(files);

        /* One retry on the same page. The likeliest cause of a first miss is
           the dropzone not having been mounted when the event went out, and
           that cures itself in the time the first attempt spent waiting. */
        if (attached < files.length) attached = await app.attach(files);

        /* Deliberately before the click: a note saved without its photographs
           cannot be repaired by a retry, because the retry posts a second note
           rather than filling in the first. */
        if (attached < files.length)
          return {
            ok: false,
            error: `Only ${attached} of ${files.length} photographs would attach to the note, so it was not saved.`,
          };
      }

      const save = document.querySelector(app.SELECTORS.note_save);

      if (save === null) return { ok: false, error: "Could not find the Save Note button." };

      /* Counted before the click, because the test this replaces — whether the
         list still reads "No Notes" — is already false on any job that has a
         note, which is every second batch and every retry. It returned true on
         the first poll and confirmed nothing. */
      const before = app.note_count();

      save.click();

      const saved = await app.wait_for(() => (app.note_count() > before ? true : null));

      return saved === null
        ? { ok: false, error: "Save Note was pressed but the note did not appear." }
        : { ok: true, photos_attached: attached, photos_offered: photos.length };
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

      /* The last chance to notice this is the wrong work order to be billing.
         Step A asked the same question on the work order's own page; this asks
         it on the page the invoice is being typed into, which is the page the
         answer has to be true about. `.js-detail-description` is right here in
         the Job Details block, so it costs a selector lookup.

         An unreadable description refuses in sample mode and passes in live,
         for the reason written out in delivery.js's scope_refusal(). */
      const population = app.population_refusal(job.scope);

      if (population !== null) return { ok: false, blocked: true, error: population };

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

      /* A zero expected total makes every check below vacuous rather than
         strict: `expected > limit` cannot fire, the cent-exact read-back is
         satisfied by an empty form reading $0.00 — before React has picked up
         a single typed rate — and check_lines() passes each line on 0 === 0.
         So the one number the whole reconciliation is measured against is
         refused if it is missing, instead of being taken as agreement. */
      if (expected <= 0)
        return {
          ok: false,
          blocked: true,
          error: "This job arrived with no expected total, so there is nothing to check an invoice "
            + "against. Nothing was submitted.",
        };

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

      /* `blocked`, not a bare failure, and the distinction is the whole of
         step 2 of the rollout.
         
         Everything worked: the form is filled, the total reads back to the
         cent, and it is sitting there waiting for a person — which is exactly
         what auto_submit: false asks for. Reported as a plain failure it would
         spend the attempt, put a row on a screen that is meant to be empty on a
         good day, and leave the delivery `failed` — which is claimable, so the
         next poll would re-claim it and fill the form again a minute later, and
         again, until recent_failures() tripped the circuit breaker and paused
         the queue. One job on its own would do it inside ten minutes.
         
         That is the argument release() already makes for a rehearsal, applied
         to the other half-step: nothing was sent, a retry cannot help, and a
         person is required. `blocked` is the state for precisely that — it is
         excluded from the breaker, it is not claimable, and /deliveries renders
         it as "Held back" with the two buttons that resolve it once she has
         pressed Submit. */
      if (job.auto_submit === false)
        return {
          ok: false,
          blocked: true,

          /* Distinct from every other refusal, because this is the only one
             that leaves something on the page worth keeping: a filled,
             cent-checked invoice waiting for a person to press Submit.
             delivery.js reads it and declines to close the tab. */
          awaiting_submit: true,
          error:
            "Filled in and checked to the cent, but automatic submitting is switched off. "
            + "Press Submit Invoice on the vendor page, then mark this as delivered.",
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
      /* AppFolio holding the invoice, and nothing else. This used to accept
         `description === null` as well — "the form went away" — which React
         satisfies by unmounting the input during any re-render, including the
         ones an error state causes. A submit that did not land then reported
         `delivered`, which is the one outcome nothing downstream re-examines.
         Failing to see confirmation now means `unconfirmed`, which is the
         honest answer and already has a screen of its own. */
      const done = await app.wait_for(() => (app.already_invoiced() ? true : null));

      if (done === null)
        return {
          ok: false,
          unconfirmed: true,
          error: "Submit Invoice was pressed and the page did not change. Check AppFolio before retrying.",
        };

      return { ok: true, external_ref: app.invoice_reference() };
    },

    /**
     * Whether the badge says the job is past Work Done.
     *
     * `Under Review` is what Yes produces, watched live. The later three are the
     * rest of the billing pipeline and can only follow it. Compared
     * case-insensitively because the badge renders in capitals.
     */
    is_work_done() {
      return /^(under review|payment pending|payment sent|closed)$/i.test(
        app.text(app.SELECTORS.status).replace(/\s+/g, " "),
      );
    },

    /**
     * Move the job to Work Done, and say so only when the badge does.
     *
     * Scoped by class rather than text: the status dropdown carries a menu item
     * with the same words, and clicking that one opens a menu instead.
     *
     * Two clicks, not one. The button opens "Submit this Work Order as Done?"
     * and only Yes sends anything. While that dialog is open the page unmounts
     * the badge and the button, and the previous version took "the button is
     * gone" for success — so 19426-1 was reported Work Done with the dialog
     * still open, and closing the tab dismissed it. The only success signal now
     * is the badge reading a post-Work-Done status, which the page renders from
     * the server's answer. The button is not a signal either way: it stays on
     * the page, disabled, after Work Done.
     *
     * The toast that follows offers Revert for a few seconds. The change is
     * already saved by then, so there is nothing to wait out, and nothing here
     * goes near it.
     */
    async work_done() {
      /* Already done — by a person, or by an earlier run whose report was
         lost. Pressing again would open a dialog on a disabled path. */
      if (app.is_work_done()) return { ok: true, already: true };

      const button = document.querySelector(app.SELECTORS.work_done);

      if (button === null)
        return { ok: false, error: "Could not find the Work Done button.", seen: app.work_done_seen() };

      if (button.disabled)
        return { ok: false, error: "The Work Done button is disabled.", seen: app.work_done_seen() };

      button.click();

      /* Yes only inside the dialog that asks this question, so a stray modal
         with a Yes of its own is never answered. */
      const yes = await app.wait_for(() => {
        const candidate = document.querySelector(app.SELECTORS.work_done_yes);
        const dialog = candidate?.closest(".modal, [role='dialog']");

        return candidate && /as done/i.test(dialog?.textContent || "") ? candidate : null;
      });

      if (yes === null)
        return {
          ok: false,
          error: "Work Done was pressed and the confirmation did not appear.",
          seen: app.work_done_seen(),
        };

      yes.click();

      const moved = await app.wait_for(() => (app.is_work_done() ? true : null));

      return moved === null
        ? {
            ok: false,
            error: "Yes was pressed on Work Done and the status did not change.",
            seen: app.work_done_seen(),
          }
        : { ok: true };
    },

    /**
     * What the work-order page showed when Work Done did not land. Reads only.
     *
     * Exists because the first live miss (17 September 2026) left nothing
     * behind: the job was invoiced and still In Progress, and nobody could say
     * whether the button was gone, disabled, or had opened something that
     * wanted a second click. Each of those is a different fix, so each is
     * recorded — the status badge, every Work Done control on the page, and
     * any dialog that is open with the words on its buttons.
     */
    work_done_seen() {
      const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        classes: String(element.className || "").slice(0, 200),
        text: (element.textContent || "").trim().slice(0, 80),
        disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
        visible: element.getClientRects().length > 0,
      });

      const labelled = [...document.querySelectorAll("button, a, [role='menuitem']")]
        .filter((element) => /work\s*done/i.test(element.textContent || ""));

      return {
        page: app.page_kind(),
        path: location.pathname,
        status: app.text(app.SELECTORS.status),
        done_buttons: [...document.querySelectorAll(`${app.SELECTORS.work_done}, .js-work-done-button`)]
          .map(describe),
        labelled_work_done: labelled.slice(0, 5).map(describe),
        dialogs: [...document.querySelectorAll(".modal.show, [role='dialog'], [role='alertdialog']")]
          .slice(0, 3)
          .map((dialog) => ({
            text: (dialog.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300),
            buttons: [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).slice(0, 6),
          })),
      };
    },

    /* ---- reading the page ----------------------------------------------- */

    /**
     * Which page this is, from the URL alone.
     *
     * The list arm used to be `document.querySelector(SELECTORS.list) !== null`
     * — a *readiness* test wearing a *routing* test's clothes. While the list
     * was still a skeleton that hook is absent, so this answered "unknown",
     * inspect() fell through to its work-order arm, and the only thing that
     * stopped a delivery running against the list page was an accidental
     * `!found.href` check in locate(). Routing is a URL question; whether the
     * page can be read is await_ready()'s, below.
     */
    page_kind() {
      if (/\/workOrders\/\d+\/invoices/.test(location.pathname)) return "invoices";
      if (/\/workOrders\/\d+\/notes/.test(location.pathname)) return "notes";
      if (/\/workOrders\/\d+/.test(location.pathname)) return "work_order";
      if (/^\/?$/.test(location.pathname)) return "list";

      return "unknown";
    },

    /* ---- has this page's data arrived? ----------------------------------
       The bug this whole section exists for: every wait_for() in this file
       confirms something after a *click*, and nothing guarded the first read
       of a freshly navigated page. delivery.js waits for tab.status ===
       "complete", which is the document and not the data, and the handshake
       answers on the first try — so a handler was handed a page with its
       chrome up and its content still in flight, where every read returns ""
       or null or 0 and every guard reads those as permission to proceed. */

    /** Whether either loading state is on screen. */
    loading() {
      return (
        document.querySelector(app.SELECTORS.loading) !== null
        || document.querySelector(app.SELECTORS.list_placeholder) !== null
      );
    },

    /**
     * Whether the list has real rows in it, as opposed to a skeleton.
     *
     * One hook, and it is the one this file already used for everything else:
     * AppFolio only puts `js-work-orders` on the container once it renders
     * rows. So this needs no knowledge of the shimmer's build-hashed class,
     * and "no rows" stops being ambiguous — see list_state().
     */
    list_ready() {
      return document.querySelector(app.SELECTORS.list) !== null;
    },

    /**
     * loaded / empty / filtered / loading, for the list.
     *
     * `filtered` matters because zero rows has two innocent causes and one
     * alarming one. Clear Filters is disabled when nothing is filtered, so an
     * enabled one with no rows means somebody's status filter excluded
     * everything — not that the tab is empty and not that we read too early.
     */
    list_state() {
      if (!app.list_ready()) return "loading";
      if (document.querySelectorAll(app.SELECTORS.list_row).length > 0) return "loaded";

      const clear = document.querySelector(app.SELECTORS.clear_filters);

      return clear !== null && clear.disabled !== true ? "filtered" : "empty";
    },

    /**
     * Whether this page can be read yet.
     *
     * Per page, from a datum only the loaded page has — never a timer. Each
     * was checked against the saved captures: js-work-order-number-display is
     * on all four non-list pages, js-note-field only on the notes page, and
     * js-invoices only on the two invoices captures.
     *
     * The invoices row is the load-bearing one. already_invoiced() answers
     * "no" when the Submitted Invoices section is absent, which is true of a
     * loaded page with no invoice on it and equally true of a page that has
     * not rendered — so making that section's presence a *precondition* is
     * what restores the fail-safe its own comment promises. Its logic is
     * untouched; it was never wrong about a loaded page, only asked about an
     * empty one.
     */
    page_ready() {
      const kind = app.page_kind();

      if (kind === "list") return app.list_ready();
      if (kind === "unknown") return false;
      if (app.loading()) return false;
      if (app.page_number() === "") return false;

      if (kind === "notes") return document.querySelector(app.SELECTORS.note_field) !== null;

      if (kind === "invoices")
        return document.querySelector(app.SELECTORS.invoices_container) !== null;

      return true;
    },

    /** Wait for it, or say plainly that it never arrived. */
    async await_ready() {
      if (app.page_ready()) return true;

      return (await app.wait_for(() => (app.page_ready() ? true : null), app.READY_MS)) === true;
    },

    /**
     * Signed in, or not, or cannot tell.
     *
     * The password check goes through visible(), because it used to be a bare
     * querySelector and *any* password input anywhere in the DOM answered
     * "signed out" — a password manager's injected field, an account panel, a
     * modal mounted but not shown. That answer is the most expensive one in
     * the extension: delivery.js aborts the entire drain on it.
     *
     * ## This is no longer the guard, and never really was
     *
     * Signing out of the portal redirects to `passport.appf.io`, a different
     * origin that no `content_scripts` entry matches — so on the page a
     * signed-out manager actually reaches, this function does not run at all.
     * And if it did it would miss twice over: the default sign-in there is an
     * emailed access link rather than a password (a password only appears under
     * *More Sign In Options*), and the title reads `Passport | AppFolio`, which
     * matches neither pattern below. Both observed live, 14 September 2026.
     *
     * `background/portals.js` owns the verdict now, from the tab's URL, which
     * is the only thing that can see a cross-origin redirect. What is left here
     * is a second opinion about the portal's *own* pages — worth keeping, since
     * a session that lapses while a portal page is open is real.
     *
     * ## Why the default is no longer "ready"
     *
     * It used to return "ready" for anything that was not provably signed out,
     * so a blank or half-rendered page read as signed in — which is the same
     * mistake `already_invoiced()` and `maintenance_limit_cents()` were fixed
     * for. `.js-navbar` is the positive evidence it lacked: portal chrome that
     * lives *outside* `#property-content`, so it survives the spinner that
     * replaces that container's children and is present while the content is
     * still in flight. No chrome and no sign-in marker is now "unknown", and
     * portals.js treats unknown as a question rather than an answer.
     */
    read_state() {
      for (const field of document.querySelectorAll("input[type='password']"))
        if (app.visible(field)) return "signed_out";

      if (/sign in|log in/i.test(document.title || "")) return "signed_out";

      if (document.querySelector(".js-navbar") || document.querySelector(".js-universal-search"))
        return "ready";

      return "unknown";
    },

    /**
     * The work-order number, normalised.
     *
     * The portal renders `19327 - 1 | Camelot Properties, LLC` on a work order
     * and `#19207 - 1, Camelot Properties, LLC` on a list card — spaces around
     * the hyphen, and a `#` on one of them. The web app holds `19327-1`. An
     * earlier version matched `\b\d+-\d+\b`, which matches neither, so its
     * wrong-page guard found nothing and skipped itself.
     *
     * It also used to fall back to document.title, which on a client-side
     * route change can still be the *previous* work order — and init() posts
     * this number with this page's URL to remember_vendor_url, so a stale
     * title banks number A against work order B and the next delivery for A
     * opens B. The fallback existed to cover a hook that had not rendered
     * yet; await_ready() covers that now, so it is gone.
     */
    page_number() {
      const match = app.text(app.SELECTORS.number).match(/(\d+)\s*-\s*(\d+)/);

      return match ? `${match[1]}-${match[2]}` : "";
    },

    /** The work order's own URL, without /notes or /invoices on the end. */
    work_order_url() {
      const match = location.pathname.match(/^(\/[^/]+\/workOrders\/\d+)/);

      return match ? `${location.origin}${match[1]}` : location.href;
    },

    /** Which tab is rendered, as a TABS key. "" when the nav cannot be read. */
    active_tab() {
      for (const tab of app.TABS) {
        const link = document.querySelector(app.SELECTORS[tab.nav]);

        if (link !== null && link.classList.contains("active")) return tab.key;
      }

      return "";
    },

    /** A tab's own name, for a sentence a person reads. */
    tab_label(key) {
      return app.TABS.find((tab) => tab.key === key)?.label || key;
    },

    /**
     * Which rows are on screen, as a string.
     *
     * Rows only — no tab name, no filter options. Both of those are client
     * state that flips on the click, before any data is fetched: the saved
     * skeleton capture already has the nav marked `active`, the <h1> reading
     * "Completed" and all five of Completed's filter options, with six shimmer
     * cards where the rows go. An earlier version folded the option set in
     * here on the theory that it was a data-side signal, and it is not — it
     * made "the list changed" true the instant a tab was clicked, which is the
     * exact false positive this exists to prevent.
     *
     * A work order appears on exactly one tab, so two tabs can never share a
     * row and this always moves on a real switch. An empty destination gives
     * `0::`, which also differs.
     */
    list_identity() {
      const rows = document.querySelectorAll(app.SELECTORS.list_row);
      const first = rows[0]?.getAttribute("href") || "";
      const last = rows[rows.length - 1]?.getAttribute("href") || "";

      return `${rows.length}:${first}:${last}`;
    },

    /** Every row's status badge, counted. For the probe. */
    status_histogram() {
      const counts = {};

      for (const row of document.querySelectorAll(app.SELECTORS.list_row)) {
        const badge = row.querySelector(app.SELECTORS.list_row_status);
        const label = badge === null ? "(no badge)" : app.badge_text(badge) || "(blank)";

        counts[label] = (counts[label] || 0) + 1;
      }

      return counts;
    },

    /**
     * A badge's words, with its spacing collapsed and its casing kept.
     *
     * Not app.clean(), which lowercases: these strings are quoted back to a
     * person in a refusal and shown in the probe, so `Payment Sent` has to stay
     * the way AppFolio writes it. The classifier in background/delivery.js does
     * its own lowercasing when it compares.
     */
    badge_text(element) {
      return String(element?.textContent || "").replace(/\s+/g, " ").trim();
    },

    /**
     * Render one of the three tabs.
     *
     * The hard part, and it is not the click. The tabs are `<a href="#">` with
     * no route of their own, so there is no navigation to wait on, no URL
     * change and no load event — and the nav's `active` class moves on the
     * click rather than on the data, so waiting for that alone hands the
     * caller the *previous* tab's rows and a straight face.
     *
     * So two conditions, both required: the nav says this tab, and the rows are
     * not the rows that were there before the click. The second is the real one.
     *
     * Returns false rather than throwing when it cannot confirm, because
     * scanning a stale tab can only ever produce a false *miss* — the match is
     * on the work order's number and the href comes off the row that matched,
     * so the wrong tab's rows cannot yield the wrong job. The caller records
     * which tabs were confirmed and says so when it finds nothing, and that is
     * what keeps a slow render from being reported as "this job does not exist".
     */
    async show_tab(key) {
      /* Still a wait, even when this tab is already the one showing. It used
         to return true here on the strength of the nav's `active` class alone,
         and that is the class this function's own comment calls worthless as a
         data signal. Two consequences, both seen: `/` renders In Progress with
         `active` already set while the list is a skeleton, so the first tab of
         every search was scanned at zero rows; and a person who clicks a tab
         and presses the button inside the render window gets the *previous*
         tab's rows counted under the new tab's name. */
      if (app.active_tab() === key)
        return (await app.wait_for(() => (app.list_ready() ? true : null), app.TAB_WAIT_MS)) === true;

      const tab = app.TABS.find((candidate) => candidate.key === key);
      const link = tab ? document.querySelector(app.SELECTORS[tab.nav]) : null;

      if (link === null) return false;

      const before = app.list_identity();

      link.click();

      /* Both conditions, and the second is the real one. `js-work-orders`
         present means rows rather than shimmer; a moved identity means they
         are *this* tab's rows and not the ones that were already there. */
      const landed = await app.wait_for(
        () =>
          app.active_tab() === key && app.list_ready() && app.list_identity() !== before
            ? true
            : null,
        app.TAB_WAIT_MS,
      );

      return landed === true;
    },

    /** A number's row on the tab rendered now, with its status badge. */
    scan_tab(wanted) {
      for (const row of document.querySelectorAll(app.SELECTORS.list_row)) {
        const label = row.querySelector(app.SELECTORS.list_row_number);

        if (label === null) continue;
        if (app.normalize_number(label.textContent) !== wanted) continue;

        const href = row.getAttribute("href") || "";

        if (href === "") return null;

        return {
          href: new URL(href, location.origin).href,
          status: app.badge_text(row.querySelector(app.SELECTORS.list_row_status)),
        };
      }

      return null;
    },

    /**
     * A number's row, across all three tabs.
     *
     * Why this is no longer one querySelectorAll: `/` renders In Progress, and
     * the job this extension exists to invoice is the one that has just left
     * In Progress — pressing Work Done moves it onto Completed as `Needs
     * Invoice`. So the single most likely job was the single job a one-tab scan
     * could not find, and background/delivery.js turned that into `failed`,
     * which counts toward the circuit breaker. Ten of those paused the queue
     * for everybody.
     *
     * The tab already rendered is scanned first whatever it is, because it
     * costs no click and because the delivery tab is not reloaded between jobs
     * — same_page() in delivery.js strips the hash, and a tab click leaves the
     * URL at `/#`, so job two starts wherever job one's search ended. Assuming
     * In Progress would be wrong from the second job onward.
     */
    async find_in_list(number) {
      const wanted = app.normalize_number(number);
      const scanned = [];

      if (wanted === "") return { href: null, tab: "", status: "", scanned, searched_all: false };

      const first = app.active_tab();
      const keys = app.TABS.map((tab) => tab.key);
      const order = first === "" ? keys : [first, ...keys.filter((key) => key !== first)];

      for (const key of order) {
        const confirmed = await app.show_tab(key);
        const rows = document.querySelectorAll(app.SELECTORS.list_row).length;

        /* Scanned even when the switch was not confirmed: a stale panel can
           only hide a row, never invent one, and the alternative is declining
           to look at all. */
        const hit = app.scan_tab(wanted);

        scanned.push({ tab: key, rows, confirmed, hit: hit !== null });

        if (hit !== null)
          return { href: hit.href, tab: key, status: hit.status, scanned, searched_all: false };
      }

      return {
        href: null,
        tab: "",
        status: "",
        scanned,
        searched_all: scanned.every((entry) => entry.confirmed),
      };
    },

    /**
     * Why a number was not found, specifically enough to act on.
     *
     * Three different situations used to wear one sentence — and it guessed
     * "it may be on another tab", which is now a lie because all three were
     * looked at. Which situation it is decides whether background/delivery.js
     * calls this a refusal or a failure, and only a failure counts toward the
     * circuit breaker, so the counts in here are evidence rather than detail.
     */
    not_found_reason(number, found) {
      const unconfirmed = found.scanned.filter((entry) => !entry.confirmed);
      const counts = found.scanned
        .map((entry) => `${app.tab_label(entry.tab)} ${entry.rows}`)
        .join(", ");

      if (found.scanned.every((entry) => entry.rows === 0))
        return `The portal list showed no work orders on any tab (${counts}). `
          + "Either nothing is assigned, or AppFolio's list markup has moved.";

      if (unconfirmed.length > 0)
        return `Work order ${number} was not found, and the `
          + `${unconfirmed.map((entry) => app.tab_label(entry.tab)).join(" and ")} tab did not `
          + `finish rendering in time, so it could not be searched properly (${counts}).`;

      return `Work order ${number} is on none of the portal's three tabs (${counts}).`;
    },

    /** `#19207 - 1, Camelot Properties, LLC` and `19207-1` to the same thing. */
    normalize_number(text) {
      const match = String(text || "").match(/(\d+)\s*-\s*(\d+)/);

      return match ? `${match[1]}-${match[2]}` : "";
    },

    /**
     * Why this page may not be billed, or null.
     *
     * The comparison is deliberately not done here — it is `marked()` in
     * background/scope.js and `WorkOrderScope::matches()` on the server, and a
     * third spelling of it inside a content script is how three things quietly
     * stop agreeing. This reads the page and applies the answer.
     *
     * No scope at all is a refusal. delivery.js will not start a run without
     * one, so reaching this with none means something is wrong rather than
     * something is old.
     */
    population_refusal(scope) {
      const mode = scope?.mode;

      if (mode !== "sample" && mode !== "live")
        return "The web app did not say which work orders may be billed, so nothing was submitted.";

      const description = app.description_text();

      if (description === "")
        return mode === "sample"
          ? "Sample mode is on and this work order's description could not be read from this page, "
            + "so it cannot be confirmed as a test work order. Nothing was submitted."
          : null;

      const marker = String(scope.marker || "");
      const carries = marker !== "" && app.normalize_marker(description).includes(app.normalize_marker(marker));

      if (carries === (mode === "sample")) return null;

      return mode === "sample"
        ? "Sample mode is on, but this page does not describe a test work order. Nothing was submitted."
        : "This page describes a test work order, and the web app is set to real work only. "
          + "Nothing was submitted.";
    },

    /** Keep identical to background/scope.js and App\Support\WorkOrderScope. */
    normalize_marker(value) {
      return String(value ?? "")
        .replace(/[\u00a0\u200b]/g, " ")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    },

    /**
     * This work order's description, as the vendor portal has it right now.
     *
     * Read fresh, at the moment of acting, and never stored — the same
     * discipline as the portal status. What it is compared against is the
     * marker the *web app* supplies, so there is one copy of that string in the
     * whole system and it is the server's.
     *
     * The dedicated hook first, because it is the invoices page's and the
     * invoices page is where an invoice is typed. The labelled datapair second,
     * because `.js-datapair` is generic furniture on the work-order page —
     * address, permission to enter, maintenance limit and description are all
     * the same class, so the label is the only thing that identifies it. That
     * is the idiom maintenance_limit_cents() already uses.
     *
     * Returns "" when it cannot be read, which every caller treats as *not
     * marked* rather than as *unknown*. In sample mode that refuses the job,
     * which is the safe direction and is the point.
     */
    description_text() {
      const hook = app.text(app.SELECTORS.detail_description);
      if (hook !== "") return hook;

      for (const pair of document.querySelectorAll(app.SELECTORS.datapair)) {
        const label = pair.querySelector("label");
        if (!/^description$/i.test((label?.textContent || "").trim())) continue;

        const value = pair.cloneNode(true);
        value.querySelector("label")?.remove();

        return (value.textContent || "").replace(/\s+/g, " ").trim();
      }

      return "";
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

      /* The invoices page carries neither .js-maintenance-limit nor
         .js-datapair — both are work-order-detail furniture — so the figure
         on the one page where it gates a submit used to be reachable only
         through the prose regex at the bottom of this function. This is that
         page's own hook, and it goes ahead of the prose for the same reason
         every other selector here prefers a js- class to body text. */
      const alert = app.to_cents(app.text(app.SELECTORS.invoices_limit_alert));

      if (alert !== null) return alert;

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
     * How many photographs the page is showing as taken.
     *
     * This is the question `input.files.length` cannot answer. Assigning a
     * FileList sets a property on a DOM node; it says nothing about whether
     * React ever read it. On 16 September 2026 the assignment stuck, the note
     * saved, and not one image was attached — so the readback survives below
     * only as a cheap early failure, and the wait is on this.
     *
     * The page's own counter is preferred over counting thumbnails, because it
     * is the page's arithmetic rather than ours and it survives however the
     * previews come to be rendered; the thumbnails are the fallback for a build
     * that drops the counter. Both are matched against the whole document on
     * purpose: the previews are siblings *above* #react-dropzone rather than
     * children of it, so there is no one container that reliably holds both,
     * and neither pattern is remotely ambiguous on this page.
     */
    attached_count() {
      const counted = /(\d+)\s*\/\s*\d+\s+images?\s+selected/i.exec(document.body.textContent || "");

      if (counted !== null) return Number(counted[1]);

      return document.querySelectorAll(app.SELECTORS.note_thumb).length;
    },

    /**
     * How many notes the list is showing. The empty state is not a note.
     */
    note_count() {
      const list = document.querySelector(app.SELECTORS.notes_list);

      if (list === null) return 0;

      return /no notes/i.test(list.textContent || "") ? 0 : list.children.length;
    },

    /**
     * Put photographs on the note, and prove the page took them.
     *
     * react-dropzone renders its own hidden `input[type=file]`, and setting
     * that plus a `change` event is the documented way in. The synthetic `drop`
     * is a fallback for a build that stops rendering the input — dropzone
     * listens for both.
     *
     * A file input's `files` cannot take an array; DataTransfer is the only way
     * to build a FileList.
     *
     * **Dispatching is not landing.** This used to return true the instant the
     * event went out, and post_note() clicked Save on the very next statement —
     * the same tick, before react-dropzone's onDrop (which awaits
     * getFilesFromEvent) had run at all. Four invoices went to Camelot on
     * 16 September 2026 with text-only notes, every one reported a success. So
     * what comes back now is the count the *page* admits to, read after a wait.
     *
     * @returns {Promise<number>} photographs the page is showing as attached.
     */
    async attach(files) {
      const transfer = new DataTransfer();

      for (const file of files) transfer.items.add(file);

      /* Re-queried here rather than carried in from earlier: this is a React
         page and the input may have been re-rendered in between. */
      const input = document.querySelector(app.SELECTORS.note_file_input);

      if (input !== null) {
        input.files = transfer.files;

        /* A FileList that did not even stick to the node is worth reporting now
           rather than after waiting out the whole budget to hear it. */
        if (input.files.length !== files.length) return 0;

        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const zone = document.querySelector(app.SELECTORS.note_dropzone);

        if (zone === null) return 0;

        zone.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }

      const seen = await app.wait_for(() => {
        const count = app.attached_count();

        return count >= files.length ? count : null;
      }, app.ATTACH_WAIT_MS);

      /* On a timeout, report what is actually there rather than zero: a partial
         attach and a total refusal are different failures and the caller says
         which. */
      return seen === null ? app.attached_count() : seen;
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

  /* Registered here rather than from init(), because init() waits for the page
     and a command does not. The service worker may probe, or hand this tab a
     delivery, before a heavy React page has finished settling; a listener that
     is not there yet is indistinguishable to the caller from a page that has no
     script on it at all. */
  chrome.runtime.onMessage.addListener(app.handle_message);

  /* Nothing awaits init(): it sends one fire-and-forget message and its
     failure mode is "the web app learns this URL a little later instead". */
  if (document.readyState === "complete") app.init();
  else window.addEventListener("load", () => app.init(), { once: true });
})();
