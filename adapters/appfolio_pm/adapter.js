/**
 * The appfolio_pm adapter: the service-worker half (roadmap phase 12; ADR-014).
 *
 * It puts an inspection ASH approved into Camelot's AppFolio, as the property
 * manager, so the office can make work orders from its flags with AppFolio's
 * own Create Work Order(s). Four operations, queued in this order by the web
 * app, each a plan of short steps that ask the page script (page.js) one small
 * thing at a time, with exactly one commit step:
 *
 *   create       find_existing — the list, narrowed to the property, searched
 *                for ASH's number; prepare — the New Inspection form filled on
 *                AppFolio's default layout; Start Inspection; capture the id
 *                from `/inspections/{id}`.
 *   fill_areas   make AppFolio's areas and items what ASH's are: an area or
 *                item added on site is added, a default one ASH removed is
 *                removed (only while blank), and every item gets ASH's OK or
 *                Follow-up and its note.
 *   post_photos  one item's photographs, attached and saved; counted before
 *                and after, so a second upload is never made.
 *   mark_done    Mark Inspection Done.
 *
 * Everything the page shows is checked against what ASH sent: the inspection's
 * title must carry ASH's number, and carry the test mark exactly when the
 * connection is in test scope. Nothing is computed here: the web app projects
 * every value (App\Services\Integration\InspectionPayload).
 *
 * `fill_areas` is idempotent, so its commit step is a loop: read the sheet, do
 * the next thing that differs, read again. A worker that dies in the loop is
 * reported unknown, a verification finds the sheet still different, and the
 * retry does only what is left.
 */

import manifest from "./manifest.js";
import { AdapterError, PERMANENT, SESSION_EXPIRED, TRANSIENT, UNKNOWN_OUTCOME } from "../../worker/errors.js";

/** The cached answer to "is this browser signed in to the pm side?", per host. */
export const SESSION_KEY = "ash_pm_session";

export const LIST_PATH = "/maintenance/inspections";
export const NEW_PATH = "/maintenance/inspections/new?inspection%5Btemplate%5D=0";

const SESSION_FRESH_MS = 4 * 60 * 1000;
const PROBE_MS = 20000;
const LOOK_MS = 15000;
const LOOK_POLL_MS = 1000;
const NEW_TAB_MS = 15000;
const PERSON_WAIT_MS = 10 * 60 * 1000;
const PERSON_POLL_MS = 2000;
const MAX_ACTIONS = 200;

/** Reasons a probe tab could change; anything else a probe cannot fix. */
const PROBE_HELPS = new Set([null, "session_not_live", "session_stale", "heartbeat_stale", "adapter_not_reported"]);

const HOST = /^[a-z0-9-]+\.appfolio\.com$/i;
const INSPECTION_URL = /^https:\/\/([a-z0-9-]+\.appfolio\.com)\/inspections\/(\d+)/i;

const squash = (text) => String(text ?? "").replace(/[ ​]/g, " ").replace(/\s+/g, " ").trim();

// -- What the claim says --------------------------------------------------------

function host_of(connection) {
  const host = String(connection?.external_host || "").toLowerCase();

  return HOST.test(host) ? host : null;
}

function origin(ctx) {
  const host = host_of(ctx.job.connection);

  if (!host) throw new AdapterError(PERMANENT, "The connection names no AppFolio address to work in.");

  return `https://${host}`;
}

function header(ctx) {
  const inspection = ctx.job.payload?.inspection;

  if (!inspection?.public_id || !inspection?.name) throw new AdapterError(PERMANENT, "The claim carried no inspection.");

  return inspection;
}

/**
 * Test or live, three ways: the inspection's own flag, the connection's scope,
 * and — once there is a page — whether its title carries the test mark. All
 * three must agree before anything is typed (the owner's rule, 2026-10-20).
 */
function check_scope(ctx, title = null) {
  const inspection = header(ctx);
  const testing = ctx.job.connection?.scope !== "live";

  if (testing !== Boolean(inspection.is_test))
    throw new AdapterError(PERMANENT, testing ? "A test connection was handed a live inspection." : "A live connection was handed a test inspection.");

  if (title === null) return;

  const marker = squash(inspection.test_marker || "TEST");
  const marked = squash(title).split(/\s*·\s*/).includes(marker);

  if (testing && !marked) throw new AdapterError(PERMANENT, `The connection is in test mode, but "${title}" in AppFolio is not marked ${marker}.`);
  if (!testing && marked) throw new AdapterError(PERMANENT, `The connection is live, but "${title}" in AppFolio is marked ${marker}.`);
}

function identity_of(ctx) {
  return ctx.data.id ? { id: String(ctx.data.id), url: `${origin(ctx)}/inspections/${ctx.data.id}` } : null;
}

// -- Pages --------------------------------------------------------------------

/**
 * What the page in this job's tab says about itself. A signed-out AppFolio
 * sends the tab to a sign-in page, where no page script answers, so the
 * address is watched while asking.
 */
async function page_state(ctx) {
  const until = ctx.now() + PROBE_MS;
  const base = origin(ctx);

  for (;;) {
    const url = await ctx.tab_url();

    if (url && (!url.startsWith(base) || /sign_in|login|passport/i.test(url)))
      throw new AdapterError(SESSION_EXPIRED, "This browser is signed out of the property manager's AppFolio.");

    let state = null;

    try {
      state = await ctx.ask("state", {}, { timeout_ms: 3000 });
    } catch (error) {
      if (error?.error_class !== TRANSIENT || ctx.now() > until) throw error;
    }

    if (state?.signed_in === false) throw new AdapterError(SESSION_EXPIRED, "This browser is signed out of the property manager's AppFolio.");
    if (state) return state;

    await ctx.sleep(LOOK_POLL_MS);
  }
}

async function go(ctx, url, kind) {
  await ctx.open(url);

  const state = await page_state(ctx);

  if (state.kind !== kind) throw new AdapterError(TRANSIENT, `Expected the ${kind} page, but AppFolio shows ${state.kind}.`);

  return state;
}

/** The inspection this job works on, as its link names it. */
function inspection_url(ctx) {
  const match = INSPECTION_URL.exec(String(ctx.data.url || ctx.job.link?.url || ""));

  if (!match) throw new AdapterError(PERMANENT, "This inspection has no AppFolio inspection linked to it yet.");
  if (match[1].toLowerCase() !== host_of(ctx.job.connection)) throw new AdapterError(PERMANENT, "The linked inspection is in another AppFolio account.");

  return { url: `https://${match[1].toLowerCase()}/inspections/${match[2]}`, id: match[2] };
}

/** Open the inspection, and check it is this one and in this scope. */
async function open_inspection(ctx) {
  const { url, id } = inspection_url(ctx);
  const state = await go(ctx, url, "inspection");
  const tag = header(ctx).public_id;

  if (!String(state.title || "").includes(tag)) throw new AdapterError(PERMANENT, `AppFolio inspection ${id} is "${state.title}", which does not carry ${tag}.`);

  check_scope(ctx, state.title);

  return { url, id, status: state.status || "" };
}

const locate = {
  name: "locate",
  async run(ctx) {
    return { data: await open_inspection(ctx) };
  },
};

const done_status = (status) => /^done$/i.test(String(status || "").trim());

async function poll(ctx, look, ms = LOOK_MS) {
  const until = ctx.now() + ms;

  for (;;) {
    try {
      const seen = await look();

      if (seen) return seen;
    } catch (error) {
      if (error?.error_class !== TRANSIENT && error?.error_class !== "adapter_broken") throw error;
    }

    if (ctx.now() >= until) return null;

    await ctx.sleep(LOOK_POLL_MS);
  }
}

async function wait_for_person(ctx, step, look) {
  const deadline = ctx.now() + PERSON_WAIT_MS;

  while (ctx.now() < deadline) {
    let seen = null;

    try {
      seen = await look();
    } catch {
      seen = null;
    }

    if (seen) return { data: seen };

    await ctx.sleep(PERSON_POLL_MS);
    await ctx.touch(step);
  }

  throw new AdapterError(UNKNOWN_OUTCOME, "Nobody finished it in time.");
}

async function sheet(ctx) {
  const seen = await ctx.ask("sheet");

  if (!seen || !Array.isArray(seen.areas)) throw new AdapterError(TRANSIENT, "The inspection's areas could not be read.");

  return seen;
}

// -- create ---------------------------------------------------------------------

/**
 * Look for ASH's number on the list, narrowed to the property. Found: the
 * row's inspection is opened — AppFolio opens it in a new tab — to read its
 * id, and the tab is closed. Only a narrowed list is evidence of absence.
 *
 * @return {Promise<{found: boolean, settled: boolean, id?: string}>}
 */
async function search(ctx) {
  const inspection = header(ctx);
  const result = await ctx.ask("find_in_list", { tag: inspection.public_id, street: inspection.street });

  if (!result?.found) return { found: false, settled: Boolean(result?.settled) };

  const before = new Set((await ctx.tab_children()).map((tab) => tab.id));

  await ctx.ask("open_row", { tag: inspection.public_id });

  const opened = await poll(ctx, async () => (await ctx.tab_children()).find((tab) => !before.has(tab.id)) || null, NEW_TAB_MS);

  if (!opened) throw new AdapterError(TRANSIENT, `${inspection.public_id} is on the list, but its inspection would not open.`);

  const url = await poll(ctx, async () => {
    const seen = await ctx.url_of(opened.id);

    return INSPECTION_URL.test(String(seen || "")) ? seen : null;
  }, NEW_TAB_MS);

  await ctx.close_tab(opened.id);

  if (!url) throw new AdapterError(TRANSIENT, `${inspection.public_id} is on the list, but its address could not be read.`);

  return { found: true, settled: true, id: INSPECTION_URL.exec(url)[2] };
}

const open_list = {
  name: "locate",
  async run(ctx) {
    check_scope(ctx);
    await go(ctx, `${origin(ctx)}${LIST_PATH}`, "list");

    return undefined;
  },
};

const CREATE = () => [
  open_list,
  {
    name: "find_existing",
    async run(ctx) {
      const found = await search(ctx);

      if (found.found) {
        ctx.data.id = found.id;

        return { already_done: true, identity: identity_of(ctx), evidence: `${header(ctx).public_id} is already in AppFolio, as inspection ${found.id}.` };
      }

      /* Never create on a list that could not be narrowed: the search is what
         stops a second inspection, so a search that proves nothing stops this. */
      if (!found.settled) throw new AdapterError(TRANSIENT, `Could not narrow AppFolio's inspection list to ${header(ctx).street}, so it was not searched.`);

      return undefined;
    },
  },
  {
    name: "prepare",
    async run(ctx) {
      const inspection = header(ctx);

      /* A fresh form every time: one half-filled by a worker that died is never added to. */
      await go(ctx, `${origin(ctx)}${NEW_PATH}`, "new");

      const filled = await ctx.ask("fill_new", {
        name: inspection.name,
        date: inspection.inspected_on || "",
        street: inspection.street,
        unit: inspection.unit || null,
      });

      if (filled?.name !== inspection.name) throw new AdapterError(TRANSIENT, `The form took the name "${filled?.name}".`);
      if (inspection.inspected_on && filled?.date !== inspection.inspected_on) throw new AdapterError(TRANSIENT, `The form took the date ${filled?.date}.`);
      if (!filled?.address) throw new AdapterError(PERMANENT, `AppFolio found no property at ${inspection.street}.`);

      return { data: { address: filled.address } };
    },
  },
  {
    name: "start",
    commit: true,
    async act(ctx) {
      await ctx.ask("start", {}, { once: true });

      return undefined;
    },
    async await_person(ctx) {
      await ctx.reveal(`Check the new inspection ${header(ctx).name} and press Start Inspection.`);

      return wait_for_person(ctx, "start", async () => {
        const match = INSPECTION_URL.exec(String((await ctx.tab_url()) || ""));

        return match ? { id: match[2], evidence: "Started by hand." } : null;
      });
    },
  },
  {
    name: "capture",
    async run(ctx) {
      const id =
        ctx.data.id ||
        (await poll(ctx, async () => INSPECTION_URL.exec(String((await ctx.tab_url()) || ""))?.[2] || null, 20000));

      if (!id) throw new AdapterError(UNKNOWN_OUTCOME, "Start Inspection was pressed but AppFolio did not open the new inspection.");

      ctx.data.id = id;

      const state = await poll(ctx, () => page_state(ctx));

      if (state && !String(state.title || "").includes(header(ctx).public_id))
        throw new AdapterError(UNKNOWN_OUTCOME, `AppFolio opened "${state.title}", which does not carry ${header(ctx).public_id}.`);

      return { data: { id, identity: identity_of(ctx), evidence: ctx.data.evidence || `Created in AppFolio as inspection ${id}.` } };
    },
  },
];

// -- fill_areas -----------------------------------------------------------------

/** An array of named things, keyed `name#n` by occurrence, so two "Bedroom"s stay two. */
function by_occurrence(things) {
  const seen = {};

  return things.map((thing) => {
    const nth = (seen[thing.name] = (seen[thing.name] ?? -1) + 1);

    return { key: `${thing.name}#${nth}`, nth, thing };
  });
}

const blank = (item) => item.result === null && squash(item.note) === "" && Number(item.photos || 0) === 0;

/**
 * What still has to change for AppFolio's sheet to be ASH's areas, in the
 * order to do it: missing areas, then blank extra areas, then missing items,
 * blank extra items, and last every item whose answer or note differs. An
 * area or item that has something in it and is not ASH's is left alone — a
 * person put it there.
 *
 * Pure, and exported for the tests: the adapter's loop and its verification
 * both ask it, so "done" and "found" are the same question.
 *
 * @return {Array<{command: string, args: object}>}
 */
export function reconcile(page, wanted) {
  const actions = [];
  const have = by_occurrence(page.areas || []);
  const want = by_occurrence(wanted || []);
  const have_keys = new Map(have.map((a) => [a.key, a]));
  const want_keys = new Set(want.map((a) => a.key));

  for (const area of want) if (!have_keys.has(area.key)) actions.push({ command: "add_area", args: { name: area.thing.name } });

  for (const area of have)
    if (!want_keys.has(area.key) && area.thing.items.every(blank)) actions.push({ command: "delete_area", args: { area: area.thing.name, area_nth: area.nth } });

  const values = [];

  for (const area of want) {
    const there = have_keys.get(area.key);

    if (!there) continue;

    const place = { area: area.thing.name, area_nth: area.nth };
    const have_items = by_occurrence(there.thing.items);
    const want_items = by_occurrence(area.thing.items);
    const have_item_keys = new Map(have_items.map((i) => [i.key, i.thing]));
    const want_item_keys = new Set(want_items.map((i) => i.key));

    for (const item of want_items) if (!have_item_keys.has(item.key)) actions.push({ command: "add_item", args: { ...place, name: item.thing.name } });

    for (const item of have_items)
      if (!want_item_keys.has(item.key) && blank(item.thing)) actions.push({ command: "delete_item", args: { ...place, item: item.thing.name, item_nth: item.nth } });

    for (const item of want_items) {
      const now = have_item_keys.get(item.key);

      if (!now) continue;
      if (now.result === item.thing.result && squash(now.note) === squash(item.thing.note)) continue;

      values.push({ command: "set_item", args: { ...place, item: item.thing.name, item_nth: item.nth, result: item.thing.result, note: item.thing.note ?? "" } });
    }
  }

  return [...actions, ...values];
}

function wanted_areas(ctx) {
  const areas = ctx.job.payload?.areas;

  if (!Array.isArray(areas) || areas.length === 0) throw new AdapterError(PERMANENT, "The claim carried no areas.");

  return areas;
}

const FILL_AREAS = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      const page = await sheet(ctx);

      if (reconcile(page, wanted_areas(ctx)).length === 0)
        return { already_done: true, identity: identity_of(ctx), evidence: "AppFolio's areas and items already say what ASH's do." };

      if (done_status(page.status)) throw new AdapterError(PERMANENT, "The inspection is already Done in AppFolio, so its items can no longer be filled.");

      return undefined;
    },
  },
  {
    name: "save_items",
    commit: true,
    /* One change at a time, each sent once, the sheet read again after each. */
    async act(ctx) {
      const wanted = wanted_areas(ctx);
      let made = 0;

      for (;;) {
        const next = reconcile(await sheet(ctx), wanted)[0];

        if (!next) break;
        if (++made > MAX_ACTIONS) throw new AdapterError(UNKNOWN_OUTCOME, `Made ${MAX_ACTIONS} changes and AppFolio still differs.`);

        await ctx.ask(next.command, next.args, { once: true, timeout_ms: 60000 });
        await ctx.touch("save_items");
      }

      return { data: { made } };
    },
    async await_person(ctx) {
      await ctx.reveal(`Fill in ${header(ctx).public_id}'s areas and items in AppFolio as ASH has them.`);

      return wait_for_person(ctx, "save_items", async () => (reconcile(await sheet(ctx), wanted_areas(ctx)).length === 0 ? { evidence: "Filled in by hand." } : null));
    },
  },
  {
    name: "capture",
    async run(ctx) {
      await open_inspection(ctx);

      const left = reconcile(await sheet(ctx), wanted_areas(ctx));

      if (left.length > 0) throw new AdapterError(UNKNOWN_OUTCOME, `After saving, ${left.length} things in AppFolio still differ from ASH.`);

      return { data: { identity: identity_of(ctx), evidence: ctx.data.evidence || `Areas and items filled in (${ctx.data.made ?? 0} changes).` } };
    },
  },
];

// -- post_photos ----------------------------------------------------------------

function part_of(ctx) {
  const payload = ctx.job.payload || {};

  if (!payload.item?.name || !payload.item?.area) throw new AdapterError(PERMANENT, "The claim named no item for the photographs.");
  if (!Array.isArray(payload.photos) || payload.photos.length === 0) throw new AdapterError(PERMANENT, "The claim carried no photographs.");

  return {
    where: { area: payload.item.area, area_nth: payload.item.area_nth ?? 0, item: payload.item.name, item_nth: payload.item.item_nth ?? 0 },
    photos: payload.photos,
    before: Number(payload.photos_before ?? 0),
    after: Number(payload.photos_after ?? payload.photos.length),
  };
}

/** How many photographs the item shows now, or null if it is not there. */
async function photo_count(ctx) {
  const { where } = part_of(ctx);
  const page = await sheet(ctx);
  const area = page.areas.filter((a) => a.name === where.area)[where.area_nth];
  const item = area?.items.filter((i) => i.name === where.item)[where.item_nth];

  return item ? Number(item.photos || 0) : null;
}

/** Done, still to do, or a count nobody can account for — which is a person's. */
function judge_count(ctx, count) {
  const { where, before, after } = part_of(ctx);

  if (count === null) throw new AdapterError(PERMANENT, `AppFolio has no item ${where.area}: ${where.item}.`);
  if (count === after) return "done";
  if (count === before) return "to_do";

  throw new AdapterError(PERMANENT, `${where.area}: ${where.item} has ${count} photographs in AppFolio, where ${before} or ${after} were expected.`);
}

const POST_PHOTOS = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      if (judge_count(ctx, await photo_count(ctx)) === "done")
        return { already_done: true, identity: identity_of(ctx), evidence: "AppFolio already shows these photographs on the item." };

      if (done_status(ctx.data.status)) throw new AdapterError(PERMANENT, "The inspection is already Done in AppFolio, so no photograph can be added.");

      return undefined;
    },
  },
  {
    name: "prepare",
    async run(ctx) {
      const { where, photos } = part_of(ctx);

      /* A fresh page: an item form half-filled by a worker that died is thrown away. */
      await open_inspection(ctx);

      for (const photo of photos) {
        const file = await ctx.photo(photo.id);

        await ctx.ask("stage_photo", { name: file.name || photo.name || `photo-${photo.id}.jpg`, mime_type: file.mime_type, b64: file.b64 });
        await ctx.touch("prepare");
      }

      const { attached = 0 } = (await ctx.ask("attach_photos", where)) || {};

      if (attached !== photos.length) throw new AdapterError(TRANSIENT, `The item took ${attached} of ${photos.length} photographs, so it was not saved.`);

      return { data: { attached } };
    },
  },
  {
    name: "save_photos",
    commit: true,
    async act(ctx) {
      await ctx.ask("save_item", part_of(ctx).where, { once: true, timeout_ms: 60000 });

      return undefined;
    },
    async await_person(ctx) {
      const { where } = part_of(ctx);

      await ctx.reveal(`Check the photographs on ${where.area}: ${where.item} and press Save.`);

      return wait_for_person(ctx, "save_photos", async () => (judge_count(ctx, await photo_count(ctx)) === "done" ? { evidence: "Saved by hand." } : null));
    },
  },
  {
    name: "capture",
    async run(ctx) {
      await ctx.sleep(2000);
      await open_inspection(ctx);

      const done = await poll(ctx, async () => (judge_count(ctx, await photo_count(ctx)) === "done" ? true : null), 20000);

      if (!done) throw new AdapterError(UNKNOWN_OUTCOME, "Save was pressed but AppFolio does not show the photographs on the item.");

      return { data: { identity: identity_of(ctx), evidence: ctx.data.evidence || `Attached ${ctx.data.attached} photographs.` } };
    },
  },
];

// -- mark_done ------------------------------------------------------------------

const MARK_DONE = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      return done_status(ctx.data.status) ? { already_done: true, identity: identity_of(ctx), evidence: "Already Done in AppFolio." } : undefined;
    },
  },
  {
    name: "done",
    commit: true,
    async act(ctx) {
      await ctx.ask("mark_done", {}, { once: true });

      return undefined;
    },
    async await_person(ctx) {
      await ctx.reveal(`Press Mark Inspection Done on ${header(ctx).name}.`);

      return wait_for_person(ctx, "done", async () => (done_status((await ctx.ask("state"))?.status) ? { evidence: "Marked done by hand." } : null));
    },
  },
  {
    name: "capture",
    async run(ctx) {
      await ctx.sleep(2000);

      const state = await poll(ctx, async () => {
        const seen = await open_inspection(ctx);

        return done_status(seen.status) ? seen : null;
      });

      if (!state) throw new AdapterError(UNKNOWN_OUTCOME, "Mark Inspection Done was pressed but AppFolio does not show it Done.");

      return { data: { identity: identity_of(ctx), evidence: ctx.data.evidence || "Marked done in AppFolio." } };
    },
  },
];

const PLANS = { create: CREATE, fill_areas: FILL_AREAS, post_photos: POST_PHOTOS, mark_done: MARK_DONE };

// -- Verification: look, never press --------------------------------------------

const VERIFY = {
  create: () => [
    open_list,
    {
      name: "look",
      async run(ctx) {
        const found = await search(ctx);

        if (found.found) {
          ctx.data.id = found.id;

          return { verdict: "found", identity: identity_of(ctx), evidence: `${header(ctx).public_id} is in AppFolio as inspection ${found.id}.` };
        }

        if (!found.settled) throw new AdapterError(TRANSIENT, "Could not narrow AppFolio's inspection list to look.");

        return { verdict: "absent", evidence: `No inspection at ${header(ctx).street} carries ${header(ctx).public_id}.` };
      },
    },
  ],

  fill_areas: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        const left = reconcile(await sheet(ctx), wanted_areas(ctx));

        return left.length === 0
          ? { verdict: "found", identity: identity_of(ctx), evidence: "AppFolio's areas and items say what ASH's do." }
          : { verdict: "absent", evidence: `${left.length} things in AppFolio still differ from ASH.` };
      },
    },
  ],

  post_photos: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        return judge_count(ctx, await photo_count(ctx)) === "done"
          ? { verdict: "found", identity: identity_of(ctx), evidence: "The photographs are on the item." }
          : { verdict: "absent", evidence: "The item shows the photographs it had before." };
      },
    },
  ],

  mark_done: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        return done_status(ctx.data.status)
          ? { verdict: "found", identity: identity_of(ctx), evidence: "Done in AppFolio." }
          : { verdict: "absent", evidence: `AppFolio shows it ${ctx.data.status || "not done"}.` };
      },
    },
  ],
};

// -- The session ------------------------------------------------------------------

/** Open the inspection list in a background tab of the ASH group and see where it lands. Closed either way. */
async function probe(env, host) {
  const base = `https://${host}`;
  const tab = await env.tabs.open(`${base}${LIST_PATH}`);

  if (tab === null || tab === undefined) return { state: "unknown" };

  try {
    const until = env.now() + PROBE_MS;

    while (env.now() <= until) {
      const url = await env.tabs.url(tab);

      if (url && (!url.startsWith(base) || /sign_in|login|passport/i.test(url))) return { state: /sign_in|login|passport|appf\.io/i.test(url) ? "expired" : "unknown" };

      try {
        const state = await env.page.send(tab, "state", {}, { timeout_ms: 3000 });

        if (state?.signed_in === false) return { state: "expired" };
        if (state?.signed_in === true) return { state: "live" };
      } catch {
        /* Not answering yet. */
      }

      await env.sleep(1000);
    }

    return { state: "unknown" };
  } finally {
    await env.tabs.close(tab).catch(() => null);
  }
}

export default {
  ...manifest,

  /**
   * Signed in to the property manager's AppFolio? A probe tab looks, at most
   * every four minutes, and only while this browser is processing and the web
   * app's last answer was one a probe could change — which a person who is
   * not an operator of the connection never gets.
   */
  async session(env, connection = {}, { processing = true } = {}) {
    const host = host_of(connection);

    if (!host) return { state: "unknown" };

    const seen = await env.local.get(SESSION_KEY);

    if (seen?.host === host && env.now() - seen.at < SESSION_FRESH_MS) return { state: seen.state };

    if (!processing || connection.enabled === false || !PROBE_HELPS.has(connection.reason ?? null)) return { state: "unknown" };

    const probed = await probe(env, host);

    await env.local.set(SESSION_KEY, { host, state: probed.state, at: env.now() });

    return { state: probed.state };
  },

  async session_lost(env) {
    const seen = await env.local.get(SESSION_KEY);

    await env.local.set(SESSION_KEY, { host: seen?.host ?? null, state: "expired", at: env.now() });
  },

  plan(job) {
    const plan = PLANS[job.operation];

    if (!plan) throw new Error(`The property-manager adapter cannot ${job.operation}.`);

    return plan();
  },

  verify_plan(job) {
    const plan = VERIFY[job.operation];

    if (!plan) throw new Error(`The property-manager adapter cannot verify ${job.operation}.`);

    return plan();
  },

  parse_url(url) {
    const match = INSPECTION_URL.exec(String(url || ""));

    return match ? { host: match[1].toLowerCase(), id: match[2] } : null;
  },
};
