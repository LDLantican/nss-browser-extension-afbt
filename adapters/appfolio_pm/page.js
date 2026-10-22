/**
 * The appfolio_pm adapter's page half: a content script on Camelot's AppFolio
 * inspection pages (roadmap phase 12; ADR-008).
 *
 * It answers one small command at a time from the service worker (adapter.js),
 * reached as `ASH_PAGE_COMMAND`, and keeps nothing between commands except the
 * photographs staged for the item being photographed — which a reload throws
 * away, and the adapter stages again. Every command waits for the page to be
 * ready first: a React page that has not rendered is not an empty one.
 *
 * The commands that change something AppFolio keeps — start, add_area,
 * add_item, set_item, delete_item, delete_area, save_item and mark_done —
 * each do their one thing and answer. The adapter sends them with `once`,
 * after the web app's commit, and never asks again. Everything else reads, or
 * types into a form nobody has saved.
 *
 * Items and areas are named by name and occurrence (`area_nth`, `item_nth`),
 * because a house can have two areas both called "Bedroom" and AppFolio's
 * item ids are not ASH's.
 *
 * The same script runs on the pretend AppFolio packaged in the extension
 * (site/), told apart by its `?frame=`, reading its route from the hash.
 */

(() => {
  const S = globalThis.ash_pm?.SELECTORS;
  const T = globalThis.ash_pm?.TEXT;

  if (!S || !T || globalThis.ash_pm.page_started) return;

  globalThis.ash_pm.page_started = true;

  const READY_MS = 15000;
  const RESULT_MS = 10000;
  const SAVE_MS = 20000;
  const DIALOG_MS = 4000;
  const BRIDGE_MS = 1500;

  const fixture = location.protocol === "chrome-extension:";
  const frame = fixture ? new URLSearchParams(location.search).get("frame") : null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const refuse = (message, error_class = "adapter_broken") => Object.assign(new Error(message), { error_class });
  /* As adapter.js compares notes: spacing and zero-width spaces do not count. */
  const squash = (text) => String(text ?? "").replace(/[ ​]/g, " ").replace(/\s+/g, " ").trim();

  const app = {
    staged: [],

    init() {
      chrome.runtime.onMessage.addListener(app.on_message);
    },

    on_message(message, sender, respond) {
      if (message?.type !== "ASH_PAGE_COMMAND") return false;
      if (sender?.id !== chrome.runtime.id) return false;
      if (fixture && (message.frame ?? null) !== frame) return false;

      app
        .handle(message.command, message.args || {})
        .then((result) => respond({ ok: true, result }))
        .catch((error) => respond({ ok: false, error: error?.message || String(error), error_class: error?.error_class || "adapter_broken" }));

      return true;
    },

    async handle(command, args) {
      if (command === "probe") return app.probe();

      await app.ready();

      switch (command) {
        case "state":
          return app.state();
        case "find_in_list":
          return app.find_in_list(args);
        case "open_row":
          return app.open_row(args);
        case "row_url":
          return app.row_url(args);
        case "fill_new":
          return app.fill_new(args);
        case "start":
          return app.press(document.querySelector(S.start_button), "Start Inspection");
        case "sheet":
          return app.sheet();
        case "add_area":
          return app.add_area(args);
        case "add_item":
          return app.add_item(args);
        case "set_item":
          return app.set_item(args);
        case "delete_item":
          return app.delete_item(args);
        case "delete_area":
          return app.delete_area(args);
        case "stage_photo":
          return app.stage_photo(args);
        case "attach_photos":
          return app.attach_photos(args);
        case "save_item":
          return app.save_item(args);
        case "mark_done":
          return app.mark_done();
        default:
          throw refuse(`Unknown command: ${command}`);
      }
    },

    // -- Where we are -----------------------------------------------------------

    route() {
      return fixture ? location.hash.replace(/^#/, "") || "/" : location.pathname;
    },

    kind() {
      const route = app.route();

      if (/^\/inspections\/\d+/.test(route)) return "inspection";
      if (/^\/maintenance\/inspections\/new/.test(route)) return "new";
      if (/^\/maintenance\/inspections\/?$/.test(route)) return "list";

      return "other";
    },

    signed_out() {
      const password = document.querySelector(S.password);

      return Boolean(password && password.offsetParent !== null) || T.signed_out_title.test(document.title);
    },

    rendered() {
      switch (app.kind()) {
        case "list":
          return document.querySelector(S.list_table) !== null;
        case "new":
          return document.querySelector(S.new_form) !== null;
        case "inspection":
          return document.querySelector(S.title) !== null && document.querySelector(S.area_name) !== null;
        default:
          return true;
      }
    },

    async ready() {
      const until = Date.now() + READY_MS;

      while (!app.rendered()) {
        if (app.signed_out()) return;
        if (Date.now() > until) throw refuse(`The ${app.kind()} page did not finish loading.`, "transient");

        await sleep(200);
      }
    },

    state() {
      if (app.signed_out()) return { signed_in: false, kind: app.kind() };

      const id = /^\/inspections\/(\d+)/.exec(app.route())?.[1] || null;
      const title = document.querySelector(S.title);

      return {
        signed_in: true,
        kind: app.kind(),
        id,
        title: title ? title.textContent.trim() : null,
        status: title ? app.status_of(title) : null,
        address: app.text(S.address).replace(/^property:\s*/i, ""),
      };
    },

    /** The badge beside the title: "IN PROGRESS", "DONE". */
    status_of(title) {
      const badge = title.nextElementSibling || title.parentElement?.querySelector(".badge");

      return badge ? badge.textContent.trim().toUpperCase() : null;
    },

    // -- The list ---------------------------------------------------------------

    rows() {
      return [...document.querySelectorAll(S.list_row)];
    },

    /**
     * Look for an inspection whose name carries `tag` (INS-000045). The list
     * holds only a window of inspections and has no name search, so it is
     * narrowed to the property first; only a narrowed list that does not show
     * the tag is evidence that the inspection does not exist (`settled`).
     */
    async find_in_list({ tag, street }) {
      if (app.kind() !== "list") throw refuse("Not on the inspection list.");

      const wanted = String(tag || "").trim();
      const seen = () => app.rows().findIndex((row) => row.textContent.includes(wanted));

      if (wanted === "") throw refuse("Nothing to look for.", "permanent");

      const filtered = await app.filter_by_property(String(street || ""));
      const index = seen();

      return { found: index >= 0, row: index, filtered, settled: filtered, rows: app.rows().length };
    },

    /** Narrow the list to one property through the filter's Properties box. True once it is applied. */
    async filter_by_property(street) {
      if (street.trim() === "") return false;

      if (!document.querySelector(S.property_control)) {
        const open = [...document.querySelectorAll(S.list_search_open)].find((b) => T.search_open.test(b.textContent.trim()));

        open?.click();
        await app.until(() => document.querySelector(S.property_control), "The list's filter did not open.", RESULT_MS).catch(() => null);
      }

      const control = document.querySelector(S.property_control);
      const input = control?.querySelector(S.property_input);

      if (!input) return false;

      input.focus();
      app.type(input, street);

      const option = await app
        .until(
          () => [...document.querySelectorAll(S.property_option)].find((o) => o.textContent.toLowerCase().includes(street.trim().toLowerCase())),
          "No property matched.",
          RESULT_MS,
        )
        .catch(() => null);

      if (!option) return false;

      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      option.click();

      const search = [...document.querySelectorAll(S.search_button)].find((b) => T.search.test(b.textContent.trim()));

      if (!search) return false;

      const before = app.rows().map((r) => r.textContent).join("|");

      search.click();

      /* Settled when the rows have changed, or have stayed the same for a while. */
      const until = Date.now() + RESULT_MS;
      let quiet = 0;
      let last = before;

      while (Date.now() < until) {
        await sleep(250);

        const now = app.rows().map((r) => r.textContent).join("|");

        if (now !== last) {
          last = now;
          quiet = 0;
        } else if (++quiet >= 8) break;
      }

      return true;
    },

    /** Click the row carrying `tag`: AppFolio opens the inspection in a new tab. */
    open_row({ tag }) {
      const row = app.rows().find((r) => r.textContent.includes(String(tag || "")));

      if (!row) throw refuse(`No row carries ${tag}.`, "transient");

      const cell = [...row.querySelectorAll("td.cursor-pointer, td")].find((td) => td.textContent.includes(String(tag)));

      (cell || row).click();

      return { clicked: true };
    },

    /*
     * The address a row would open, without opening it. AppFolio opens a row's
     * inspection with window.open, which Chrome's popup blocker refuses for a
     * script's click in a background tab (found 2026-10-22, when a verification
     * saw INS-000004 on the list and could not open it). page_bridge.js makes
     * the row's own click with window.open intercepted and hands back the
     * address. `url: null` means there was no bridge, and the adapter opens the
     * row in a tab the old way.
     */
    async row_url({ tag }) {
      const row = app.rows().find((r) => r.textContent.includes(String(tag || "")));

      if (!row) throw refuse(`No row carries ${tag}.`, "transient");

      const cell = [...row.querySelectorAll("td.cursor-pointer, td")].find((td) => td.textContent.includes(String(tag))) || row;

      cell.setAttribute("data-ash-open", "");

      try {
        const reply = await app.bridge("row_url");

        if (reply.ok) return { url: reply.url };
        if (reply.reason === "unavailable") return { url: null };

        throw refuse(`The row for ${tag} gave no address: ${reply.reason}`, "transient");
      } finally {
        cell.removeAttribute("data-ash-open");
      }
    },

    // -- The new-inspection form ------------------------------------------------

    /**
     * Fill the form: the name, the date, the address — a unit or property row
     * whose label carries the street (and the unit, when there is one), never a
     * resident row — and AppFolio's default layout. Nothing is saved.
     */
    async fill_new({ name, date, street, unit = null }) {
      if (app.kind() !== "new") throw refuse("Not on the new-inspection form.");

      app.type(document.querySelector(S.name_input), name);
      app.type(document.querySelector(S.date_input), date);

      const chosen = await app.choose_address(String(street || ""), unit ? String(unit) : null);
      const layout = document.querySelector(S.layout_default);

      if (layout && !layout.checked) layout.click();

      return {
        name: document.querySelector(S.name_input)?.value ?? null,
        date: document.querySelector(S.date_input)?.value ?? null,
        address: chosen,
        layout: layout ? layout.checked : null,
      };
    },

    /*
     * The address box is select2 3, which searches only while its search box
     * has focus — and this is a background tab, where it never does. So the
     * search and the pick go through select2's own API, by way of
     * page_bridge.js in the page's world; typing is the fallback, for a
     * page where the bridge finds no select2 to drive. Which result is taken
     * is decided here either way.
     */
    async choose_address(street, unit) {
      const container = document.querySelector(S.address_container);
      const opener = container?.querySelector(S.address_choice) || container;

      if (!opener) throw refuse("The form has no address search.");

      const bridged = await app.bridge("search", { input: S.address_value, term: street });

      if (!bridged.ok && bridged.reason !== "unavailable") throw refuse(`The address search failed: ${bridged.reason}`, "transient");

      if (!bridged.ok) {
        /* select2 opens on mousedown. */
        opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const search = await app.until(() => document.querySelector(S.address_search), "The address search did not open.", RESULT_MS);

        app.type(search, street);
        search.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "e" }));
      }

      const wanted = street.trim().toLowerCase();
      const fits = (li) => {
        const label = li.textContent.toLowerCase();

        return label.includes(wanted) && (unit === null || label.includes(unit.toLowerCase()));
      };
      const places = () =>
        [...document.querySelectorAll(S.address_result)].filter((li) => li.querySelector(`${S.address_kind_unit}, ${S.address_kind_property}`) && fits(li));

      const found = await app.until(() => (places().length ? places() : null), `AppFolio found no property or unit at ${street}.`, RESULT_MS);

      /* One fits, or the building itself; anything else is a person's call. */
      const pick = found.length === 1 ? found[0] : found.find((li) => li.querySelector(S.address_kind_property)) || null;

      if (!pick) throw refuse(`More than one unit at ${street} fits; say which.`, "permanent");

      const label = pick.textContent.trim();

      if (bridged.ok) {
        pick.setAttribute("data-ash-pick", "");

        const picked = await app.bridge("pick", { input: S.address_value, results: S.address_pickable });

        if (!picked.ok) throw refuse(`The address could not be chosen: ${picked.reason}`, "transient");
      } else {
        pick.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }

      /* Taken: the box shows the start of the row picked ("Boyce 415"), and
         the bound input holds its id. Otherwise Start would make an
         inspection with no address. */
      const taken = () => {
        const chosen = document.querySelector(S.address_container)?.querySelector(S.address_chosen)?.textContent.trim() || "";
        const value = document.querySelector(S.address_value)?.value || "";

        return chosen !== "" && label.startsWith(chosen) && value !== "" ? true : null;
      };

      await app.until(taken, "AppFolio did not take the address.", RESULT_MS).catch(() => {
        throw refuse("AppFolio did not take the address.", "transient");
      });

      return label;
    },

    /** Ask page_bridge.js, in the page's world, to do one thing. No answer is "unavailable". */
    bridge(op, args = {}) {
      const id = crypto.randomUUID();

      return new Promise((resolve) => {
        const done = (event) => {
          let reply;

          try {
            reply = JSON.parse(String(event.detail));
          } catch {
            return;
          }

          if (reply?.id !== id) return;

          clearTimeout(timer);
          document.removeEventListener("ash:bridge:done", done);
          resolve(reply);
        };
        const timer = setTimeout(() => {
          document.removeEventListener("ash:bridge:done", done);
          resolve({ ok: false, reason: "unavailable" });
        }, BRIDGE_MS);

        document.addEventListener("ash:bridge:done", done);
        document.dispatchEvent(new CustomEvent("ash:bridge", { detail: JSON.stringify({ id, op, ...args }) }));
      });
    },

    // -- An inspection ----------------------------------------------------------

    /** The inspection as AppFolio shows it: areas, items, answers, notes, photographs. */
    sheet() {
      if (app.kind() !== "inspection") throw refuse("Not on an inspection.");

      const state = app.state();

      return {
        title: state.title,
        status: state.status,
        areas: app.area_cards().map((card) => ({
          name: card.querySelector(S.area_name)?.textContent.trim() || "",
          items: [...card.querySelectorAll(S.item)].map((li) => app.read_item(li)),
        })),
      };
    },

    area_cards() {
      return [...document.querySelectorAll(S.area_name)].map((name) => name.closest(S.area_card)).filter(Boolean);
    },

    read_item(li) {
      const chosen = (selector) => T.chosen.test(li.querySelector(selector)?.className || "");
      /* In an open form the name is in its input; the label beside it says "Name*". */
      const input = li.querySelector(S.item_name_input);

      return {
        name: input ? input.value.trim() : li.querySelector(S.item_name)?.textContent.trim() || "",
        /* Two switches, which can both be on; "both" is not an answer ASH
           gives, so the fill sees it as a difference and puts it right. */
        result: chosen(S.flag) && chosen(S.ok) ? "both" : chosen(S.flag) ? "follow_up" : chosen(S.ok) ? "ok" : null,
        note: li.querySelector(S.description)?.textContent.trim() || "",
        /* An open form shows the photographs attached to it as the same
           thumbnails, before anything is saved (read live, 2026-10-22), so
           while it is open the item's count is not known. Counting them is
           how a hand-over once read an unsaved form as "Saved by hand". */
        photos: input || li.querySelector(S.notes) ? null : li.querySelectorAll(S.photo_thumb).length,
      };
    },

    card({ area, area_nth = 0 }) {
      const card = app.area_cards().filter((c) => c.querySelector(S.area_name)?.textContent.trim() === area)[area_nth];

      if (!card) throw refuse(`There is no area "${area}" (${area_nth + 1}).`, "transient");

      return card;
    },

    /**
     * The item `args` names, found afresh: the page may redraw an item when its
     * form opens or closes, so an element held from before is not trusted.
     */
    find_li(args) {
      const card = app.area_cards().filter((c) => c.querySelector(S.area_name)?.textContent.trim() === args.area)[args.area_nth ?? 0];

      return card ? [...card.querySelectorAll(S.item)].filter((i) => app.read_item(i).name === args.item)[args.item_nth ?? 0] || null : null;
    },

    item_li(args) {
      const li = app.find_li(args);

      if (!li) throw refuse(`There is no item "${args.item}" in ${args.area}.`, "transient");

      return li;
    },

    /** Open an item's edit form, and wait for it; the item, open. */
    async edit(args) {
      const li = app.item_li(args);

      if (!li.querySelector(S.notes)) app.press(li.querySelector(S.edit), "Edit");

      return app.until(() => (app.find_li(args)?.querySelector(S.notes) ? app.find_li(args) : null), "The item's edit form did not open.", RESULT_MS);
    },

    /** Press Save on an open item form, and wait for the form to close. */
    async save(args) {
      app.press(app.item_li(args).querySelector(S.save), `Save (${args.item})`);

      await app.until(() => {
        const li = app.find_li(args);

        return li && !li.querySelector(S.notes) ? li : null;
      }, `Save on ${args.item} did not finish.`, SAVE_MS);
    },

    /** How many items of this name the area has: what a deletion is seen by. */
    count_named(args) {
      const card = app.area_cards().filter((c) => c.querySelector(S.area_name)?.textContent.trim() === args.area)[args.area_nth ?? 0];

      return card ? [...card.querySelectorAll(S.item)].filter((i) => app.read_item(i).name === args.item).length : 0;
    },

    count_areas(name) {
      return app.area_cards().filter((c) => c.querySelector(S.area_name)?.textContent.trim() === name).length;
    },

    async add_area({ name }) {
      const button = [...document.querySelectorAll("button")].find((b) => T.add_area.test(b.textContent.trim()));

      app.press(button, "Add Area");

      const input = await app.until(
        () => [...document.querySelectorAll(S.area_name_input)].find((i) => i.value === ""),
        "Add Area did not add a card.",
        RESULT_MS,
      );

      app.type(input, name);

      /*
       * Enter saves the name (read live on 2026-10-22; leaving the field would
       * too, but a background tab's field never has focus to leave, and one
       * save is wanted, not two). The card shows the name at once, with Add
       * Item still disabled, and is replaced by the saved one about 0.6 s
       * later: kept means that saved card, Add Item enabled. Taking the first
       * for the second is how a fill once pressed a disabled Add Item.
       */
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13 }));

      await app.until(
        () =>
          app.area_cards().some((c) => c.querySelector(S.area_name)?.textContent.trim() === name && c.querySelector(S.add_item)?.disabled === false)
            ? true
            : null,
        `The area "${name}" was not kept.`,
        SAVE_MS,
      );

      return { added: name };
    },

    async add_item({ area, area_nth = 0, name }) {
      const items = () => [...app.card({ area, area_nth }).querySelectorAll(S.item)];
      const count = items().length;

      app.press(app.card({ area, area_nth }).querySelector(S.add_item), "Add Item");

      const field = await app.until(() => {
        const now = items();

        return now.length > count ? now[now.length - 1].querySelector(S.item_name_input) : null;
      }, "Add Item did not add an item with a name field.", RESULT_MS);

      app.type(field, name);

      const where = { area, area_nth, item: name, item_nth: app.count_named({ area, area_nth, item: name }) - 1 };

      await app.save(where);

      /* Saved, as an area is: the item shows with its Edit button usable, not
         merely the form gone (2026-10-22). */
      await app.until(() => (app.find_li(where)?.querySelector(S.edit)?.disabled === false ? true : null), `The item "${name}" was not kept.`, SAVE_MS);

      return { added: name };
    },

    /*
     * An item's answer and note, as read live on 2026-10-22: OK and FOLLOW-UP
     * are two switches, each saved the moment it is pressed (in the form or
     * not, and Cancel does not take it back), and either can be on with the
     * other. So the wanted one is put on and the other off, each press waited
     * for. The note is written after, into the form as it then stands — opened
     * again if a press closed it — and must show on the item once saved: the
     * background tab of 2026-10-22 pressed Save, saw the form close and kept no
     * note, and nothing said so.
     */
    async set_item(args) {
      await app.edit(args);

      for (const [selector, wanted, what] of [
        [S.flag, args.result === "follow_up", "Follow-up"],
        [S.ok, args.result === "ok", "OK"],
      ]) {
        const on = () => T.chosen.test(app.find_li(args)?.querySelector(selector)?.className || "");

        if (on() === wanted) continue;

        app.press(app.item_li(args).querySelector(selector), what);
        await app.until(() => (on() === wanted ? true : null), `${what} on ${args.item} did not ${wanted ? "take" : "come off"}.`, RESULT_MS);
      }

      const note = squash(args.note);

      if (squash(app.read_item(app.item_li(args)).note) === note && !app.item_li(args).querySelector(S.notes)) return { saved: args.item };

      await app.edit(args);
      app.type(app.item_li(args).querySelector(S.notes), args.note ?? "");
      await app.save(args);
      await app
        .until(() => (squash(app.read_item(app.item_li(args)).note) === note ? true : null), `The note on ${args.item} did not take.`, SAVE_MS)
        .catch((error) => {
          throw refuse(error.message, "transient");
        });

      return { saved: args.item };
    },

    async delete_item(args) {
      const before = app.count_named(args);

      await app.edit(args);
      app.press(app.item_li(args).querySelector(S.delete_item), "Delete Item");
      await app.confirm_if_asked();
      await app.until(() => app.count_named(args) < before, `${args.item} was not deleted.`, SAVE_MS);

      return { deleted: args.item };
    },

    async delete_area(args) {
      const before = app.count_areas(args.area);

      app.press(app.card(args).querySelector(S.delete_area), "Delete Area");
      await app.confirm_if_asked();
      await app.until(() => app.count_areas(args.area) < before, `${args.area} was not deleted.`, SAVE_MS);

      return { deleted: args.area };
    },

    stage_photo({ name, mime_type, b64 }) {
      const binary = atob(String(b64 || ""));
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      app.staged.push(new File([bytes], String(name || "photo.jpg"), { type: String(mime_type || "image/jpeg") }));

      return { staged: app.staged.length };
    },

    /** Open the item's form and put every staged photograph in its file input. Nothing is saved. */
    async attach_photos(args) {
      const li = await app.edit(args);
      const input = li.querySelector(S.file_input);

      if (!input) throw refuse("The item's form has no photo input.");

      const transfer = new DataTransfer();

      for (const file of app.staged) transfer.items.add(file);

      const wanted = app.staged.length;

      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      app.staged = [];

      await sleep(500);

      return { attached: input.files.length === wanted ? wanted : input.files.length };
    },

    async save_item(args) {
      if (!app.item_li(args).querySelector(S.notes)) throw refuse("The item's form is not open, so there is nothing to save.", "transient");

      await app.save(args);

      return { saved: args.item };
    },

    async mark_done() {
      const button =
        [...document.querySelectorAll("button")].find((b) => T.mark_done.test(b.textContent.trim()) && !b.closest(".dropdown-menu")) ||
        document.querySelector(S.mark_done);

      app.press(button, "Mark Inspection Done");
      await app.confirm_if_asked();

      return { clicked: true };
    },

    /** A guess, not yet seen live: press the confirming button of a dialog, if one opens. */
    async confirm_if_asked() {
      const until = Date.now() + DIALOG_MS;

      while (Date.now() < until) {
        const dialog = document.querySelector(S.dialog);
        const yes = dialog && ([...dialog.querySelectorAll("button")].find((b) => T.confirm.test(b.textContent.trim())) || dialog.querySelector(S.dialog_confirm));

        if (yes) {
          yes.click();

          return true;
        }

        await sleep(150);
      }

      return false;
    },

    // -- The probe --------------------------------------------------------------

    /** Read-only: which hooks this page has. Clicks nothing, waits for nothing. */
    probe() {
      const expected = {
        list: ["list_table", "list_row"],
        new: ["new_form", "name_input", "date_input", "address_container", "layout_default", "start_button"],
        inspection: ["title", "area_name", "delete_area", "add_item", "item", "item_name", "ok", "flag", "edit", "description"],
      }[app.kind()] || [];
      const found = [];
      const missing = [];

      for (const name of expected) (document.querySelector(S[name]) ? found : missing).push(name);

      return { kind: app.kind(), signed_in: !app.signed_out(), found, missing };
    },

    // -- Small things -----------------------------------------------------------

    press(button, what) {
      if (!button) throw refuse(`There is no ${what} button to press.`);
      if (button.disabled) throw refuse(`The ${what} button is disabled.`, "permanent");

      button.click();

      return { clicked: true };
    },

    async until(look, message, timeout = READY_MS) {
      const until = Date.now() + timeout;

      for (;;) {
        const seen = look();

        if (seen) return seen;
        if (Date.now() > until) throw refuse(message, "transient");

        await sleep(150);
      }
    },

    /** Write a value the way React will notice: the native setter, then input and change. */
    type(input, value) {
      if (!input) throw refuse("A form field is missing.");

      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;

      if (setter) setter.call(input, String(value ?? ""));
      else input.value = String(value ?? "");

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },

    text(selector) {
      return document.querySelector(selector)?.textContent.trim() || "";
    },
  };

  /*
   * Listening from the moment of injection, not from the page's `load`: in the
   * worker's background tab AppFolio's inspection page could take tens of
   * seconds to fire `load`, and every command until then found nobody there
   * (2026-10-22). Whether the page is ready is each command's own question
   * (`ready()`, which waits for it to render).
   */
  app.init();
})();
