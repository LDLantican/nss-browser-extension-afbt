/**
 * The appfolio_pm page script against the pretend property-manager AppFolio, in
 * a frame of the extension's test page. Browser only: there is no DOM under
 * Node.
 *
 * The pretend pages (adapters/appfolio_pm/site/) are built from the live
 * markup and `js-*` hooks read on 2026-10-20, and imitate the two search boxes
 * the live pages use — select2 on the New Inspection form, react-select on the
 * list's filter — so this is the page script's selectors, its React-style
 * typing and its search-box driving tested against the shapes AppFolio has.
 * It cannot prove AppFolio has not changed since, nor settle what was not seen
 * live (docs/pm-adapter.md); the rollout ladder's probe and dry run do that.
 *
 * Each test gets its own books (`?store=`) and frame id.
 */

import { reconcile } from "../../adapters/appfolio_pm/adapter.js";
import { add_unit, create, empty_books, find_area, find_item } from "../../adapters/appfolio_pm/site/books.js";
import { PM_HEADER, pm_areas } from "../support/scenario.js";

async function site_for({ signed_in = true, inspections = 0 } = {}) {
  const store = `pm_test_${crypto.randomUUID()}`;
  const frame = crypto.randomUUID();
  const books = empty_books();

  books.signed_in = signed_in;

  const unit = add_unit(books, { name: "Boyce 415", street: "415 Boyce" });

  add_unit(books, { name: "Oak 12", street: "12 Oak Street" });

  const made = Array.from({ length: inspections }, () => create(books, { name: PM_HEADER.name, date: PM_HEADER.inspected_on, unit_label: unit.label }));

  await chrome.storage.local.set({ [store]: books });

  const iframe = document.createElement("iframe");

  iframe.style.cssText = "width: 1000px; height: 700px; border: 0; position: absolute; left: -2000px;";

  const go = async (route) => {
    if (iframe.isConnected) {
      iframe.contentWindow.location.hash = route;
      await new Promise((resolve) => setTimeout(resolve, 400));

      return;
    }

    await new Promise((resolve) => {
      iframe.addEventListener("load", resolve, { once: true });
      iframe.src = chrome.runtime.getURL(`adapters/appfolio_pm/site/portal.html?store=${store}&frame=${frame}#${route}`);
      if (!iframe.isConnected) document.body.append(iframe);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
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

  return { store, made, go, ask, read, done, doc: () => iframe.contentDocument };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

export default {
  async "the list is narrowed to the property, searched for ASH's number, and a row opens its inspection in a new tab"(t) {
    const p = await site_for({ inspections: 1 });

    try {
      await p.go("/maintenance/inspections");

      t.equal((await p.ask("state")).kind, "list");

      const found = await p.ask("find_in_list", { tag: PM_HEADER.public_id, street: "415 Boyce" });

      t.equal(found.found, true);
      t.equal(found.settled, true, "the filter was not applied");

      const absent = await p.ask("find_in_list", { tag: "INS-999999", street: "415 Boyce" });

      t.equal(absent.found, false);
      t.equal(absent.settled, true);

      const before = new Set((await chrome.tabs.query({})).map((tab) => tab.id));

      await p.ask("open_row", { tag: PM_HEADER.public_id });
      await new Promise((resolve) => setTimeout(resolve, 800));

      const opened = (await chrome.tabs.query({})).filter((tab) => !before.has(tab.id));

      t.equal(opened.length, 1, "no tab, or more than one, was opened");
      t.ok(String(opened[0]?.url || opened[0]?.pendingUrl).includes(`#/inspections/${p.made[0].id}`), "the tab is not the inspection");

      for (const tab of opened) await chrome.tabs.remove(tab.id);
    } finally {
      await p.done();
    }
  },

  async "the address box is driven through select2's own API, because a background tab's typing finds nothing"(t) {
    const p = await site_for();

    try {
      await p.go("/maintenance/inspections/new");

      /* What the dry run of 2026-10-22 met: a script's typing searches nothing. */
      const doc = p.doc();

      doc.querySelector(".js-select2-search-inspectable .select2-choice").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await settle();

      const search = doc.querySelector(".select2-drop-active .select2-input");

      search.value = "415 Boyce";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "e" }));
      await settle();

      t.equal(doc.querySelectorAll(".select2-results li.select2-result-selectable").length, 0, "typed text was searched");

      await p.go("/maintenance/inspections/new?again");

      const filled = await p.ask("fill_new", { name: PM_HEADER.name, date: PM_HEADER.inspected_on, street: "415 Boyce", unit: null });
      const after = p.doc();

      t.ok(filled.address.startsWith("Boyce 415"), `chose ${filled.address}`);
      t.equal(after.querySelector("input.js-inspectable-id").value !== "", true, "the bound input holds no place");
      t.ok(after.querySelector(".select2-chosen").textContent.startsWith("Boyce 415"), "the box does not show the unit");
    } finally {
      await p.done();
    }
  },

  async "the new-inspection form takes the name and date and the unit, never a resident, and Start makes it"(t) {
    const p = await site_for();

    try {
      await p.go("/maintenance/inspections/new");

      const filled = await p.ask("fill_new", { name: PM_HEADER.name, date: PM_HEADER.inspected_on, street: "415 Boyce", unit: null });

      t.equal(filled.name, PM_HEADER.name);
      t.equal(filled.date, PM_HEADER.inspected_on);
      t.ok(filled.address.startsWith("Boyce 415"), `chose ${filled.address}`);
      t.equal(filled.layout, true, "the default layout was not chosen");

      await p.ask("start");
      await settle();

      const books = await p.read();
      const made = Object.values(books.inspections);

      t.equal(books.creates, 1);
      t.equal(made[0].name, PM_HEADER.name);
      t.equal(made[0].street, "415 Boyce");

      const state = await p.ask("state");

      t.equal(state.kind, "inspection");
      t.equal(state.id, made[0].id);
      t.equal(state.title, PM_HEADER.name);
      t.equal(state.status, "IN PROGRESS");
    } finally {
      await p.done();
    }
  },

  async "an inspection's sheet is read, and the fill's commands make it ASH's"(t) {
    const p = await site_for({ inspections: 1 });

    try {
      await p.go(`/inspections/${p.made[0].id}`);

      const first = await p.ask("sheet");

      t.deep(first.areas.map((a) => a.name), ["Kitchen", "Living Room", "Bedroom 1", "Bedroom 2", "Bathroom 1", "Compliance"]);
      t.equal(first.areas[0].items[0].result, null);

      /* The adapter's own loop: read, do the next thing, read again. */
      for (let i = 0; i < 60; i++) {
        const next = reconcile(await p.ask("sheet"), pm_areas())[0];

        if (!next) break;

        await p.ask(next.command, next.args);
        await settle();
      }

      const after = await p.ask("sheet");

      t.equal(reconcile(after, pm_areas()).length, 0, "the page still differs from ASH");

      const books = await p.read();
      const found = books.inspections[p.made[0].id];

      t.equal(find_item(find_area(found, "Kitchen"), "Sink").result, "follow_up");
      t.equal(find_item(find_area(found, "Kitchen"), "Sink").note, "Drips under the trap");
      t.equal(find_area(found, "Bedroom 2"), null, "a blank area ASH does not have stayed");
      t.equal(find_item(find_area(found, "Exterior"), "Siding").result, "follow_up");
      t.equal(found.area_adds, 1);
      t.equal(found.item_adds, 2);
    } finally {
      await p.done();
    }
  },

  async "an answer is one switch on and the other off, and a note that did not take is said so"(t) {
    const p = await site_for({ inspections: 1 });
    const kitchen = (name) => ({ area: "Kitchen", area_nth: 0, item: name, item_nth: 0 });
    const item_of = async (name) => find_item(find_area((await p.read()).inspections[p.made[0].id], "Kitchen"), name);
    const books_set = async (change) => {
      const books = await p.read();

      change(books);
      await chrome.storage.local.set({ [p.store]: books });
    };

    try {
      /* Both switches on, as a press of OK inside the form left one on 2026-10-22. */
      await books_set((books) => {
        const fridge = find_item(find_area(books.inspections[p.made[0].id], "Kitchen"), "Refrigerator");

        Object.assign(fridge, { ok: true, flag: true, result: "both" });
      });
      await p.go(`/inspections/${p.made[0].id}`);

      t.equal((await p.ask("sheet")).areas[0].items.find((i) => i.name === "Refrigerator").result, "both", "both switches on read as one answer");

      await p.ask("set_item", { ...kitchen("Refrigerator"), result: "ok", note: "Seal is fine" });
      await settle();

      const fridge = await item_of("Refrigerator");

      t.deep([fridge.ok, fridge.flag, fridge.note], [true, false, "Seal is fine"], "FOLLOW-UP was left on, or the note lost");

      /* The page says Saved and keeps no note: refused, not reported done. */
      await books_set((books) => {
        books.drop_notes = 1;
      });

      let refused = null;

      try {
        await p.ask("set_item", { ...kitchen("Sink"), result: "follow_up", note: "Drips under the trap" });
      } catch (error) {
        refused = error;
      }

      t.ok(refused && /did not take/.test(refused.message), `a lost note was not refused (${refused?.message})`);
      t.equal(refused?.error_class, "transient");
      t.deep([(await item_of("Sink")).flag, (await item_of("Sink")).note], [true, ""], "the switch is saved by its press, the note is not");

      await p.ask("set_item", { ...kitchen("Sink"), result: "follow_up", note: "Drips under the trap" });
      await settle();

      t.equal((await item_of("Sink")).note, "Drips under the trap", "the next try did not save the note");
    } finally {
      await p.done();
    }
  },

  async "photographs are staged, attached to the item's form and saved with it"(t) {
    const p = await site_for({ inspections: 1 });
    const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9));
    const where = { area: "Kitchen", area_nth: 0, item: "Sink", item_nth: 0 };

    try {
      await p.go(`/inspections/${p.made[0].id}`);

      await p.ask("stage_photo", { name: "a.jpg", mime_type: "image/jpeg", b64: jpeg });
      await p.ask("stage_photo", { name: "b.jpg", mime_type: "image/jpeg", b64: jpeg });

      t.deep(await p.ask("attach_photos", where), { attached: 2 });

      await p.ask("save_item", where);
      await settle();

      const sink = (await p.ask("sheet")).areas[0].items.find((i) => i.name === "Sink");
      const found = (await p.read()).inspections[p.made[0].id];

      t.equal(sink.photos, 2, "the page does not show the photographs");
      t.equal(found.uploads, 1);
    } finally {
      await p.done();
    }
  },

  async "Mark Inspection Done is pressed and the page says Done"(t) {
    const p = await site_for({ inspections: 1 });

    try {
      await p.go(`/inspections/${p.made[0].id}`);
      await p.ask("mark_done");
      await settle();

      t.equal((await p.ask("state")).status, "DONE");
      t.equal((await p.read()).inspections[p.made[0].id].done_presses, 1);
    } finally {
      await p.done();
    }
  },

  async "a signed-out AppFolio says so"(t) {
    const p = await site_for({ signed_in: false });

    try {
      await p.go("/maintenance/inspections");

      t.equal((await p.ask("state")).signed_in, false);
    } finally {
      await p.done();
    }
  },

  async "the probe finds every hook on every page"(t) {
    const p = await site_for({ inspections: 1 });

    try {
      for (const route of ["/maintenance/inspections", "/maintenance/inspections/new", `/inspections/${p.made[0].id}`]) {
        await p.go(route);

        const probe = await p.ask("probe");

        t.deep(probe.missing, [], `${route} is missing ${probe.missing.join(", ")}`);
      }
    } finally {
      await p.done();
    }
  },
};
