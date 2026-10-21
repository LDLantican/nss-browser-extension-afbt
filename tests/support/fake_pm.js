/**
 * The appfolio_pm adapter's page script, without a page.
 *
 * Answers the commands adapters/appfolio_pm/page.js answers, against the same
 * books (adapters/appfolio_pm/site/books.js), so the service-worker half of the
 * adapter can be run — and killed — under Node. The DOM half is tested where
 * there is a DOM: tests/adapters/appfolio_pm_page_test.js, and on the live
 * AppFolio by the rollout ladder.
 *
 * A tab's page state is `tab.pm`: the new-inspection form being filled, the
 * photographs staged, the item form open. Navigating replaces the tab, which
 * empties all of it — as reloading a real page does. Opening a row of the
 * list opens a new tab, as AppFolio's list does.
 */

import {
  add_area,
  add_item,
  by_id,
  create,
  delete_area,
  delete_item,
  find_area,
  find_item,
  HOST,
  list,
  mark_done,
  save_item,
  search_units,
  sheet_of,
} from "../../adapters/appfolio_pm/site/books.js";
import { AdapterError } from "../../worker/errors.js";

/** Camelot's AppFolio; the end-to-end run uses a host of its own, and every page here answers for whichever host it is on. */
export const PM_ORIGIN = `https://${HOST}`;
const SIGN_IN_PATH = "/users/sign_in";

const origin_of = (url) => /^https:\/\/[^/]+/.exec(String(url))?.[0] ?? PM_ORIGIN;

/** Is this one of the property manager's AppFolio pages (not the vendor portal)? */
export function is_pm_url(url) {
  return /^https:\/\/[a-z0-9-]+\.appfolio\.com\//i.test(String(url || "")) && !String(url).startsWith("https://vendor.appfolio.com");
}

/** Where a tab opened at `url` lands: signed out, AppFolio sends it to sign in. */
export function pm_landing(books, url) {
  return is_pm_url(url) && books.signed_in === false ? `${origin_of(url)}${SIGN_IN_PATH}` : url;
}

function route(url) {
  const path = String(url).replace(/^https:\/\/[^/]+/, "");
  const inspection = /^\/inspections\/(\d+)/.exec(path);

  if (inspection) return { kind: "inspection", id: inspection[1] };
  if (/^\/maintenance\/inspections\/new/.test(path)) return { kind: "new", id: null };
  if (/^\/maintenance\/inspections\/?(\?|$)/.test(path)) return { kind: "list", id: null };

  return { kind: "other", id: null };
}

const broken = (message) => new AdapterError("adapter_broken", message);

function place(inspection, { area, area_nth = 0, item = null, item_nth = 0 }) {
  const found_area = find_area(inspection, area, area_nth);

  if (!found_area) throw new AdapterError("transient", `There is no area "${area}" (${area_nth + 1}).`);
  if (item === null) return { area: found_area, item: null };

  const found_item = find_item(found_area, item, item_nth);

  if (!found_item) throw new AdapterError("transient", `There is no item "${item}" in ${area}.`);

  return { area: found_area, item: found_item };
}

/**
 * @param world  the fake world: its books are `world.pm`, and opening a row opens a tab in `world.tabs`
 */
export function fake_pm_command(world, tab_id, tab, command, args) {
  const books = world.pm;

  if (tab.url === `${origin_of(tab.url)}${SIGN_IN_PATH}`) {
    if (command === "state" || command === "probe") return { signed_in: false, kind: "other" };

    throw new AdapterError("transient", `The page did not answer "${command}".`);
  }

  const here = route(tab.url);
  const inspection = here.id ? by_id(books, here.id) : null;

  if (here.id && !inspection) throw new AdapterError("transient", "The inspection did not finish loading.");

  tab.pm ??= { form: null, staged: 0, editing: null };

  const need = (kind) => {
    if (here.kind !== kind) throw broken(`Not on the ${kind} page.`);
  };

  switch (command) {
    case "state":
      return {
        signed_in: true,
        kind: here.kind,
        id: here.id,
        title: inspection?.name ?? null,
        status: inspection?.status ?? null,
        address: inspection?.address ?? "",
      };

    case "find_in_list": {
      need("list");

      const street = String(args.street || "").trim().toLowerCase();
      const filtered = street !== "" && books.units.some((unit) => unit.street.toLowerCase() === street);
      const rows = list(books, { street: filtered ? args.street : "" });
      const row = rows.findIndex((i) => i.name.includes(String(args.tag || "")));

      return { found: row >= 0, row, filtered, settled: filtered, rows: rows.length };
    }

    case "open_row": {
      need("list");

      const found = list(books).find((i) => i.name.includes(String(args.tag || "")));

      if (!found) throw new AdapterError("transient", `No row carries ${args.tag}.`);

      const id = world.next_tab++;

      world.tabs.set(id, { url: `${origin_of(tab.url)}/inspections/${found.id}`, opener: tab_id, form: [], staged: [], attached: 0, note: "" });

      return { clicked: true };
    }

    /* The address a row would open, read through page_bridge.js; nothing opens. */
    case "row_url": {
      need("list");

      const found = list(books).find((i) => i.name.includes(String(args.tag || "")));

      if (!found) throw new AdapterError("transient", `No row carries ${args.tag}.`);

      return { url: `${origin_of(tab.url)}/inspections/${found.id}` };
    }

    case "fill_new": {
      need("new");

      const street = String(args.street || "").toLowerCase();
      const unit = args.unit ? String(args.unit).toLowerCase() : null;
      const places = search_units(books, args.street).filter(
        (u) => u.kind !== "resident" && u.label.toLowerCase().includes(street) && (unit === null || u.label.toLowerCase().includes(unit)),
      );
      const pick = places.length === 1 ? places[0] : places.find((u) => u.kind === "property") || null;

      if (places.length === 0) throw new AdapterError("transient", `AppFolio found no property or unit at ${args.street}.`);
      if (!pick) throw new AdapterError("permanent", `More than one unit at ${args.street} fits; say which.`);

      tab.pm.form = { name: String(args.name ?? ""), date: String(args.date ?? ""), unit_label: pick.label };

      return { name: tab.pm.form.name, date: tab.pm.form.date, address: pick.label, layout: true };
    }

    case "start": {
      need("new");
      if (!tab.pm.form?.unit_label) throw broken("The form has no address chosen.");

      const made = create(books, tab.pm.form);

      /* Rails redirects to the new inspection; the form stays filled in the books, as the worst page would. */
      tab.url = `${origin_of(tab.url)}/inspections/${made.id}`;
      tab.pm = { form: null, staged: 0, editing: null };

      return { clicked: true };
    }

    case "sheet":
      need("inspection");

      return sheet_of(inspection);

    case "add_area":
      need("inspection");
      add_area(books, inspection.id, String(args.name || ""));

      return { added: args.name };

    case "add_item": {
      need("inspection");

      const { area } = place(inspection, args);

      add_item(books, inspection.id, area.id, String(args.name || ""));

      return { added: args.name };
    }

    case "set_item": {
      need("inspection");

      const { item } = place(inspection, args);

      save_item(books, inspection.id, item.id, { result: args.result ?? null, note: args.note ?? "" });

      return { saved: args.item };
    }

    case "delete_item": {
      need("inspection");

      const { item } = place(inspection, args);

      delete_item(books, inspection.id, item.id);

      return { deleted: args.item };
    }

    case "delete_area": {
      need("inspection");

      const { area } = place(inspection, args);

      delete_area(books, inspection.id, area.id);

      return { deleted: args.area };
    }

    case "stage_photo":
      need("inspection");
      tab.pm.staged++;

      return { staged: tab.pm.staged };

    case "attach_photos": {
      need("inspection");

      const { item } = place(inspection, args);

      tab.pm.editing = { item_id: item.id, files: tab.pm.staged };
      tab.pm.staged = 0;

      return { attached: tab.pm.editing.files };
    }

    case "save_item": {
      need("inspection");

      const { item } = place(inspection, args);

      if (tab.pm.editing?.item_id !== item.id) throw new AdapterError("transient", "The item's form is not open, so there is nothing to save.");

      /* The form stays as it was, as the worst page would: a second press would upload again. */
      save_item(books, inspection.id, item.id, { photos: tab.pm.editing.files });

      return { saved: args.item };
    }

    case "mark_done":
      need("inspection");
      mark_done(books, inspection.id);

      return { clicked: true };

    case "probe":
      return { kind: here.kind, signed_in: true, found: [], missing: [] };

    default:
      throw broken(`Unknown command: ${command}`);
  }
}
