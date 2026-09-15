/**
 * Everything the extension remembers, and the only code that writes it.
 *
 * There is one reason this is a module rather than a call to
 * chrome.storage.local wherever it is needed. Every writer in the previous
 * version did the same read-modify-write dance — get the map, turn it into a
 * Map, mutate it, put it back — and none of them held a lock. Two of them
 * running at once silently discarded one of the two changes, which is exactly
 * what a batch of twenty rows and a badge refresh landing together looks like.
 *
 * So writes go through update(), which serializes them into a single promise
 * chain. A mutator sees the value as it is at the moment it runs, not as it was
 * when its caller asked, and the value it returns is what gets stored.
 */

const KEYS = {
  auth: "auth",
  settings: "settings",
  sync: "sync_jobs",
  bt_queue: "bt_queue",
  bt_unrecorded: "bt_unrecorded",
};

const DEFAULT_SETTINGS = {
  app_url: "",
  buildertrend_enabled: true,

  // The tenant facts the old version baked into the source, including a
  // Buildertrend contact row id that lived inside a CSS selector. None of them
  // are this extension's business to know; they are just what this office
  // happens to fill in.
  client: "Camelot Properties",
  job_type: "Handyman Services",
  job_group: "Appfolio",
  bt_client_name: "Camelot Properties",
  bt_client_row_id: "39778241",
};

/** Serializes every write, so no two mutators can lose each other's work. */
let lane = Promise.resolve();

function raw_get(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function raw_set(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

async function read(key, fallback) {
  const result = await raw_get(key);
  const value = result[key];

  return value === undefined || value === null ? fallback : value;
}

/**
 * Read, mutate, write — with every other update waiting its turn.
 *
 * The mutator may be async. Returning undefined means "no change", which is how
 * a mutator declines to write without having to re-read the value it was given.
 *
 * The lane is kept open on failure: a mutator that throws rejects its own
 * caller's promise and nothing else, because a single broken write must not
 * wedge every write that comes after it.
 */
export function update(key, fallback, mutator) {
  const result = lane.then(async () => {
    const current = await read(key, fallback);
    const next = await mutator(current);

    if (next === undefined) return current;

    await raw_set({ [key]: next });

    return next;
  });

  lane = result.then(
    () => {},
    () => {},
  );

  return result;
}

export function settings() {
  return read(KEYS.settings, {}).then((stored) => ({
    ...DEFAULT_SETTINGS,
    ...stored,
  }));
}

export function save_settings(patch) {
  return update(KEYS.settings, {}, (current) => ({ ...current, ...patch }));
}

export function auth() {
  return read(KEYS.auth, null);
}

export function save_auth(value) {
  return update(KEYS.auth, null, () => value);
}

export function clear_auth() {
  return update(KEYS.auth, null, () => null);
}

/** The sync ledger: work-order number => job record. */
export function sync_jobs() {
  return read(KEYS.sync, {});
}

export function update_sync_jobs(mutator) {
  return update(KEYS.sync, {}, mutator);
}

/** The Buildertrend queue: work-order number => scraped work order. */
export function bt_queue() {
  return read(KEYS.bt_queue, {});
}

export function update_bt_queue(mutator) {
  return update(KEYS.bt_queue, {}, mutator);
}

/**
 * Jobs that exist in Buildertrend but whose URL the web app has not accepted:
 * work-order number => url.
 *
 * This is the one state the two-destination rule cannot express. A job created
 * in Buildertrend and recorded nowhere is *worse* than one never created: the
 * server still reads `buildertrend_url IS NULL`, so the next sync would create
 * a **second real job**, and two jobs sharing a title make the id unfindable
 * for both — the picker refuses an ambiguous match, by design.
 *
 * So a link that could not be recorded is neither dropped (losing it) nor left
 * in `bt_queue` (which would re-create it). It waits here, is retried at the
 * top of every run, and needs no browser to settle — it is one POST to our own
 * server, not a form to fill again.
 */
export function bt_unrecorded() {
  return read(KEYS.bt_unrecorded, {});
}

export function update_bt_unrecorded(mutator) {
  return update(KEYS.bt_unrecorded, {}, mutator);
}

/**
 * Move a v1 queue into its new home, once.
 *
 * v1 kept the Buildertrend queue under `work_orders`, which is now the name of
 * nothing — the web app's ledger is `sync_jobs` and the Buildertrend queue is
 * `bt_queue`. A manager mid-morning when the extension updates should not lose
 * the rows she had already picked out, so the old key is moved rather than
 * ignored, and removed so this cannot run twice.
 */
export async function migrate_v1_queue() {
  const stored = await raw_get(["work_orders", KEYS.bt_queue]);
  const old = stored.work_orders;

  if (!old || typeof old !== "object") return 0;

  const moved = Object.keys(old).length;

  await update(KEYS.bt_queue, {}, (current) => ({ ...old, ...current }));
  await new Promise((resolve) => {
    chrome.storage.local.remove("work_orders", () => resolve());
  });

  return moved;
}

export { KEYS, DEFAULT_SETTINGS };
