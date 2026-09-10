/**
 * Filling in an AppFolio vendor work order: notes, then the invoice, then done.
 *
 * The web app decides what is billed and what the figures are. This script
 * types them, checks the total AppFolio worked out against the total it was
 * told to expect, and reports back. It computes no money of its own.
 *
 * ## It is keyed on labels, not on class names
 *
 * Every control is found by the text AppFolio's own Vendor Portal guide names —
 * "Invoices", "Add Another Item", "Save Invoice", "Notes", "Add Photos to this
 * Note", "Save Note", "Work Done" — and the invoice fields by their labels,
 * "Description", "Quantity" and "Rate".
 *
 * That is a deliberate choice over CSS selectors, and it is the opposite of
 * what content/buildertrend_add_job.js does. Buildertrend's markup was learned
 * from the live page, so it uses `[data-testid]` hooks that are stable *because
 * somebody checked*. Nothing here has been checked against a live vendor
 * portal yet, and inventing class names would produce a script that looks
 * finished and silently matches nothing. Labels are the part of that page that
 * is documented, so labels are what this trusts.
 *
 * **When somebody does check it against a real page**, the thing to look at is
 * LABELS below. Nothing else should need to change.
 *
 * ## It fails closed, always
 *
 * Every step that cannot find what it needs stops and reports why. Nothing is
 * ever half-filled and submitted, and nothing is submitted whose total does not
 * match to the cent. A wrong invoice reaching Camelot is far more expensive
 * than a job sitting in the queue, so every ambiguity resolves toward stopping.
 *
 * ## The one irreversible moment
 *
 * Pressing Save Invoice bills Camelot. Before it is pressed, the worker is told
 * — and if the worker does not answer yes, nothing is pressed. That is what
 * lets a browser that dies mid-run be recovered without risking a second
 * invoice. See background/delivery.js.
 *
 * ## The typing bug next door is not repeated here
 *
 * buildertrend_add_job.js does `input.value += char`, which React's value
 * tracker does not see, so a controlled field can revert after it looks filled.
 * It is documented as unfixed there because Buildertrend may be retired.
 * set_value() below goes through the native value setter instead, which is the
 * fix, and this file must keep doing so.
 */

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    /**
     * Every piece of text this script looks for.
     *
     * The one place to correct against a real page. Each is matched
     * case-insensitively against trimmed element text, and the field labels are
     * matched as a prefix so "Rate" finds "Rate ($)".
     */
    LABELS: {
      invoices: "invoices",
      add_item: "add another item",
      save_invoice: "save invoice",
      notes: "notes",
      add_note_photos: "add photos to this note",
      save_note: "save note",
      work_done: "work done",
      description: "description",
      quantity: "quantity",
      rate: "rate",
    },

    /** AppFolio's own limit: ten photographs per note. */
    PHOTOS_PER_NOTE: 10,

    /** How long any one control may take to appear after a click. */
    WAIT_MS: 15000,

    state: null,

    init() {
      app.state = app.read_state();

      /* Remembered whenever a human is on a vendor work order, which is the
         only moment the web app can learn this page's address. Fire and
         forget: nothing depends on it, it only makes delivery quicker. */
      const number = app.page_number();

      if (app.state === "ready" && number !== "")
        chrome.runtime.sendMessage({
          type: "VENDOR_PAGE_SEEN",
          payload: { number, url: location.href },
        });

      chrome.runtime.onMessage.addListener(app.handle_message);
    },

    handle_message(message, _sender, respond) {
      if (message?.type === "VENDOR_PAGE_STATUS") {
        respond({ state: app.read_state() });

        return false;
      }

      if (message?.type === "VENDOR_PAGE_PROBE") {
        respond(app.probe());

        return false;
      }

      if (message?.type === "DELIVER_WORK_ORDER") {
        app
          .deliver(message.payload || {})
          .then((result) => respond(result))
          .catch((error) =>
            respond({ state: "failed", error: error?.message || "Delivery stopped unexpectedly." }),
          );

        return true;
      }

      return false;
    },

    /**
     * What this page has, without touching any of it.
     *
     * The cheapest possible answer to the only open question: are the labels in
     * LABELS the labels this page actually uses. It clicks nothing, types
     * nothing and submits nothing, so it can be run against a live client's
     * work order with no consequence at all — which matters, because ASH has no
     * AppFolio sandbox and the alternative to a passive check is finding out by
     * submitting something.
     *
     * The three invoice fields are reported separately and will read false
     * until the Invoices panel is open, because they do not exist before then.
     * That is what `hint` says.
     */
    probe() {
      const controls = {};

      for (const key of ["invoices", "add_item", "save_invoice", "notes", "add_note_photos", "save_note", "work_done"])
        controls[key] = app.find_control(app.LABELS[key]) !== null;

      const fields = {};

      for (const key of ["description", "quantity", "rate"]) {
        fields[key] = false;

        for (const field of document.querySelectorAll("input, textarea"))
          if (app.label_of(field) === app.LABELS[key]) fields[key] = true;
      }

      return {
        state: app.read_state(),
        url: location.href,
        title: document.title || "",
        number: app.page_number(),
        controls,
        fields,
        item_rows: (app.item_rows(1) || []).length,
        file_inputs: document.querySelectorAll("input[type='file']").length,
        textareas: document.querySelectorAll("textarea").length,
        hint:
          controls.invoices && !fields.rate
            ? "Click the Invoices button, then check again — the item fields do not exist until that panel is open."
            : "",
      };
    },

    /**
     * Whether this page can be worked on.
     *
     * Signed-out is checked first and by the presence of a password field,
     * which is the same signal buildertrend_add_job.js uses — it is the one
     * thing a sign-in page always has and a work order never does.
     */
    read_state() {
      if (document.querySelector("input[type='password']")) return "signed_out";
      if (/sign in|log in/i.test(document.title || "")) return "signed_out";

      return "ready";
    },

    /** The work-order number on this page, in AppFolio's `2737-1` shape. */
    page_number() {
      const match = (document.body?.innerText || "").match(/\b\d+-\d+\b/);

      return match ? match[0] : "";
    },

    /**
     * One work order, in the order that makes a failure cheapest.
     *
     * Photographs first. If the invoice then fails, a retry re-posts the notes
     * and Camelot sees a duplicate set of photographs — visible, harmless, and
     * fixable. The other order is worse: an invoice that succeeded followed by
     * photographs that failed has to be reported as delivered, because the
     * money did go, and the missing photographs would then be invisible.
     *
     * The invoice is last but one, closest to the point of no return, and Work
     * Done follows it because a submitted invoice with the job still open is a
     * job Camelot has no reason to look at.
     */
    async deliver(job) {
      const items = job?.invoice?.items || [];

      if (items.length === 0)
        return { state: "failed", error: "The web app sent no invoice items." };

      /* The page has to be the right work order. Delivering the wrong job's
         figures is the one mistake worse than delivering none. */
      const on_page = app.page_number();

      if (on_page !== "" && job.number && on_page !== job.number)
        return {
          state: "failed",
          error: `This page is work order ${on_page}, not ${job.number}.`,
        };

      /* A rehearsal writes nothing anywhere, and posting a note is a write.
         Skipped rather than faked: there is nothing useful to learn from
         pretending to upload a photograph. */
      if (job.dry_run !== true) {
        const photos = await app.post_photos(job.photos || []);

        if (photos.error) return { state: "failed", error: photos.error };
      }

      return app.post_invoice(job);
    },

    /**
     * The photographs, as notes of ten.
     *
     * Notes rather than invoice attachments: "Add Photos to this Note" is the
     * purpose-built photograph channel and it is what a client looks at for
     * proof of work. Invoice attachments are meant for documents.
     *
     * Ten per note is AppFolio's limit, so twenty-five photographs is three
     * notes. Each note is saved before the next begins, because a half-filled
     * note left open would be picked up by the invoice step's own waits.
     */
    async post_photos(photos) {
      if (photos.length === 0) return { posted: 0 };

      const batches = [];

      for (let index = 0; index < photos.length; index += app.PHOTOS_PER_NOTE)
        batches.push(photos.slice(index, index + app.PHOTOS_PER_NOTE));

      for (const [index, batch] of batches.entries()) {
        const files = [];

        for (const photo of batch) {
          const file = await app.fetch_photo(photo);

          /* A photograph that will not download is not a reason to abandon a
             correct invoice. It is recorded and the rest go on. */
          if (file !== null) files.push(file);
        }

        if (files.length === 0) continue;

        const label =
          batches.length === 1
            ? "Photos of the completed work."
            : `Photos of the completed work (${index + 1} of ${batches.length}).`;

        const posted = await app.post_one_note(label, files);

        if (posted.error) return { error: posted.error };
      }

      return { posted: photos.length };
    },

    async post_one_note(message, files) {
      const notes = app.find_control(app.LABELS.notes);

      if (notes === null) return { error: "Could not find the Notes button on the work order." };

      notes.click();

      const box = await app.wait_for(() => app.find_note_field());

      if (box === null) return { error: "The note box did not appear after clicking Notes." };

      app.set_value(box, message);

      const input = await app.wait_for(() => app.find_file_input());

      if (input === null)
        return { error: "Could not find the photo upload control on the note." };

      app.attach(input, files);

      const save = app.find_control(app.LABELS.save_note);

      if (save === null) return { error: "Could not find the Save Note button." };

      save.click();

      /* Waited for rather than assumed: the invoice step clicks its own button
         next, and doing that while a note is still saving is how two dialogs
         end up open at once. */
      await app.wait_for(() => (app.find_note_field() === null ? true : null));

      return { saved: true };
    },

    /**
     * The invoice: one row per line, then check, then submit.
     *
     * The check is the part that matters. AppFolio multiplies Quantity by Rate
     * itself, and the web app has already worked out what it will arrive at —
     * so the two are compared to the cent, and a disagreement stops everything.
     * That catches a mistyped field, a row that silently reverted, and a page
     * whose arithmetic is not what we think it is, which are exactly the
     * failures that would otherwise reach the client as a wrong bill.
     */
    async post_invoice(job) {
      const invoices = app.find_control(app.LABELS.invoices);

      if (invoices === null)
        return { state: "failed", error: "Could not find the Invoices button on the work order." };

      invoices.click();

      const items = job.invoice.items;
      let rows = await app.wait_for(() => app.item_rows(items.length));

      if (rows === null)
        return { state: "failed", error: "The invoice item fields did not appear." };

      /* Rows are added first and filled afterwards. Filling as we go would mean
         re-finding every earlier row after each click, and a page that
         re-renders its list would hand back stale nodes. */
      for (let index = rows.length; index < items.length; index++) {
        const add = app.find_control(app.LABELS.add_item);

        if (add === null)
          return {
            state: "failed",
            error: `This invoice needs ${items.length} items and the Add Another Item button could not be found.`,
          };

        add.click();

        rows = await app.wait_for(() => app.item_rows(index + 1));

        if (rows === null)
          return { state: "failed", error: "An invoice item row did not appear after adding it." };
      }

      if (rows.length < items.length)
        return {
          state: "failed",
          error: `The invoice has ${rows.length} item rows and needs ${items.length}.`,
        };

      for (const [index, item] of items.entries()) {
        const row = rows[index];
        const filled = app.fill_item(row, item);

        if (filled !== true) return { state: "failed", error: filled };
      }

      /* Read back from the page, not from what we typed. The point is to catch
         a field that did not take the value. */
      const shown = await app.wait_for(() => app.invoice_total(job.invoice.expected_total_cents));

      if (shown === null)
        return {
          state: "failed",
          error:
            "Could not read the invoice total back off the page, so it was not submitted. "
            + `It should have come to ${job.invoice.expected_total}.`,
        };

      if (shown !== job.invoice.expected_total_cents)
        return {
          state: "failed",
          error:
            `AppFolio totalled this at ${app.dollars(shown)} and it should be `
            + `${job.invoice.expected_total}. Nothing was submitted.`,
        };

      /* The rehearsal ends here, having proved the only things a rehearsal can
         prove: that every control was found, that the fields took their values,
         and that AppFolio's own arithmetic agrees with ours to the cent. It
         reports `dry_run`, which the worker turns into a release rather than a
         result — nothing happened to an invoice, so there is nothing to
         record. */
      if (job.dry_run === true)
        return {
          state: "dry_run",
          read_back: app.dollars(shown),
          found: { controls: true, fields: true, total_matched: true },
        };

      if (job.auto_submit === false)
        return {
          state: "failed",
          error:
            "Filled in and checked, but automatic submitting is switched off. "
            + "Press Save Invoice on the vendor page.",
        };

      const save = app.find_control(app.LABELS.save_invoice);

      if (save === null)
        return { state: "failed", error: "Could not find the Save Invoice button." };

      /* The point of no return. The worker records it before the click, so a
         browser that dies now leaves a row that says "may already be billed"
         rather than one that gets retried into a second invoice. */
      const permitted = await app.ask_to_submit(job.delivery_id);

      if (permitted !== true)
        return {
          state: "failed",
          error: permitted || "The web app did not confirm it was safe to submit.",
        };

      save.click();

      /* Everything from here reports `unconfirmed` on failure, never `failed`.
         Save has been pressed; nobody on this side can know whether it took. */
      const gone = await app.wait_for(() => (app.find_control(app.LABELS.save_invoice) === null ? true : null));

      if (gone === null)
        return {
          state: "unconfirmed",
          error: "Save Invoice was pressed and the form did not close. Check AppFolio before retrying.",
        };

      await app.mark_work_done();

      return { state: "delivered", external_ref: app.invoice_reference() };
    },

    /**
     * Move the job to Work Done.
     *
     * After the invoice and deliberately not reported as a failure if it does
     * not happen: the money is the delivery, and a job left In Progress with a
     * correct invoice on it is a tidiness problem. Reporting it as failed would
     * invite a retry, and the retry would submit the invoice again.
     */
    async mark_work_done() {
      const button = app.find_control(app.LABELS.work_done);

      if (button === null) return false;

      button.click();

      return true;
    },

    /** Whatever AppFolio called the invoice, if the page says. */
    invoice_reference() {
      const match = (document.body?.innerText || "").match(/invoice\s*#?\s*([A-Za-z0-9-]{2,32})/i);

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

    /* ---- the DOM, and nothing above this line touches it directly -------- */

    /**
     * A clickable thing whose text is this label.
     *
     * Buttons and links and anything wearing role="button", because a page may
     * use any of the three for the same affordance. Exact match on the trimmed
     * lowercased text first, so "Notes" does not find "Notes and photos", then
     * nothing — a near miss here should fail rather than click the wrong
     * control.
     */
    find_control(label) {
      const candidates = document.querySelectorAll(
        "button, a[href], [role='button'], input[type='submit'], input[type='button']",
      );

      for (const element of candidates) {
        if (!app.visible(element)) continue;

        const text = (element.innerText || element.value || element.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase();

        if (text === label) return element;
      }

      return null;
    },

    /** The note's message box. A textarea, since a note is prose. */
    find_note_field() {
      const boxes = document.querySelectorAll("textarea");

      for (const box of boxes) if (app.visible(box)) return box;

      return null;
    },

    find_file_input() {
      const inputs = document.querySelectorAll("input[type='file']");

      /* Not filtered on visibility: a styled upload control is almost always a
         hidden input behind a labelled button, so requiring it to be visible
         would reject the ordinary case. */
      return inputs.length > 0 ? inputs[inputs.length - 1] : null;
    },

    /**
     * The invoice's item rows, or null until there are at least this many.
     *
     * A row is whatever element contains all three of the fields, found by
     * walking up from the Description input until an ancestor also holds a
     * Quantity and a Rate. That is more robust than naming a container class,
     * and it is the only structural assumption in this file: that the three
     * fields for one item share an ancestor.
     */
    item_rows(at_least) {
      const rows = [];

      for (const field of document.querySelectorAll("input, textarea")) {
        if (!app.visible(field)) continue;
        if (app.label_of(field) !== app.LABELS.description) continue;

        const row = app.row_of(field);

        if (row !== null && !rows.includes(row)) rows.push(row);
      }

      return rows.length >= at_least ? rows : null;
    },

    row_of(field) {
      let node = field.parentElement;

      for (let depth = 0; depth < 8 && node !== null; depth++) {
        const has_quantity = app.field_in(node, app.LABELS.quantity) !== null;
        const has_rate = app.field_in(node, app.LABELS.rate) !== null;

        if (has_quantity && has_rate) return node;

        node = node.parentElement;
      }

      return null;
    },

    fill_item(row, item) {
      const description = app.field_in(row, app.LABELS.description);
      const quantity = app.field_in(row, app.LABELS.quantity);
      const rate = app.field_in(row, app.LABELS.rate);

      if (description === null) return "An invoice item had no Description field.";
      if (quantity === null) return "An invoice item had no Quantity field.";
      if (rate === null) return "An invoice item had no Rate field.";

      app.set_value(description, item.description);
      app.set_value(quantity, item.quantity);
      app.set_value(rate, item.rate);

      return true;
    },

    /** A labelled field inside this element, matched on the label's prefix. */
    field_in(root, label) {
      for (const field of root.querySelectorAll("input, textarea")) {
        if (field.type === "file" || field.type === "hidden") continue;
        if (app.label_of(field) === label) return field;
      }

      return null;
    },

    /**
     * What a field is called, reduced to one of the labels we look for.
     *
     * Four sources, in the order they are worth trusting: an explicit <label>,
     * aria-label, the placeholder, then the name attribute. A page will use one
     * of them and it is not worth guessing which.
     */
    label_of(field) {
      const sources = [];

      if (field.id !== "") {
        const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) sources.push(label.innerText);
      }

      const wrapping = field.closest("label");
      if (wrapping) sources.push(wrapping.innerText);

      sources.push(field.getAttribute("aria-label") || "");
      sources.push(field.getAttribute("placeholder") || "");
      sources.push(field.getAttribute("name") || "");

      for (const source of sources) {
        const text = String(source).trim().toLowerCase();

        if (text === "") continue;

        for (const label of [app.LABELS.description, app.LABELS.quantity, app.LABELS.rate])
          if (text.startsWith(label)) return label;
      }

      return "";
    },

    /**
     * The invoice total AppFolio has worked out, in cents.
     *
     * Found by looking for the expected figure rather than by naming a total
     * element, which sounds backwards and is the right way round: this is a
     * *verification*, and the question being asked is "does the page anywhere
     * show the number we predicted". A page that shows it is the page that
     * agrees. When it is nowhere to be found the caller stops and says so,
     * rather than submitting.
     *
     * The fallback scan exists so a mismatch can be *reported* with the figure
     * the page actually shows, which is what makes the error message useful.
     */
    invoice_total(expected_cents) {
      const text = document.body?.innerText || "";
      const wanted = app.dollars(expected_cents);

      if (text.includes(wanted)) return expected_cents;

      /* Every money-looking figure on the page, largest first: an invoice's
         total is its biggest number in every layout worth worrying about. */
      const figures = [];

      for (const match of text.matchAll(/\$\s?\d[\d,]*\.\d{2}/g)) {
        const cents = app.to_cents(match[0]);

        if (cents !== null) figures.push(cents);
      }

      if (figures.length === 0) return null;

      return Math.max(...figures);
    },

    /**
     * "$1,234.56" to 123456. Null when it is not money.
     *
     * Integer arithmetic, deliberately: the web app's App\Support\Money does
     * the same, and a check that parsed money as a float would be a check that
     * disagrees with the thing it is checking.
     */
    to_cents(text) {
      const clean = String(text).replace(/[^0-9.-]/g, "");

      if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;

      const negative = clean.startsWith("-");
      const [whole, fraction = ""] = clean.replace("-", "").split(".");
      const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));

      return negative ? -cents : cents;
    },

    dollars(cents) {
      const absolute = Math.abs(cents);
      const whole = Math.floor(absolute / 100).toLocaleString("en-US");
      const remainder = String(absolute % 100).padStart(2, "0");

      return `${cents < 0 ? "-" : ""}$${whole}.${remainder}`;
    },

    /**
     * Set a field's value so a framework notices.
     *
     * Through the native value setter, then an input and a change event. This
     * is the fix for the bug documented as unfixed in
     * content/buildertrend_add_job.js: assigning `element.value` directly (or
     * appending to it character by character) bypasses React's value tracker,
     * which then believes the field never changed and reverts it on the next
     * render. The field looks filled, the form submits something else.
     */
    set_value(element, value) {
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
     * Put files on a file input.
     *
     * A file input's `files` cannot be assigned a plain array — it takes a
     * FileList, and DataTransfer is the only way to build one.
     */
    attach(input, files) {
      const transfer = new DataTransfer();

      for (const file of files) transfer.items.add(file);

      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },

    /**
     * A photograph, as a File.
     *
     * The bytes come from the service worker, because a fetch from here would
     * be *this page's* request and would meet CORS — the reason every network
     * call in this extension lives in the worker. They arrive base64'd, since a
     * Blob cannot cross chrome.runtime.sendMessage, and are decoded here rather
     * than fetched as a data: URL so the page's own CSP has no say in it.
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

    visible(element) {
      if (element.disabled === true) return false;
      if (element.hidden === true) return false;

      const box = element.getBoundingClientRect();

      return box.width > 0 && box.height > 0;
    },

    /**
     * Poll until the callback returns something other than null.
     *
     * A MutationObserver would be the fashionable answer and is worse here: the
     * things being waited for are a dialog opening and a list growing, both of
     * which produce dozens of mutations, and the observer would have to
     * re-evaluate the condition on each one anyway. Polling evaluates it on a
     * schedule and cannot be starved by a chatty page.
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
