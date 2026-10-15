/**
 * Everything the fixture adapter knows about its pages' structure (ADR-008).
 *
 * The only file that does. A change here is a change in what the adapter can
 * see, so it bumps the adapter's version in manifest.js — which is what lets
 * the server kill one version without the other.
 */

export const SELECTORS = {
  ready_flag: "fixtureReady",

  signed_out: ".js-signed-out",
  work_order: ".js-work-order",
  number: ".js-wo-number",

  accepted_badge: ".js-accepted-badge",
  accept_button: ".js-accept-button",

  line_rows: ".js-line-rows",
  line_row: ".js-line-row",
  add_line: ".js-add-line",
  line_description: ".js-line-description",
  line_quantity: ".js-line-quantity",
  line_rate: ".js-line-rate",
  total: ".js-invoice-total",
  submit: ".js-submit-invoice",

  invoice: ".js-invoice",
  invoice_number: ".js-invoice-number",
  invoice_total: ".js-submitted-total",
};
