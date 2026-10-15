/**
 * The fixture adapter's declarations (ADR-008).
 *
 * A stand-in for the vendor portal, used to prove the runtime: it accepts work
 * orders and submits invoices on pages packaged inside this extension
 * (adapters/fixture/site/), so nothing it does can reach a real platform. The
 * server offers it jobs only on a connection whose `adapter` is `fixture`,
 * which nothing seeds — such a connection exists only where somebody made one
 * on purpose, in a test database or a development one.
 *
 * Its operations carry the flags the AppFolio vendor operations carry in the
 * web app's platform_operations, because the point is to exercise the same
 * rules: `accept` is idempotent and trusts a negative; `submit_invoice` is
 * neither, so an invoice whose outcome is unknown goes to a person.
 */

export default {
  id: "fixture",
  version: "1.0.0",

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
    submit_invoice: {
      entity: "work_order",
      commit_step: "submit",
      idempotent: false,
      verifiable: true,
      negative_verify_trusted: false,
    },
  },
};
