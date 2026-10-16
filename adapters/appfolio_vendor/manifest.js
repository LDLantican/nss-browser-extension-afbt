/**
 * The appfolio_vendor adapter's declarations (roadmap phase 9; ADR-008).
 *
 * ASH is the *vendor* in Camelot's AppFolio, and the vendor portal
 * (vendor.appfolio.com) is where it bills: accept a dispatched work order,
 * post the photographs as notes, submit the invoice, press Work Done. The web
 * app queues those four as a chain on Approve; this adapter does them in a
 * background tab, one step at a time.
 *
 * The flags are the web app's platform_operations row for each operation
 * (20261008210218357_seed_integration_platforms.sql) and must stay equal to it:
 *
 *   accept          idempotent, and a negative is trusted — accepting twice is
 *                   harmless, and "not accepted" can be retried.
 *   post_photos     not idempotent (a second note is a duplicate Camelot sees),
 *                   but a negative is trusted: the note's text is fixed by the
 *                   web app, so "no note says this" is an observation.
 *   submit_invoice  neither: an invoice whose outcome is unknown is a person's
 *                   call, always (ADR-004).
 *   mark_work_done  idempotent, negative trusted, like accept.
 *
 * Identity: the vendor portal's URL id (`/{account}/workOrders/{id}`) is
 * captured; nothing ASH-made is written into AppFolio (no reference tag,
 * ADR-002), so a work order is found again by its number, on the list.
 */

export default {
  id: "appfolio_vendor",
  /* 1.0.0 ran the first live rung and missed its own saved note (AppFolio adds
     a header to the body); 1.1.0 matches the note by line; 1.2.0 reads the
     number of an invoice made with the form (`Billable_Item_invoice_…pdf`). */
  version: "1.2.0",

  identity: {
    native_id: true,
    number: true,
    url: true,
    reference_tag: false,
    search_by_tag: false,
    search_by_number: true,
  },

  operations: {
    accept: {
      entity: "work_order",
      commit_step: "accept",
      idempotent: true,
      verifiable: true,
      negative_verify_trusted: true,
    },
    post_photos: {
      entity: "work_order",
      commit_step: "save_note",
      idempotent: false,
      verifiable: true,
      negative_verify_trusted: true,
    },
    submit_invoice: {
      entity: "work_order",
      commit_step: "submit",
      idempotent: false,
      verifiable: true,
      negative_verify_trusted: false,
    },
    mark_work_done: {
      entity: "work_order",
      commit_step: "work_done",
      idempotent: true,
      verifiable: true,
      negative_verify_trusted: true,
    },
  },
};
