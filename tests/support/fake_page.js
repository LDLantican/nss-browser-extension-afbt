/**
 * The fixture adapter's page script, without a page.
 *
 * Answers the same commands adapters/fixture/page.js answers, against the
 * same books (adapters/fixture/site/ledger.js), so the service-worker half of
 * the adapter can be run under Node. The DOM half is tested where there is a
 * DOM: tests/adapters/fixture_page_test.js, in the extension's test page.
 *
 * A tab is `{ url, form }`; navigating replaces it, which empties the form —
 * as reloading a real page does.
 */

import { accept, find_invoice, invoice_total_cents, snapshot, submit_invoice } from "../../adapters/fixture/site/ledger.js";
import { AdapterError } from "../../worker/errors.js";

function number_of(url) {
  const match = /[?&]wo=([^&#]+)/.exec(url);

  return match ? decodeURIComponent(match[1]) : "";
}

export function fake_page_command(site, tab, command, args) {
  const signed_in = site.signed_in !== false;
  const number = number_of(tab.url);

  if (!signed_in && command !== "state") throw new AdapterError("session_expired", "Signed out.");

  switch (command) {
    case "state":
      return { signed_in, number: signed_in ? number : "", accepted: signed_in && snapshot(site, number).accepted };

    case "find_invoice": {
      const invoice = find_invoice(site, number, args.total_cents ?? null);

      return { invoice: invoice ? { id: invoice.id, number: invoice.number, total_cents: invoice.total_cents } : null };
    }

    case "fill_invoice":
      tab.form = (args.items || []).map(({ description, quantity, rate }) => ({ description, quantity, rate }));

      return { lines: tab.form.length };

    case "read_total":
      return { total_cents: invoice_total_cents(tab.form) };

    case "submit":
      if (tab.form.length === 0) throw new AdapterError("adapter_broken", "No invoice lines to submit.");

      /* The form stays filled, as the worst real page would leave it — one
         that has not re-rendered yet, or keeps what was typed. A fake that
         emptied it would refuse a second click by itself and hide the very
         double submit the kill loop is looking for. */
      submit_invoice(site, number, tab.form);

      return { clicked: true };

    case "accept":
      accept(site, number);

      return { clicked: true };

    default:
      throw new AdapterError("adapter_broken", `Unknown command: ${command}`);
  }
}
