/**
 * The runtime with Chrome's real tabs, tab group and page messaging — and the
 * fake web app, so no server is needed. Browser only.
 *
 * Opens one background tab in the ASH group, bills a fixture invoice in it,
 * and closes it. Storage stays in memory, so a browser that is signed in as a
 * real worker keeps its own identity and job untouched; close_strays is
 * switched off for the same reason — it would close that worker's tabs.
 */

import { create_chrome_env } from "../../worker/chrome_env.js";
import { create_runtime } from "../../worker/runtime.js";
import { create_life, create_world } from "../support/fake_env.js";
import { create_fake_server } from "../support/fake_server.js";
import { INVOICE, INVOICE_TOTAL, registry } from "../support/scenario.js";
import { SITE_KEY } from "../../adapters/fixture/site/ledger.js";

export default {
  async "a page that takes a command and never answers is a failure in seconds, not a worker held for minutes"(t) {
    const env = create_chrome_env();
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("tests/support/silent_page.html"), active: false });

    try {
      await new Promise((resolve) => setTimeout(resolve, 800));

      const asked = async (options) => {
        const started = Date.now();

        try {
          await env.page.send(tab.id, "sheet", {}, options);

          return { error: null, ms: Date.now() - started };
        } catch (error) {
          return { error, ms: Date.now() - started };
        }
      };

      const read = await asked({ timeout_ms: 2000 });

      t.equal(read.error?.error_class, "transient", `a silent page's read ended ${read.error?.error_class}: ${read.error?.message}`);
      t.ok(/"sheet"/.test(read.error?.message || ""), "the error does not name the command");
      t.ok(read.ms < 5000, `waited ${read.ms} ms on a silent page`);

      const press = await asked({ once: true, timeout_ms: 2000 });

      t.equal(press.error?.error_class, "unknown_outcome", "a press the page took but never confirmed must be unknown, never retried");
      t.ok(press.ms < 5000, `waited ${press.ms} ms on a silent page`);
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => null);
    }
  },

  async "a job runs in a real background tab and bills the fixture site once"(t) {
    const number = `WO-T${Date.now()}`;
    const world = create_world();

    world.server = create_fake_server(world, { version: world.version });

    const { env: fake } = create_life(world);
    const chrome_env = create_chrome_env();
    const opened = [];
    const env = {
      ...fake,
      extension_url: chrome_env.extension_url,
      page: chrome_env.page,
      tabs: {
        ...chrome_env.tabs,
        async open(url) {
          const id = await chrome_env.tabs.open(url);

          opened.push(id);

          return id;
        },
        close_strays: async () => {},
      },
    };

    const runtime = create_runtime(env, registry());

    await runtime.sign_in({ email: world.server.person.email, password: world.server.person.password, device_name: "Test page" });

    const delivery = world.server.enqueue({
      operation: "submit_invoice",
      public_id: number,
      payload: { work_order: { public_id: number }, ...INVOICE },
      expected_total_cents: INVOICE_TOTAL,
    });

    try {
      await runtime.tick("test");

      t.equal(delivery.status, "succeeded", `ended ${delivery.status}: ${JSON.stringify(await runtime.state())}`);
      t.equal(opened.length, 1, "more than one tab was opened");
      t.equal(await chrome.tabs.get(opened[0]).then(() => true, () => false), false, "the job's tab was left open");

      const books = (await chrome.storage.local.get(SITE_KEY))[SITE_KEY];

      t.equal(books.orders[number].submits, 1);
    } finally {
      for (const id of opened) await chrome.tabs.remove(id).catch(() => null);

      const { [SITE_KEY]: books } = await chrome.storage.local.get(SITE_KEY);

      if (books?.orders?.[number]) {
        delete books.orders[number];
        await chrome.storage.local.set({ [SITE_KEY]: books });
      }
    }
  },
};
