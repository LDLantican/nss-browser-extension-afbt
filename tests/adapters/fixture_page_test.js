/**
 * The fixture adapter's page script against its real page, in a frame of the
 * extension's test page. Browser only: there is no DOM under Node.
 *
 * Each test gets its own books (`?store=`), so nothing here touches the books
 * a developer's own fixture tabs keep, and its own frame id, which is how the
 * page script tells this frame's commands from another's.
 */

import { INVOICE, INVOICE_TOTAL } from "../support/scenario.js";

async function frame_for(number, { signed_in = true } = {}) {
  const store = `fixture_test_${crypto.randomUUID()}`;
  const frame = crypto.randomUUID();

  if (!signed_in) await chrome.storage.local.set({ [store]: { signed_in: false, next_invoice: 1001, orders: {} } });

  const iframe = document.createElement("iframe");

  iframe.src = chrome.runtime.getURL(`adapters/fixture/site/work_order.html?wo=${encodeURIComponent(number)}&store=${store}&frame=${frame}`);
  iframe.style.cssText = "width: 1px; height: 1px; border: 0; position: absolute; left: -10px;";

  await new Promise((resolve) => {
    iframe.addEventListener("load", resolve, { once: true });
    document.body.append(iframe);
  });

  const tab = await chrome.tabs.getCurrent();

  const ask = async (command, args = {}) => {
    for (let tries = 0; tries < 40; tries++) {
      const answer = await chrome.runtime
        .sendMessage({ type: "ASH_PAGE_COMMAND", tab_id: tab.id, frame, command, args })
        .catch(() => undefined);

      if (answer) {
        if (!answer.ok) throw Object.assign(new Error(answer.error), { error_class: answer.error_class });

        return answer.result;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`The page never answered ${command}.`);
  };

  const books = async () => (await chrome.storage.local.get(store))[store];
  const done = async () => {
    iframe.remove();
    await chrome.storage.local.remove(store);
  };

  return { ask, books, done, iframe };
}

export default {
  async "the page reports the work order it shows"(t) {
    const page = await frame_for("WO-T1");

    try {
      t.deep(await page.ask("state"), { signed_in: true, number: "WO-T1", accepted: false });
    } finally {
      await page.done();
    }
  },

  async "filling the invoice makes the page total it exactly as the server does"(t) {
    const page = await frame_for("WO-T2");

    try {
      const filled = await page.ask("fill_invoice", { items: INVOICE.invoice.items });

      t.equal(filled.lines, 2);
      t.equal((await page.ask("read_total")).total_cents, INVOICE_TOTAL);

      /* Filling again replaces the lines rather than adding to them. */
      await page.ask("fill_invoice", { items: INVOICE.invoice.items });
      t.equal((await page.ask("read_total")).total_cents, INVOICE_TOTAL);
    } finally {
      await page.done();
    }
  },

  async "submitting records one invoice, which the page can then find"(t) {
    const page = await frame_for("WO-T3");

    try {
      t.equal((await page.ask("find_invoice", { total_cents: INVOICE_TOTAL })).invoice, null);

      await page.ask("fill_invoice", { items: INVOICE.invoice.items });
      await page.ask("submit");

      const found = await page.ask("find_invoice", { total_cents: INVOICE_TOTAL, wait_ms: 3000 });

      t.ok(found.invoice, "the submitted invoice was not found");
      t.equal(found.invoice.total_cents, INVOICE_TOTAL);
      t.equal((await page.books()).orders["WO-T3"].submits, 1);
    } finally {
      await page.done();
    }
  },

  async "accepting shows on the page"(t) {
    const page = await frame_for("WO-T4");

    try {
      await page.ask("accept");

      for (let i = 0; i < 40 && !(await page.ask("state")).accepted; i++) await new Promise((resolve) => setTimeout(resolve, 50));

      t.equal((await page.ask("state")).accepted, true);
      t.equal((await page.books()).orders["WO-T4"].accepts, 1);
    } finally {
      await page.done();
    }
  },

  async "a signed-out page says so"(t) {
    const page = await frame_for("WO-T5", { signed_in: false });

    try {
      t.deep(await page.ask("state"), { signed_in: false, number: "", accepted: false });
    } finally {
      await page.done();
    }
  },
};
