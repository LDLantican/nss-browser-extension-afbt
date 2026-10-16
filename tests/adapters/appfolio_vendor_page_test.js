/**
 * The appfolio_vendor page script against the pretend vendor portal, in a
 * frame of the extension's test page. Browser only: there is no DOM under
 * Node.
 *
 * The pretend portal (adapters/appfolio_vendor/site/) is built from the live
 * portal's markup and `js-*` hooks, read on 2026-10-16, so this is the page
 * script's selectors and its React-style typing tested against the shapes
 * AppFolio actually has. It cannot prove AppFolio has not changed since; the
 * rollout ladder's probe does that, on the live portal.
 *
 * Each test gets its own books (`?store=`) and frame id.
 */

import { dispatch, empty_portal, path_of } from "../../adapters/appfolio_vendor/site/portal.js";
import { INVOICE, INVOICE_TOTAL, MARKER } from "../support/scenario.js";

async function portal_for(orders, { signed_in = true } = {}) {
  const store = `vendor_test_${crypto.randomUUID()}`;
  const frame = crypto.randomUUID();
  const books = empty_portal();

  books.signed_in = signed_in;

  const made = orders.map((order) => dispatch(books, { description: MARKER, ...order }));

  await chrome.storage.local.set({ [store]: books });

  const iframe = document.createElement("iframe");

  iframe.style.cssText = "width: 1000px; height: 700px; border: 0; position: absolute; left: -2000px;";

  const go = async (route) => {
    /* Only the hash changes after the first load, and a hash change fires no
       load event: set it in place and let the pretend portal re-render. */
    if (iframe.isConnected) {
      iframe.contentWindow.location.hash = route;
      await new Promise((resolve) => setTimeout(resolve, 400));

      return;
    }

    await new Promise((resolve) => {
      iframe.addEventListener("load", resolve, { once: true });
      iframe.src = chrome.runtime.getURL(`adapters/appfolio_vendor/site/portal.html?store=${store}&frame=${frame}#${route}`);
      if (!iframe.isConnected) document.body.append(iframe);
    });
  };

  const ask = async (command, args = {}) => {
    for (let tries = 0; tries < 100; tries++) {
      const answer = await chrome.runtime.sendMessage({ type: "ASH_PAGE_COMMAND", frame, command, args }).catch(() => undefined);

      if (answer) {
        if (!answer.ok) throw Object.assign(new Error(answer.error), { error_class: answer.error_class });

        return answer.result;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`The page never answered ${command}.`);
  };

  const read = async () => (await chrome.storage.local.get(store))[store];
  const done = async () => {
    iframe.remove();
    await chrome.storage.local.remove(store);
  };

  return { orders: made, go, ask, read, done };
}

/** A JPEG's start and end markers, as base64: enough bytes for a file input to hold. */
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9));

export default {
  async "the list finds a work order by number on whichever tab it sits"(t) {
    const p = await portal_for([{ number: "19576-1" }, { number: "18830-2", status: "Payment Pending" }]);

    try {
      await p.go("/");

      const state = await p.ask("state");

      t.equal(state.kind, "list");
      t.equal(state.account, "2433209");

      const found = await p.ask("find_in_list", { number: "18830-2" });

      t.equal(found.path, path_of(p.orders[1]));
      t.equal(found.tab, "completed");

      const missing = await p.ask("find_in_list", { number: "99999-9" });

      t.equal(missing.path, null);
    } finally {
      await p.done();
    }
  },

  async "a work order page says what it is, and Accept presses Accept"(t) {
    const p = await portal_for([{ number: "19576-1", status: "Accept/Reject", limit_cents: 25000 }]);

    try {
      await p.go(path_of(p.orders[0]));

      const state = await p.ask("state");

      t.equal(state.kind, "work_order");
      t.equal(state.number, "19576-1");
      t.equal(state.status, "Accept/Reject");
      t.equal(state.description, MARKER);
      t.equal(state.limit_cents, 25000);
      t.equal(state.id, p.orders[0].id);

      await p.ask("accept");
      await new Promise((resolve) => setTimeout(resolve, 300));

      t.equal((await p.read()).orders[p.orders[0].id].accepts, 1);
      t.equal((await p.ask("state")).status, "Available");
    } finally {
      await p.done();
    }
  },

  async "photographs are staged, attached, counted and saved with the note"(t) {
    const p = await portal_for([{ number: "19576-1" }]);

    try {
      await p.go(`${path_of(p.orders[0])}/notes`);

      const before = await p.ask("notes", { text: "Photos 1–2 of 2" });

      t.equal(before.settled, true, "an empty list did not read as No Notes");
      t.equal(before.match, null);

      await p.ask("stage_photo", { name: "a.jpg", mime_type: "image/jpeg", b64: JPEG });
      await p.ask("stage_photo", { name: "b.jpg", mime_type: "image/jpeg", b64: JPEG });

      t.deep(await p.ask("attach_staged"), { attached: 2 });

      await p.ask("fill_note", { text: "Photos 1–2 of 2" });
      await p.ask("save_note");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const after = await p.ask("notes", { text: "Photos 1–2 of 2" });

      /* Found by its line, under the header AppFolio puts on a saved note. */
      t.ok(after.match, "the saved note was not recognised by its text");
      t.deep((await p.read()).orders[p.orders[0].id].notes, [{ body: "Photos 1–2 of 2", photos: 2 }]);
    } finally {
      await p.done();
    }
  },

  async "an invoice is typed line for line, totalled by the page, and submitted"(t) {
    const p = await portal_for([{ number: "19576-1", limit_cents: 50000 }]);

    try {
      await p.go(`${path_of(p.orders[0])}/invoices`);

      const empty = await p.ask("invoice_state");

      t.equal(empty.invoiced, false);
      t.equal(empty.none, true, "the not-uploaded sentence was not read");
      t.equal(empty.limit_cents, 50000);

      const items = INVOICE.invoice.items.map(({ description, quantity, rate }) => ({ description, quantity, rate }));

      t.deep(await p.ask("fill_invoice", { items }), { lines: 2 });

      const totals = await p.ask("read_total");

      t.equal(totals.total_cents, INVOICE_TOTAL);
      t.deep(totals.amounts, INVOICE.invoice.items.map((item) => item.expected_total_cents));

      await p.ask("submit_invoice");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const sent = await p.ask("invoice_state");

      t.equal(sent.invoiced, true);
      t.equal(sent.bills[0].number, "invoice_19576-1-51001", "the number between Billable_Item_ and .pdf");
      t.equal((await p.read()).orders[p.orders[0].id].invoices[0].total_cents, INVOICE_TOTAL);
    } finally {
      await p.done();
    }
  },

  async "a refilled form ends with exactly as many rows as items"(t) {
    const p = await portal_for([{ number: "19576-1" }]);

    try {
      await p.go(`${path_of(p.orders[0])}/invoices`);

      const three = [1, 2, 3].map((n) => ({ description: `Line ${n}`, quantity: "1", rate: "1.00" }));

      t.deep(await p.ask("fill_invoice", { items: three }), { lines: 3 });
      t.deep(await p.ask("fill_invoice", { items: three.slice(0, 1) }), { lines: 1 });
      t.equal((await p.ask("read_total")).total_cents, 100);
    } finally {
      await p.done();
    }
  },

  async "a rate past two decimals is cut by the page, which the total then shows"(t) {
    const p = await portal_for([{ number: "19576-1" }]);

    try {
      await p.go(`${path_of(p.orders[0])}/invoices`);
      await p.ask("fill_invoice", { items: [{ description: "Probe", quantity: "2.5", rate: "12.3456" }] });

      const totals = await p.ask("read_total");

      t.deep(totals.rates, ["12.34"]);
      t.equal(totals.total_cents, 3085);
    } finally {
      await p.done();
    }
  },

  async "Work Done presses the button and then Yes"(t) {
    const p = await portal_for([{ number: "19576-1" }]);

    try {
      await p.go(path_of(p.orders[0]));
      await p.ask("work_done");
      await new Promise((resolve) => setTimeout(resolve, 300));

      t.equal((await p.ask("state")).status, "Under Review");
      t.equal((await p.read()).orders[p.orders[0].id].work_dones, 1);
    } finally {
      await p.done();
    }
  },

  async "a signed-out portal says so"(t) {
    const p = await portal_for([{ number: "19576-1" }], { signed_in: false });

    try {
      await p.go("/");

      t.equal((await p.ask("state")).signed_in, false);
    } finally {
      await p.done();
    }
  },

  async "the probe finds every hook on every page"(t) {
    const p = await portal_for([{ number: "19576-1" }]);

    try {
      for (const route of ["/", path_of(p.orders[0]), `${path_of(p.orders[0])}/notes`, `${path_of(p.orders[0])}/invoices`]) {
        await p.go(route);
        await p.ask("state");

        const probe = await p.ask("probe");

        t.deep(probe.missing, [], `${probe.kind}: ${probe.missing.join(", ")}`);
      }
    } finally {
      await p.done();
    }
  },
};
