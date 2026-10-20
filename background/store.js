/**
 * The extension's settings, and the only code that writes them.
 *
 * Since 4.0.0 there is one setting — the web app's address — and everything
 * else this browser remembers belongs to the delivery worker, which keeps its
 * own keys through worker/chrome_env.js (`ash_worker_*`). This module is still
 * where a settings write goes, for the reason it was written: a
 * read-modify-write with no lock silently discards one of two changes that
 * land together.
 *
 * So writes go through update(), which serializes them into a single promise
 * chain. A mutator sees the value as it is at the moment it runs, not as it was
 * when its caller asked, and the value it returns is what gets stored.
 */

const KEYS = {
  settings: "settings",
};

const DEFAULT_SETTINGS = {
  app_url: "",
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

function raw_remove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
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

/**
 * What the legacy runtime (3.x and earlier) left in `storage.local`.
 *
 * Its session token, the sync ledger, the Buildertrend queue, pending links and
 * run reports, the outgoing queues' status, and the tab-error reports — the
 * last of which carried screenshots and were the largest thing this extension
 * ever stored. Plus the two keys the v1 and Buildertrend migrations read, in
 * case a browser skipped every version that would have moved them.
 */
const LEGACY_KEYS = [
  "auth",
  "sync_jobs",
  "bt_queue",
  "bt_pending_links",
  "bt_last_run",
  "bt_last_estimate_run",
  "delivery_status",
  "tab_errors",
  "tab_errors_seen_at",
  "work_orders",
  "bt_unrecorded",
];

/** The same runtime's `storage.session` keys, which a mid-session update leaves behind. */
const LEGACY_SESSION_KEYS = ["nss_awaiting_submit_url", "nss_sign_in_tabs", "nss_owned_tabs", "nss_outdated_notice"];

/** The settings only the legacy runtime read: Buildertrend's tenant facts and its switches. */
const LEGACY_SETTINGS = [
  "buildertrend_enabled",
  "bt_auto_estimates",
  "client",
  "job_type",
  "job_group",
  "bt_client_name",
  "bt_client_row_id",
  "bt_cost_code",
];

/**
 * Forget everything the legacy runtime stored, keeping the web app's address.
 *
 * Run on every install and update rather than once behind a flag: removing a
 * key that is not there costs nothing, and a flag is one more key to explain.
 * The address is kept because it is the one thing a person typed that still
 * means something — and keeping it is what spares them the setup panel.
 *
 * The legacy session token is dropped, not revoked: the endpoint that revoked
 * it no longer exists, so it is ended from the web app's /account page.
 */
export async function remove_legacy() {
  await raw_remove(LEGACY_KEYS);

  try {
    await chrome.storage.session.remove(LEGACY_SESSION_KEYS);
  } catch {
    /* Session storage is per browser session and empty after a restart anyway. */
  }

  await update(KEYS.settings, {}, (current) => {
    if (!LEGACY_SETTINGS.some((key) => key in current)) return undefined;

    const next = { ...current };

    for (const key of LEGACY_SETTINGS) delete next[key];

    return next;
  });
}

export { KEYS, DEFAULT_SETTINGS };
