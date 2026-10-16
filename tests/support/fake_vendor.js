/**
 * The appfolio_vendor adapter's page script, without a page.
 *
 * Answers the commands adapters/appfolio_vendor/page.js answers, against the
 * same books (adapters/appfolio_vendor/site/portal.js), so the service-worker
 * half of the adapter can be run — and killed — under Node. The DOM half is
 * tested where there is a DOM: tests/adapters/appfolio_vendor_page_test.js,
 * in the extension's test page, and on the live portal by the rollout ladder.
 *
 * A tab is `{ url, form, staged, attached, note }`; navigating replaces it,
 * which empties the forms — as reloading a real page does. A pressed button
 * leaves its form filled, as the worst real page would: a fake that emptied
 * it would refuse a second press by itself and hide the very duplicate the
 * kill loop is looking for.
 */

import {
  accept,
  ACCOUNT,
  amount_cents,
  by_id,
  by_number,
  path_of,
  save_note,
  SETTLED,
  submit_invoice,
  tab_of,
  total_cents,
  work_done,
} from "../../adapters/appfolio_vendor/site/portal.js";
import { AdapterError } from "../../worker/errors.js";

export const VENDOR_ORIGIN = "https://vendor.appfolio.com";
export const SIGN_IN_URL = "https://passport.appf.io/sign_in/request_access_link?idp_type=vendor";

/** Where a tab opened at `url` lands: signed out, the portal sends it to sign in. */
export function vendor_landing(portal, url) {
  return url.startsWith(VENDOR_ORIGIN) && portal.signed_in === false ? SIGN_IN_URL : url;
}

function route(url) {
  const path = url.slice(VENDOR_ORIGIN.length) || "/";
  const match = /^\/(\d+)\/workOrders\/(\d+)(\/notes|\/invoices)?/.exec(path);

  if (match) return { kind: match[3] === "/notes" ? "notes" : match[3] === "/invoices" ? "invoices" : "work_order", id: match[2], account: match[1] };

  return { kind: /^\/?$/.test(path) ? "list" : "other", id: null, account: null };
}

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function broken(message) {
  return new AdapterError("adapter_broken", message);
}

export function fake_vendor_command(portal, tab, command, args) {
  if (!tab.url.startsWith(VENDOR_ORIGIN)) throw new AdapterError("transient", `The page did not answer "${command}".`);

  const here = route(tab.url);
  const order = here.id ? by_id(portal, here.id) : null;

  if (here.id && !order) throw new AdapterError("transient", "The work-order page did not finish loading.");

  const need = (kind) => {
    if (here.kind !== kind) throw broken(`Not on the ${kind} page.`);
  };

  switch (command) {
    case "state":
      return {
        signed_in: true,
        kind: here.kind,
        path: order ? path_of(order) : null,
        account: here.account || ACCOUNT,
        id: order?.id || null,
        number: order?.number || "",
        status: order?.status || "",
        description: order && here.kind !== "notes" ? order.description : null,
        limit_cents: order && here.kind !== "notes" ? order.limit_cents : null,
      };

    case "find_in_list": {
      need("list");

      const found = by_number(portal, String(args.number || ""));

      return found ? { path: path_of(found), tab: tab_of(found.status), status: found.status } : { path: null, looked: ["in_progress", "completed", "estimates"] };
    }

    case "accept":
      need("work_order");
      if (order.status !== "Accept/Reject") throw broken("There is no Accept button to press.");

      accept(portal, order.id);

      return { clicked: true };

    case "notes": {
      need("notes");

      /* As the live portal shows a saved note: AppFolio's header, then the text. */
      const lines = (note) => `Note for Work Order #${order.number}\nPosted by: Alabama Signature Homes LLC\n\n${note.body}`.split(/\n+/).map(squash);
      const match = order.notes.find((note) => lines(note).includes(squash(args.text)));

      return { count: order.notes.length, settled: true, match: match ? { images: match.photos } : null };
    }

    case "stage_photo":
      need("notes");
      tab.staged.push({ name: args.name, mime_type: args.mime_type, size: String(args.b64 || "").length });

      return { staged: tab.staged.length };

    case "attach_staged":
      need("notes");
      tab.attached = Math.min(10, tab.staged.length);
      tab.staged = [];

      return { attached: tab.attached };

    case "fill_note":
      need("notes");
      tab.note = String(args.text || "");

      return { text: tab.note };

    case "save_note":
      need("notes");
      if (tab.note === "") throw broken("The note is empty.");

      save_note(portal, order.id, tab.note, tab.attached);

      return { clicked: true };

    case "invoice_state": {
      need("invoices");

      const bills = order.invoices.map((invoice) => ({ file: invoice.file, number: invoice.number }));

      return { invoiced: bills.length > 0, none: bills.length === 0, bills, limit_cents: order.limit_cents, form_open: tab.form.length > 0 };
    }

    case "fill_invoice":
      need("invoices");
      tab.form = (args.items || []).map(({ description, quantity, rate }) => ({ description, quantity, rate }));

      return { lines: tab.form.length };

    case "read_total":
      need("invoices");

      return {
        total_cents: tab.form.length ? total_cents(tab.form) : null,
        amounts: tab.form.map((line) => amount_cents(line.quantity, line.rate)),
        rates: tab.form.map((line) => line.rate),
      };

    case "submit_invoice":
      need("invoices");
      if (tab.form.length === 0) throw broken("There is no invoice to submit.");

      submit_invoice(portal, order.id, tab.form);

      return { clicked: true };

    case "work_done":
      need("work_order");
      work_done(portal, order.id);

      return { clicked: true };

    case "probe":
      return { kind: here.kind, signed_in: true, loading: false, found: [], missing: [] };

    default:
      throw broken(`Unknown command: ${command}`);
  }
}

export { SETTLED };
