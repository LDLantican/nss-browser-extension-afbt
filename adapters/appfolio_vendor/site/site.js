/**
 * The pretend vendor portal's pages: renders the list, a work order, its notes
 * and its invoices from the books (portal.js), and behaves like AppFolio's when
 * its buttons are pressed — including the bits that make the real one awkward:
 * a list tab that shows a spinner before its rows, an Amount and Total
 * computed by the page, a Rate field that cuts to two decimals, Work Done as a
 * button and then a dialog.
 *
 * The markup and `js-*` hooks are the live portal's, read on 2026-10-16
 * (structure only). The books live in chrome.storage.local under
 * `?store=<key>` (or PORTAL_KEY), so a test never touches anybody else's.
 */

import {
  accept,
  amount_cents,
  by_id,
  empty_portal,
  path_of,
  PORTAL_KEY,
  save_note,
  submit_invoice,
  tab_of,
  total_cents,
  work_done,
} from "./portal.js";

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    key: PORTAL_KEY,
    tab: "in_progress",
    form: null,
    files: [],
    main: null,

    init() {
      app.key = new URLSearchParams(location.search).get("store") || PORTAL_KEY;
      app.main = document.querySelector("#property-content");

      window.addEventListener("hashchange", () => {
        app.form = null;
        app.files = [];
        app.render();
      });
      app.main.addEventListener("click", app.on_click);
      app.main.addEventListener("input", app.on_input);
      app.main.addEventListener("change", app.on_change);
      app.main.addEventListener("submit", (event) => event.preventDefault());

      app.render();
    },

    async load() {
      const { [app.key]: portal } = await chrome.storage.local.get(app.key);

      return portal || empty_portal();
    },

    async change(mutate) {
      const portal = await app.load();

      mutate(portal);
      await chrome.storage.local.set({ [app.key]: portal });
    },

    route() {
      const hash = location.hash.replace(/^#/, "") || "/";
      const match = /^\/(\d+)\/workOrders\/(\d+)(\/notes|\/invoices)?/.exec(hash);

      return match ? { kind: match[3] ? match[3].slice(1) : "work_order", id: match[2] } : { kind: "list", id: null };
    },

    async render() {
      const portal = await app.load();
      const here = app.route();

      if (portal.signed_in === false) {
        document.title = "Sign In";
        app.main.innerHTML = `<h1>Sign in</h1><input type="password" name="password">`;

        return;
      }

      document.title = "AppFolio Vendor Portal";

      if (here.kind === "list") return app.render_list(portal);

      const order = by_id(portal, here.id);

      if (!order) {
        app.main.innerHTML = "<p>Not found</p>";

        return;
      }

      if (here.kind === "notes") return app.render_notes(portal, order);
      if (here.kind === "invoices") return app.render_invoices(portal, order);

      return app.render_work_order(portal, order);
    },

    escape(text) {
      return String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    },

    display_number(order) {
      return order.number.replace("-", " - ");
    },

    header(portal, order, label = "") {
      return `<h1 class="page-title d-inline-block w-100 my-3 py-2"><span class="js-work-order-header-text">${label}Work Order #<span class="js-work-order-number-display me-2">${app.escape(app.display_number(order))} | ${app.escape(portal.company)}</span></span><span class="js-work-order-status badge bg-primary">${app.escape(order.status)}</span></h1>`;
    },

    money(cents) {
      return (cents / 100).toFixed(2);
    },

    // -- The list -------------------------------------------------------------

    async render_list(portal) {
      const tabs = { estimates: ["js-nav-estimated", "Estimates"], in_progress: ["js-nav-in-progress", "In Progress"], completed: ["js-nav-completed", "Completed"] };
      const nav = Object.entries(tabs)
        .map(([name, [cls, label]]) => `<li class="${cls} nav-item"><a href="#" class="nav-link${app.tab === name ? " active" : ""}" data-tab="${name}">${label}</a></li>`)
        .join("");

      /* The skeleton shows the tab active before any rows arrive, as the real one does. */
      app.main.innerHTML = `<ul class="nav nav-tabs">${nav}</ul><div role="status" aria-label="loading" class="gears-spinner">Loading…</div>`;
      await new Promise((resolve) => setTimeout(resolve, 150));

      const rows = Object.values(portal.orders)
        .filter((order) => tab_of(order.status) === app.tab)
        .map(
          (order) => `<a href="${path_of(order)}"><div class="mb-3 card"><div class="d-flex flex-wrap align-items-center justify-content-between card-header"><div><h2 class="m-0 my-1 me-auto card-title">#${app.escape(app.display_number(order))}, ${app.escape(portal.company)}</h2></div><div class="d-inline-flex"><span class="text-muted me-2 js-display-date-string">Created today</span><div><span class="js-summary-status badge bg-primary">${app.escape(order.status)}</span></div></div></div><div class="collapse show"><div class="card-body"><div>${app.escape(order.description)}</div></div></div></div></a>`,
        )
        .join("");

      app.main.innerHTML = `<ul class="nav nav-tabs">${nav}</ul><div class="js-work-orders">${rows}</div><button type="button" class="js-clear-filters btn" disabled>Clear Filters</button>`;
    },

    // -- A work order ---------------------------------------------------------

    render_work_order(portal, order) {
      const limit = order.limit_cents === null ? "Not specified" : `$${app.money(order.limit_cents)}`;
      const pending =
        order.status === "Accept/Reject"
          ? `<div class="work-order-pending-actions_wrap__96dbW"><button type="button" class="btn btn-success" data-action="accept">Accept</button><button type="button" class="btn btn-danger">Decline</button></div>`
          : "";

      app.main.innerHTML = `${app.header(portal, order)}${pending}
        <div class="js-datapair text-break form-group row mb-3"><label class="col-form-label">Priority</label><div class="col-12"><div class="form-control-plaintext">Normal</div></div></div>
        <div class="js-datapair text-break js-maintenance-limit form-group row mb-3"><label class="col-form-label">Maintenance Limit</label><div class="col-12"><div class="form-control-plaintext">${limit}</div></div></div>
        <div class="js-datapair text-break form-group row mb-3"><label class="col-form-label">Description</label><div class="col-12"><p>${app.escape(order.description)}</p></div></div>
        <div class="g-0 row">
          <div class="me-1 col"><a href="#${path_of(order)}/notes"><button class="js-notes-button btn btn-primary btn-lg"><div>Notes</div></button></a></div>
          <div class="ms-1 col"><a href="#${path_of(order)}/invoices"><button class="js-invoices-button btn btn-primary btn-lg"><div class="js-invoice-name">Invoices</div></button></a></div>
        </div>
        <div class="js-work-done-button"><button type="button" class="js-done-button btn btn-primary btn-lg" data-action="done"><div>Work Done</div></button></div>`;
    },

    // -- Notes ----------------------------------------------------------------

    render_notes(portal, order) {
      const notes = order.notes.length
        ? order.notes
            .map((note) => `<div class="js-note mb-3 card"><div class="card-header"><span class="js-note-header__date">Today</span></div><div class="card-body"><p class="card-text" style="white-space: pre-line">Note for Work Order #${app.escape(order.number)}\nPosted by: Alabama Signature Homes LLC\n\n${app.escape(note.body)}</p>${note.photos ? '<div class="js-image-toggle my-2"><a>View Image</a></div>' : ""}</div></div>`)
            .join("")
        : `<span class="text-center">No Notes</span>`;

      app.main.innerHTML = `<div class="js-notes">${app.header(portal, order, "Notes | ")}
        <div class="js-notes-form"><div class="js-preview"></div><form>
          <div id="react-dropzone"><b>Drag Images Here</b><button type="button" class="js-no-autofocus btn btn-secondary">Choose Photos to Add</button><input type="file" tabindex="-1" name="file-input-field" multiple></div>
          <div class="form-group"><label>Add Note</label><textarea name="body" class="js-note-field form-control"></textarea></div>
          <button type="submit" class="js-notes-form-save btn btn-primary btn-lg" data-action="save_note">Save Note</button>
          <button type="button" class="js-notes-form-cancel btn btn-secondary btn-lg">Cancel</button>
        </form></div>
        <div class="js-notes-list mt-5">${notes}</div></div>`;
    },

    show_preview() {
      const preview = app.main.querySelector(".js-preview");
      const shown = app.files.slice(0, 10);

      preview.innerHTML = shown.length
        ? `<div class="photo-preview_photo-wrap__Ww5y6">${shown.map(() => `<img alt="selected">`).join("")}<div class="mb-2 text-start">${shown.length}/10 images selected</div></div>`
        : "";
    },

    // -- Invoices -------------------------------------------------------------

    render_invoices(portal, order) {
      const limit = order.limit_cents === null ? "" : `<div class="js-invoices-maintenance-limit-alert alert alert-warning" role="alert">This property has a maintenance limit of $${app.money(order.limit_cents)}</div>`;
      const submitted = order.invoices.length
        ? `<table class="table"><thead><tr><th>Invoice</th><th>Date Uploaded</th><th>Actions</th></tr></thead><tbody>${order.invoices
            .map((invoice) => `<tr><td><a class="js-attachment-link" href="#">${invoice.file}</a></td><td>today</td><td><a class="js-attachment-download-link" href="#">Download</a></td></tr>`)
            .join("")}</tbody></table>`
        : `<p>An invoice has not been uploaded for this work order</p>`;

      app.main.innerHTML = `<div class="js-invoices">${app.header(portal, order, "Invoices | ")}${limit}
        <div class="mb-4 card"><div class="card-header"><h2 class="card-title">Submitted Invoices</h2></div><div class="card-body">${submitted}</div></div>
        <div class="mb-4 card"><div class="card-header"><h2 class="card-title">Job Details</h2></div><div class="card-body"><div class="text-muted">Description</div><div class="js-detail-description">${app.escape(order.description)}</div></div></div>
        <div class="mb-4 card"><div class="card-header"><h2 class="card-title">Submit New Invoice</h2></div><div class="card-body js-invoice-area">${app.form ? app.form_html() : `<button type="button" class="js-create-invoice-btn btn btn-secondary btn-lg" data-action="create"> Create Invoice</button>`}</div></div>
      </div>`;
    },

    form_html() {
      const rows = app.form
        .map(
          (row, i) => `<div class="mb-4 gx-0 row" data-row="${i}"><div class="col"><div class="row">
            <div class="col-md-6"><label>Description</label><input placeholder="Materials/Hours" type="text" class="js-description-field form-control" value="${app.escape(row.description)}"></div>
            <div class="col-md-2"><label>Quantity</label><input inputmode="decimal" step="0.01" placeholder="1" type="number" class="js-quantity-field form-control" value="${app.escape(row.quantity)}"></div>
            <div class="col-md-2"><label>Rate</label><div class="js-rate-field input-group"><span class="input-group-text">$</span><input inputmode="decimal" placeholder="0.00" class="form-control" value="${app.escape(row.rate)}"></div></div>
            <div class="col-md-2"><label>Amount</label><div class="js-amount-field input-group"><span class="input-group-text">$</span><input placeholder="$0.00" disabled class="form-control" value="${app.money(amount_cents(row.quantity || "0", row.rate || "0") ?? 0)}"></div></div>
          </div></div>${app.form.length > 1 ? `<div class="js-delete-col ps-3 d-flex col-auto"><button type="button" class="btn btn-outline-danger" aria-label="Delete" data-action="delete" data-row="${i}">×</button></div>` : ""}</div>`,
        )
        .join("");
      const total = total_cents(app.form.map((row) => ({ quantity: row.quantity || "0", rate: row.rate || "0" }))) ?? 0;

      return `<div class="mt-4">${rows}</div>
        <button type="button" class="border-0 invoiceform_add-row-border__Gv96I btn btn-outline-success d-block w-100" data-action="add"><span>Add Line Item</span></button>
        <div class="my-4 row"><div class="col-5 offset-7"><hr><div class="text-muted">Total</div><div class="text-end"><div class="input-group"><span class="input-group-text">$</span><input disabled class="form-control js-total" value="${app.money(total)}"></div></div></div></div>
        <div role="toolbar" class="btn-toolbar"><button type="button" class="mr-2 btn btn-primary btn-lg" data-action="submit">Submit Invoice</button><button type="button" class="btn btn-secondary btn-lg" data-action="cancel">Cancel</button></div>`;
    },

    /** The page's own arithmetic, redrawn in place so a field being typed into keeps its node. */
    recompute() {
      const area = app.main.querySelector(".js-invoice-area");

      if (!area || !app.form) return;

      area.querySelectorAll("[data-row]").forEach((row) => {
        const line = app.form[Number(row.dataset.row)];
        const amount = row.querySelector(".js-amount-field input");

        if (line && amount) amount.value = app.money(amount_cents(line.quantity || "0", line.rate || "0") ?? 0);
      });

      area.querySelector(".js-total").value = app.money(total_cents(app.form.map((row) => ({ quantity: row.quantity || "0", rate: row.rate || "0" }))) ?? 0);
    },

    // -- What the buttons do --------------------------------------------------

    async on_click(event) {
      const tab = event.target.closest("[data-tab]");

      if (tab) {
        event.preventDefault();
        app.tab = tab.dataset.tab;

        return app.render();
      }

      const button = event.target.closest("[data-action]");

      if (!button) return undefined;

      const here = app.route();

      switch (button.dataset.action) {
        case "accept":
          await app.change((portal) => accept(portal, here.id));

          return app.render();

        case "done": {
          const dialog = document.createElement("div");

          dialog.className = "modal show";
          dialog.setAttribute("role", "dialog");
          dialog.innerHTML = `<div class="modal-body">Submit this Work Order as Done?</div><button type="button" id="work-order-modal-yes-button" class="btn btn-primary">Yes</button>`;
          dialog.querySelector("button").addEventListener("click", async () => {
            dialog.remove();
            await app.change((portal) => work_done(portal, here.id));
            app.render();
          });
          document.body.append(dialog);

          return undefined;
        }

        case "save_note": {
          const body = app.main.querySelector(".js-note-field").value;
          const photos = Math.min(10, app.files.length);

          await app.change((portal) => save_note(portal, here.id, body, photos));
          app.files = [];

          return app.render();
        }

        case "create":
          app.form = [{ description: "", quantity: "", rate: "" }];

          return app.render();

        case "add":
          app.form.push({ description: "", quantity: "", rate: "" });

          return app.render();

        case "delete":
          app.form.splice(Number(button.dataset.row), 1);

          return app.render();

        case "cancel":
          app.form = null;

          return app.render();

        case "submit": {
          const lines = app.form.map(({ description, quantity, rate }) => ({ description, quantity, rate }));

          await app.change((portal) => submit_invoice(portal, here.id, lines));
          app.form = null;

          return app.render();
        }

        default:
          return undefined;
      }
    },

    on_input(event) {
      const row = event.target.closest("[data-row]");

      if (!row || !app.form) return;

      const line = app.form[Number(row.dataset.row)];

      if (event.target.matches(".js-description-field")) line.description = event.target.value;
      if (event.target.matches(".js-quantity-field")) line.quantity = event.target.value;

      if (event.target.closest(".js-rate-field")) {
        /* AppFolio's Rate keeps two decimals and drops the rest. */
        const cut = /^(\d*)(\.\d{0,2})?/.exec(event.target.value)?.[0] ?? "";

        if (cut !== event.target.value) event.target.value = cut;
        line.rate = cut;
      }

      app.recompute();
    },

    on_change(event) {
      if (!event.target.matches("input[name='file-input-field']")) return;

      app.files = [...event.target.files];
      app.show_preview();
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
});
