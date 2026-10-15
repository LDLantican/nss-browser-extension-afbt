/**
 * The fixture platform's books.
 *
 * The fixture adapter needs something to bill that is not AppFolio — there is
 * no AppFolio sandbox — and that keeps an honest count of what was done to it,
 * because "zero duplicate invoices" is the thing the tests prove. This is that
 * something: work orders, the invoices submitted against them, and the
 * arithmetic a vendor portal does on an invoice's lines.
 *
 * Plain data and pure functions, so the same books back the fixture pages in
 * Chrome (kept in chrome.storage.local by site.js) and the tests under Node.
 *
 * Every submit and accept is **counted**, including the ones that would be
 * duplicates; nothing here refuses a second invoice, exactly as a real portal
 * would not. Refusing would hide the bug the tests exist to catch.
 */

export const SITE_KEY = "fixture_site";

export function empty_site() {
  return { signed_in: true, next_invoice: 1001, orders: {} };
}

function order(site, number) {
  site.orders[number] ??= { number, accepted: false, accepts: 0, submits: 0, invoices: [] };

  return site.orders[number];
}

/**
 * A decimal string as an integer number of `places`-ths, rounded half up past
 * that. Strings, not floats, end to end: "58.50" × "1.5" in floating point is
 * how a penny goes missing.
 */
export function scaled(value, places) {
  const text = String(value ?? "").trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);

  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;

  const [, sign, whole, fraction = ""] = match;
  const kept = (fraction + "0".repeat(places)).slice(0, places);
  let result = Number(whole || "0") * 10 ** places + Number(kept || "0");

  if (fraction.length > places && Number(fraction[places]) >= 5) result += 1;

  return sign === "-" ? -result : result;
}

/** One line as the portal totals it: quantity × rate, to the cent, half up. */
export function line_total_cents(quantity, rate) {
  const milli = scaled(quantity, 3);
  const cents = scaled(rate, 2);

  if (milli === null || cents === null) return null;

  return Math.floor((milli * cents + 500) / 1000);
}

export function invoice_total_cents(lines) {
  let total = 0;

  for (const line of lines) {
    const cents = line_total_cents(line.quantity, line.rate);

    if (cents === null) return null;

    total += cents;
  }

  return total;
}

export function submit_invoice(site, number, lines) {
  const wo = order(site, number);
  const id = site.next_invoice++;
  const invoice = {
    id: String(id),
    number: `INV-${id}`,
    total_cents: invoice_total_cents(lines),
    lines: lines.map(({ description, quantity, rate }) => ({ description, quantity, rate })),
  };

  wo.submits++;
  wo.invoices.push(invoice);

  return invoice;
}

export function accept(site, number) {
  const wo = order(site, number);

  wo.accepts++;
  wo.accepted = true;

  return wo;
}

/** The newest invoice on a work order with this total, if any. */
export function find_invoice(site, number, total_cents) {
  const invoices = site.orders[number]?.invoices || [];

  for (let index = invoices.length - 1; index >= 0; index--)
    if (total_cents === null || total_cents === undefined || invoices[index].total_cents === total_cents) return invoices[index];

  return null;
}

export function snapshot(site, number) {
  return order(site, number);
}
