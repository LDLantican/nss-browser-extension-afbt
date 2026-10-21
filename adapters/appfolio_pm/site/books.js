/**
 * A pretend AppFolio, property-manager side: the books behind its inspections
 * (roadmap phase 12).
 *
 * There is no AppFolio sandbox, and "no inspection created twice, no photograph
 * uploaded twice" is what the tests prove, so the adapter is exercised against
 * these books: the units the New Inspection form can find, and inspections as
 * AppFolio keeps them — areas holding items, each OK or Follow-up with a note
 * and photographs, a status, a name. Plain data and pure functions, so the
 * same books back the pretend pages in Chrome (site.js) and the tests under
 * Node (tests/support/fake_pm.js).
 *
 * The shape is what was read off Camelot's AppFolio on 2026-10-20
 * (docs/pm-adapter.md): a new inspection starts from AppFolio's default
 * layout, below, exactly.
 *
 * Every create, item save, upload, area or item added or removed, and done
 * press is **counted**, duplicates included. Nothing here refuses a second
 * create or a second upload, as AppFolio does not: refusing would hide the bug
 * the tests exist to catch.
 */

export const BOOKS_KEY = "appfolio_pm_fixture";

/** Camelot's AppFolio, as the web app's connection names it. */
export const HOST = "camelotproperties.appfolio.com";

/** AppFolio's default layout, as Camelot's AppFolio offered it on 2026-10-20. */
export const DEFAULT_LAYOUT = [
  ["Kitchen", ["Refrigerator", "Sink", "Oven/Stove", "Cabinets", "Countertops"]],
  ["Living Room", ["Windows", "Doors"]],
  ["Bedroom 1", ["Windows", "Doors"]],
  ["Bedroom 2", ["Windows", "Doors"]],
  ["Bathroom 1", ["Sink", "Toilet", "Shower/Tub"]],
  ["Compliance", ["Smoke Detector", "Outlets", "Heater/AC", "Water Heater"]],
];

export const IN_PROGRESS = "IN PROGRESS";
export const DONE = "DONE";

export function empty_books() {
  return { signed_in: true, next_id: 900, next_item: 1, units: [], inspections: {}, creates: 0 };
}

/** A unit the address search finds, labelled as AppFolio labels one. */
export function add_unit(books, { name, street, city = "Montgomery", state = "AL", zip = "36107", kind = "unit" }) {
  const unit = { kind, label: `${name} - ${street} ${city}, ${state} ${zip}`, street, city, state, zip, address: `${street}, ${city}, ${state} ${zip}` };

  books.units.push(unit);

  return unit;
}

/** What the address search answers for `query`: units and properties, and residents beside them. */
export function search_units(books, query) {
  const wanted = String(query || "").trim().toLowerCase();

  if (wanted === "") return [];

  return books.units
    .filter((unit) => unit.label.toLowerCase().includes(wanted))
    .flatMap((unit) => [unit, { kind: "resident", label: `A Resident - ${unit.label}`, street: unit.street, address: unit.address }]);
}

/*
 * OK and FOLLOW-UP are two switches, not one answer, and either can be on with
 * the other (read on Camelot's AppFolio, 2026-10-22). `result` is kept beside
 * them as what a person reading the sheet would call it, "both" included.
 */
function item(books, name) {
  return { id: `item_${books.next_item++}`, name, ok: false, flag: false, result: null, note: "", photos: 0 };
}

function settle(target) {
  target.result = target.ok && target.flag ? "both" : target.flag ? "follow_up" : target.ok ? "ok" : null;
}

/** A switch pressed: it flips, and is saved at once, form open or not. */
export function press(books, id, item_id, which) {
  const inspection = by_id(books, id);
  const target = inspection.areas.flatMap((a) => a.items).find((i) => i.id === item_id);

  inspection.saves++;
  target[which] = !target[which];
  settle(target);

  return target;
}

function area(books, name, items = []) {
  return { id: `area_${books.next_item++}`, name, items: items.map((n) => item(books, n)) };
}

/** Start Inspection: a new inspection on the default layout. */
export function create(books, { name, date, unit_label }) {
  const unit = books.units.find((u) => u.label === unit_label);
  const id = String(books.next_id++);

  books.creates++;
  books.inspections[id] = {
    id,
    name: String(name),
    date: String(date || ""),
    address: unit?.address || "",
    street: unit?.street || "",
    status: IN_PROGRESS,
    areas: DEFAULT_LAYOUT.map(([n, items]) => area(books, n, items)),
    saves: 0,
    uploads: 0,
    area_adds: 0,
    item_adds: 0,
    removals: 0,
    done_presses: 0,
  };

  return books.inspections[id];
}

export function by_id(books, id) {
  return books.inspections[String(id)] || null;
}

/** The list, newest first, narrowed to a property when one is chosen. */
export function list(books, { street = "" } = {}) {
  const wanted = String(street || "").trim().toLowerCase();

  return Object.values(books.inspections)
    .filter((i) => wanted === "" || i.street.toLowerCase() === wanted)
    .sort((a, b) => Number(b.id) - Number(a.id));
}

/** The nth area called `name` (0-based), or null. */
export function find_area(inspection, name, nth = 0) {
  return inspection.areas.filter((a) => a.name === name)[nth] || null;
}

/** The nth item called `name` in an area, or null. */
export function find_item(found_area, name, nth = 0) {
  return found_area ? found_area.items.filter((i) => i.name === name)[nth] || null : null;
}

export function add_area(books, id, name) {
  const inspection = by_id(books, id);

  inspection.area_adds++;
  inspection.areas.push(area(books, name));

  return inspection;
}

/** Add Item, named and saved: AppFolio's new item is written on its first Save. */
export function add_item(books, id, area_id, name) {
  const inspection = by_id(books, id);
  const target = inspection.areas.find((a) => a.id === area_id);

  inspection.item_adds++;
  target.items.push(item(books, name));

  return target.items[target.items.length - 1];
}

/** Save on an item's edit form: its answer, its note, and any photographs chosen. */
export function save_item(books, id, item_id, { result, note, photos = 0 }) {
  const inspection = by_id(books, id);
  const target = inspection.areas.flatMap((a) => a.items).find((i) => i.id === item_id);

  inspection.saves++;

  /* A whole answer, as a new item's first Save or the Node fakes give it: that
     switch on, the other off. */
  if (result !== undefined) {
    target.ok = result === "ok";
    target.flag = result === "follow_up";
    settle(target);
  }

  /* `drop_notes` makes the next saves lose their note, as the background tab
     of 2026-10-22 did, so a page that says Saved and kept nothing is tested. */
  if (note !== undefined && books.drop_notes > 0) books.drop_notes--;
  else if (note !== undefined) target.note = String(note ?? "");

  if (photos > 0) {
    inspection.uploads++;
    target.photos += photos;
  }

  return target;
}

export function delete_item(books, id, item_id) {
  const inspection = by_id(books, id);

  inspection.removals++;
  for (const a of inspection.areas) a.items = a.items.filter((i) => i.id !== item_id);
}

export function delete_area(books, id, area_id) {
  const inspection = by_id(books, id);

  inspection.removals++;
  inspection.areas = inspection.areas.filter((a) => a.id !== area_id);
}

export function mark_done(books, id) {
  const inspection = by_id(books, id);

  inspection.done_presses++;
  inspection.status = DONE;

  return inspection;
}

/** The page's own reading of an inspection: areas, items, answers, photographs. */
export function sheet_of(inspection) {
  return {
    status: inspection.status,
    title: inspection.name,
    areas: inspection.areas.map((a) => ({ name: a.name, items: a.items.map(({ name, result, note, photos }) => ({ name, result, note, photos })) })),
  };
}
