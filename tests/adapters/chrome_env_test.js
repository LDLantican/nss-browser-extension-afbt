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
import { add_unit, create, empty_books, find_area, find_item } from "../../adapters/appfolio_pm/site/books.js";
import { PM_HEADER } from "../support/scenario.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kitchen = (item, result, note) => ({ area: "Kitchen", area_nth: 0, item, item_nth: 0, result, note });

/**
 * The pretend property-manager AppFolio on one inspection, in a background tab
 * of its own (hidden, as the worker's are), with books of its own. `slow_timers`
 * slows every timer on the page as a hidden tab's are (site/timers.js).
 */
async function pm_tab({ slow_timers = 0, change = () => {} } = {}) {
  const store = `pm_env_${crypto.randomUUID()}`;
  const books = empty_books();
  const unit = add_unit(books, { name: "Boyce 415", street: "415 Boyce" });
  const made = create(books, { name: PM_HEADER.name, date: PM_HEADER.inspected_on, unit_label: unit.label });

  change(books);
  await chrome.storage.local.set({ [store]: books });

  const query = `store=${store}${slow_timers ? `&slow_timers=${slow_timers}` : ""}`;
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`adapters/appfolio_pm/site/portal.html?${query}#/inspections/${made.id}`), active: false });

  await pause(1500);

  return {
    tab,
    item: async (name) => find_item(find_area((await chrome.storage.local.get(store))[store].inspections[made.id], "Kitchen"), name),
    done: async () => {
      await chrome.tabs.remove(tab.id).catch(() => null);
      await chrome.storage.local.remove(store);
    },
  };
}

export default {
  async "a hidden tab's slowed timers do not hold a command, because the worker wakes the page while it waits"(t) {
    const env = create_chrome_env({ track_tabs: false });
    /* Every timer on the page 20 s late: what 2026-11-24's background tab looked like from outside. */
    const p = await pm_tab({ slow_timers: 20000 });

    try {
      const started = Date.now();

      await env.page.send(p.tab.id, "set_item", kitchen("Sink", "follow_up", "Drips under the trap"), { timeout_ms: 15000 });

      const sink = await p.item("Sink");

      t.deep([sink.flag, sink.note], [true, "Drips under the trap"], "the command answered but did not do its work");
      t.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);

      /* The same wait without the ticks is the slowed timer's, and the page goes quiet — and says why. */
      let refused = null;

      try {
        await env.page.send(p.tab.id, "set_item", kitchen("Oven/Stove", "follow_up", "Burner two is dead"), { timeout_ms: 6000, tick: false });
      } catch (error) {
        refused = error;
      }

      t.ok(refused, "a slowed page answered without ticks, so the first half proves nothing");
      t.equal(refused?.error_class, "transient");
      t.ok(/it was at "waiting for [^"]+" for \d/.test(refused?.message || ""), `the wait was not named: ${refused?.message}`);
      t.ok(/its timers ran up to \d/.test(refused?.message || ""), `the slowed timers were not reported: ${refused?.message}`);
    } finally {
      await p.done();
    }
  },

  async "a command stuck in a wait that never ends says which wait it is"(t) {
    const env = create_chrome_env({ track_tabs: false });
    /* Edit does nothing on this page, so the item's form never opens. */
    const p = await pm_tab({ change: (books) => Object.assign(books, { freeze_forms: true }) });

    try {
      let refused = null;

      try {
        await env.page.send(p.tab.id, "set_item", kitchen("Sink", "follow_up", "Drips under the trap"), { timeout_ms: 3000 });
      } catch (error) {
        refused = error;
      }

      t.equal(refused?.error_class, "transient", `ended ${refused?.error_class}: ${refused?.message}`);
      t.ok(/it was at "waiting for Sink's form to open" for \d/.test(refused?.message || ""), `the wait was not named: ${refused?.message}`);
      t.ok(/the page was hidden/.test(refused?.message || ""), `the page's visibility was not said: ${refused?.message}`);
    } finally {
      await p.done();
    }
  },

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
    /* Untracked, so a worker signed in on this browser cannot close its tab as a stray (the test page, 2026-11-24). */
    const chrome_env = create_chrome_env({ track_tabs: false });
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
