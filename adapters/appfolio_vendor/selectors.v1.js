/**
 * Everything the appfolio_vendor adapter knows about AppFolio's vendor portal
 * pages (ADR-008). The only file that does: a change here is a change in what
 * the adapter can see, so it bumps the adapter's version in manifest.js, which
 * is what lets the web app kill one version and not the other.
 *
 * Read off the live portal on 2026-10-16, structure only, and checked against
 * the hooks legacy's content/appfolio_vendor_invoice.js verified in September.
 * The portal is a React app with no `data-testid` anywhere; AppFolio's own
 * `js-*` classes are the hooks, and the few things without one (Accept, Add
 * Line Item, Submit Invoice, the Total) are found by their words, which live
 * here too. A build-hashed CSS-module class is only ever matched by prefix.
 *
 * A classic script, not a module: content scripts cannot `import`, so this
 * sets `globalThis.ash_vendor.SELECTORS` and page.js, listed after it in the
 * manifest, reads it.
 */

(() => {
  const vendor = (globalThis.ash_vendor = globalThis.ash_vendor || {});

  vendor.SELECTORS = {
    /* Loading and signed in. */
    loading: "[role='status'][aria-label='loading'], .gears-spinner",
    portal: ".js-navbar, .js-universal-search",
    password: "input[type='password']",

    /* The list (`/`): three tabs, each <li class="js-nav-…"><a class="nav-link">. */
    list: ".js-work-orders",
    list_row: ".js-work-orders a[href*='/workOrders/']",
    row_title: "h2.card-title",
    row_status: ".js-summary-status",
    clear_filters: "button.js-clear-filters",
    tabs: {
      in_progress: ".js-nav-in-progress a",
      completed: ".js-nav-completed a",
      estimates: ".js-nav-estimated a",
    },

    /* Every work-order page (detail, notes, invoices) has this header. */
    number: ".js-work-order-number-display",
    status: ".js-work-order-status",

    /* The detail page. */
    datapair: ".js-datapair",
    datapair_label: "label",
    maintenance_limit: ".js-maintenance-limit",
    pending_actions: "[class*='work-order-pending-actions']",
    accept_button: "button.btn-success",
    done_button: "button.js-done-button",
    dialog: ".modal, [role='dialog']",
    dialog_yes: "#work-order-modal-yes-button",

    /* Notes (`…/notes`). */
    notes_page: ".js-notes",
    note_field: "textarea.js-note-field",
    file_input: "#react-dropzone input[name='file-input-field']",
    selected_photo: "img[alt='selected']",
    note_save: "button.js-notes-form-save",
    notes_list: ".js-notes-list",
    note: ".js-note",
    note_body: ".card-text",
    /* A saved note shows its photographs behind a "View Image" toggle, not as <img>. */
    note_image: ".js-image-toggle, img",

    /* Invoices (`…/invoices`). */
    invoices_page: ".js-invoices",
    limit_alert: ".js-invoices-maintenance-limit-alert",
    invoice_file: "a.js-attachment-link",
    detail_description: ".js-detail-description",
    create_invoice: "button.js-create-invoice-btn",
    /* A line is `<div class="mb-4 gx-0 row">`: its fields in one column, its
       Delete button in the next. The inner `.row` holds only the fields. */
    line_row: ".gx-0.row",
    line_description: "input.js-description-field",
    line_quantity: "input.js-quantity-field",
    line_rate: ".js-rate-field input",
    line_amount: ".js-amount-field input",
    line_delete: ".js-delete-col button",
    total_label: "div.text-muted",
    total_input: "input[disabled]",
    toolbar_button: "div[role='toolbar'] button",
  };

  vendor.TEXT = {
    signed_out_title: /sign in|log in/i,
    number: /(\d+)\s*-\s*(\d+)/,
    path: /^(\/(\d+)\/workOrders\/(\d+))/,
    accept_status: /accept/i,
    accept_button: /^accept$/i,
    description_label: /^description$/i,
    limit: /maintenance limit of\s*\$?\s*([\d,]+\.\d{2})/i,
    money: /\$?\s*([\d,]+\.\d{2})/,
    selected: /(\d+)\s*\/\s*\d+\s+images?\s+selected/i,
    no_notes: /^no notes$/i,
    no_invoice: /an invoice has not been uploaded for this work order/i,
    /* An uploaded PDF is listed as `Billable_Item_51234.pdf`; one made with the
       form as `Billable_Item_invoice_19576-1-890.pdf` (live, 2026-10-16). The
       number is whatever sits between. */
    billable: /Billable_Item_(.+?)\.pdf$/i,
    add_line: /add line item/i,
    total: /^total$/i,
    submit_invoice: /^submit invoice$/i,
    done_dialog: /as done/i,
  };
})();
