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
  bt_pending_links: "bt_pending_links",
  bt_last_run: "bt_last_run",
  bt_last_estimate_run: "bt_last_estimate_run",
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

  // Required on every estimate line, and it feeds ASH's job costing, so it is
  // a tenant fact rather than something the filler should choose. Here rather
  // than in the code because the owner has already said somebody will want to
  // pick it per job one day; this is where that choice will read from.
  bt_cost_code: "8000 - General Handyman",

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
 * Jobs that exist in Buildertrend but are not linked on the web app yet:
 * work-order number => `{ url, title, reason, at }`.
 *
 * This is the one state the two-destination rule cannot express, and there are
 * two shapes of it:
 *
 * - **`url` set** — we know where the job is and the server would not take it
 *   (a lapsed token, a 500, no network). Settling it is one POST.
 * - **`url` null** — the job was saved but its id could not be read. Settling
 *   it means searching Buildertrend for `title` first, then posting.
 *
 * Both belong in one place because they are the same fact to whoever is
 * looking: *Buildertrend has this job and the web app does not know where.*
 *
 * A job in either state must **not** stay in `bt_queue`. Leaving it there is
 * how a re-run makes a second real job, and two jobs sharing a title make the
 * id unfindable for both — the picker refuses an ambiguous match, by design.
 * So the queue is emptied on creation and the shortfall is recorded here,
 * retried at the top of every run and on demand from the popup.
 */
export function bt_pending_links() {
  return read(KEYS.bt_pending_links, {});
}

export function update_bt_pending_links(mutator) {
  return update(KEYS.bt_pending_links, {}, mutator);
}

/**
 * What the last Buildertrend run did: `{ started_at, finished_at, summary,
 * jobs: [...] }`.
 *
 * One run, not a log. `notify.js` reuses a single notification id, so the only
 * report this leg had was a toast that the next toast overwrote — which is why
 * three separate failures were diagnosed by inference from the server's access
 * log instead of by reading what the extension already knew. This is the
 * durable counterpart, and the popup renders it as plain text so it survives a
 * screenshot or a paste into a chat.
 */
export function bt_last_run() {
  return read(KEYS.bt_last_run, null);
}

export function save_bt_last_run(value) {
  return update(KEYS.bt_last_run, null, () => value);
}

/**
 * What the last estimate run did.
 *
 * Its own record rather than sharing `bt_last_run`, because the two answer
 * different questions — one is "were the jobs created", the other "were they
 * estimated" — and a run of either would otherwise erase the other's account.
 *
 * It exists for the reason the job-creation record does: the only report was a
 * banner in the popup, and the popup's own heartbeat clears that banner the
 * moment it is reopened. So the first estimate rehearsal reported its result to
 * nobody, exactly as six job-creation runs had.
 */
export function bt_last_estimate_run() {
  return read(KEYS.bt_last_estimate_run, null);
}

export function save_bt_last_estimate_run(value) {
  return update(KEYS.bt_last_estimate_run, null, () => value);
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

/**
 * Move `bt_unrecorded` into `bt_pending_links`, once.
 *
 * The old key held `number => url`; the new one holds an object, because a
 * pending link now also covers "the job exists and we do not know its id".
 *
 * That key almost certainly never held anything — the POST it recorded
 * failures from was never once reached — so this is insurance rather than a
 * migration. It is written anyway because the thing it would lose is a link to
 * a real job, which is the failure this whole area exists to prevent, and
 * being sure costs eight lines.
 */
export async function migrate_bt_unrecorded() {
  const stored = await raw_get(["bt_unrecorded"]);
  const old = stored.bt_unrecorded;

  if (!old || typeof old !== "object") return 0;

  const moved = Object.entries(old).map(([number, url]) => [
    number,
    { url: typeof url === "string" ? url : null, title: "", reason: "Carried over from an earlier version.", at: Date.now() },
  ]);

  if (moved.length > 0)
    await update(KEYS.bt_pending_links, {}, (current) => ({
      ...Object.fromEntries(moved),
      ...current,
    }));

  await new Promise((resolve) => {
    chrome.storage.local.remove("bt_unrecorded", () => resolve());
  });

  return moved.length;
}

export { KEYS, DEFAULT_SETTINGS };
