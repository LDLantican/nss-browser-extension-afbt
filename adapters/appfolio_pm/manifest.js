/**
 * The appfolio_pm adapter's declarations (roadmap phase 12; ADR-008, ADR-014).
 *
 * The property-manager side of Camelot's AppFolio, where ASH creates an
 * inspection its vendors carried out on a phone, so the office can press
 * AppFolio's own Create Work Order(s) on the flags. The web app queues four
 * steps on approving an inspection; this adapter does them in a background
 * tab, one at a time.
 *
 * The flags are the web app's platform_operations rows
 * (20261020114826788_seed_inspection_delivery_chain.sql) and must stay equal:
 *
 *   create        not idempotent — a second Start Inspection is a second
 *                 inspection — but a negative is trusted: ASH's number is in
 *                 the name, so "no inspection on the list carries INS-000045"
 *                 is an observation, and the create may be made again.
 *   fill_areas    idempotent: it makes each item what ASH says; doing it twice
 *                 is the same item.
 *   post_photos   not idempotent (a second upload is a second photograph), but
 *                 verifiable by the item's photograph count, and trusted.
 *   mark_done     idempotent.
 *
 * Identity: AppFolio's inspection id, from `/inspections/{id}`. The name
 * carries ASH's number — the one reference tag ADR-014 allows — and the list,
 * narrowed to the property, is searched for it.
 */

export default {
  id: "appfolio_pm",
  version: "1.0.1",

  identity: {
    native_id: true,
    number: false,
    url: true,
    reference_tag: true,
    search_by_tag: true,
    search_by_number: false,
  },

  operations: {
    create: { entity: "inspection", commit_step: "start", idempotent: false, verifiable: true, negative_verify_trusted: true },
    fill_areas: { entity: "inspection", commit_step: "save_items", idempotent: true, verifiable: true, negative_verify_trusted: true },
    post_photos: { entity: "inspection", commit_step: "save_photos", idempotent: false, verifiable: true, negative_verify_trusted: true },
    mark_done: { entity: "inspection", commit_step: "done", idempotent: true, verifiable: true, negative_verify_trusted: true },
  },
};
