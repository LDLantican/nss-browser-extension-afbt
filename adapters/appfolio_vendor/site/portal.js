/**
 * A pretend AppFolio vendor portal's books (roadmap phase 9).
 *
 * There is no AppFolio sandbox, and "zero duplicate invoices, zero duplicate
 * notes" is the thing the tests prove, so the adapter is exercised against
 * these books: work orders as the vendor portal lists them, the notes and
 * invoices posted on each, and the arithmetic the portal does on an invoice.
 * Plain data and pure functions, so the same books back the fixture pages in
 * Chrome (site.js, kept in chrome.storage.local) and the tests under Node
 * (tests/support/fake_vendor.js).
 *
 * The shape follows what was read off the live portal on 2026-10-16
 * (docs/vendor-adapter.md, "The appfolio_vendor adapter"): a work order has
 * a URL id that is not its number, a status from the portal's own vocabulary,
 * a description, an optional maintenance limit, notes, and submitted invoices
 * listed as `Billable_Item_invoice_<number>-<n>.pdf` (an uploaded PDF is `Billable_Item_<n>.pdf`).
 *
 * Every accept, note, submit and Work Done is **counted**, including the ones
 * that would be duplicates. Nothing here refuses a second invoice or a second
 * note, exactly as the real portal does not: refusing would hide the bug the
 * tests exist to catch.
 */

export const PORTAL_KEY = "appfolio_vendor_fixture";

/** The vendor account segment every work-order URL starts with. */
export const ACCOUNT = "2433209";

/** Statuses after Work Done: the job is with the property manager now. */
export const SETTLED = ["Under Review", "Payment Pending", "Payment Sent", "Closed"];

export function empty_portal() {
  return { signed_in: true, company: "Camelot Properties, LLC", next_id: 20001, next_bill: 51001, orders: {} };
}

/** Put a work order on the portal, as the property manager dispatching it would. */
export function dispatch(portal, { number, status = "Available", description = "", limit_cents = null } = {}) {
  const id = String(portal.next_id++);

  portal.orders[id] = {
    id,
    number,
    status,
    description,
    limit_cents,
    notes: [],
    invoices: [],
    accepts: 0,
    note_saves: 0,
    submits: 0,
    work_dones: 0,
  };

  return portal.orders[id];
}

export function path_of(order) {
  return `/${ACCOUNT}/workOrders/${order.id}`;
}

export function by_id(portal, id) {
  return portal.orders[String(id)] || null;
}

export function by_number(portal, number) {
  return Object.values(portal.orders).find((order) => order.number === number) || null;
}

/** Which list tab a status shows on, as the portal sorts them. */
export function tab_of(status) {
  if (["Estimate Needed", "Estimated"].includes(status)) return "estimates";
  if (["Needs Invoice", ...SETTLED].includes(status)) return "completed";

  return "in_progress";
}

/**
 * A decimal string as an integer number of `places`-ths, cut (never rounded)
 * past that, as the portal's Rate field cuts "12.3456" to "12.34". Strings,
 * not floats, end to end.
 */
export function scaled(value, places) {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(value ?? "").trim());

  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;

  const [, sign, whole, fraction = ""] = match;
  const result = Number(whole || "0") * 10 ** places + Number((fraction + "0".repeat(places)).slice(0, places) || "0");

  return sign === "-" ? -result : result;
}

/** quantity × rate in thousandths of a cent, the unrounded product. */
function product(quantity, rate) {
  const milli = scaled(quantity, 3);
  const cents = scaled(rate, 2);

  return milli === null || cents === null ? null : milli * cents;
}

/** One line's Amount as the portal shows it: the product, cut to the cent. */
export function amount_cents(quantity, rate) {
  const p = product(quantity, rate);

  return p === null ? null : Math.floor(p / 1000);
}

/**
 * The invoice's Total: the sum of the unrounded products, rounded half up —
 * which is why a total can be a cent more than its Amounts add up to
 * (docs/subcontractor-app.md, "Drift").
 */
export function total_cents(lines) {
  let sum = 0;

  for (const line of lines) {
    const p = product(line.quantity, line.rate);

    if (p === null) return null;

    sum += p;
  }

  return Math.floor((sum + 500) / 1000);
}

export function accept(portal, id) {
  const order = by_id(portal, id);

  order.accepts++;
  if (order.status === "Accept/Reject") order.status = "Available";

  return order;
}

export function save_note(portal, id, body, photos) {
  const order = by_id(portal, id);

  order.note_saves++;
  order.notes.push({ body: String(body), photos: Number(photos) || 0 });

  return order;
}

export function submit_invoice(portal, id, lines) {
  const order = by_id(portal, id);
  const bill = portal.next_bill++;

  order.submits++;
  order.invoices.push({
    /* As the live portal names an invoice made with the form. */
    number: `invoice_${order.number}-${bill}`,
    file: `Billable_Item_invoice_${order.number}-${bill}.pdf`,
    total_cents: total_cents(lines),
    lines: lines.map(({ description, quantity, rate }) => ({ description, quantity, rate })),
  });

  return order;
}

export function work_done(portal, id) {
  const order = by_id(portal, id);

  order.work_dones++;
  if (!SETTLED.includes(order.status)) order.status = "Under Review";

  return order;
}
