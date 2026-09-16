/**
 * The tabs this extension opens, and nobody else's.
 *
 * Three things open a tab and drive it — the invoice drainer, the Buildertrend
 * job filler and the estimate writer — and each used to remember its tab in a
 * module variable. That is lost whenever the service worker is evicted, so two
 * of them fell back to adopting *any* tab whose address looked right, which
 * includes a tab the manager opened herself. Harmless while the only thing done
 * to a tab was to navigate it; not harmless once tabs are locked and closed.
 *
 * So every owned tab goes through here, and this module is the only thing that
 * says which tabs those are.
 *
 * ## The lock is a lease, and it fails open
 *
 * content/tab_guard.js blocks a person's clicks and keystrokes in a locked tab,
 * and asks this module every few seconds whether it still should. The answer
 * comes from **module state only**. If the worker that took the lock is gone —
 * evicted, crashed, the extension reloaded — the new worker has no locks, the
 * page is told "unlocked", and the overlay lifts. A lock that could outlive the
 * run that took it would trap somebody in a tab with nothing behind it.
 *
 * ## What cannot be locked
 *
 * A page can swallow input; it cannot stop the tab being closed, reloaded or
 * navigated from the address bar. Closing is detected instead, and a run that
 * finds its tab closed by a person stops rather than quietly opening another.
 *
 * ## Orphans
 *
 * The registry is also written to `chrome.storage.session`, stamped with an id
 * for this worker's life. A fresh worker closes whatever an earlier one left
 * registered, because no run survives its worker: a row from another boot is a
 * tab nothing will ever finish or close.
 */

import { capture, record_tab_error } from "./tab_errors.js";

const REGISTRY_KEY = "nss_owned_tabs";

/**
 * Whether a run closes its tab when something goes wrong.
 *
 * Yes, for now, including a run somebody started by hand — the report in
 * Settings replaces the open tab as the evidence. False would hand the tab
 * back instead: unlocked, left open, disowned.
 */
const CLOSE_ON_ERROR = true;

/** This worker's life. A registry row from any other is an orphan. */
const BOOT = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** tab id => owner, for tabs opened in this worker's life. */
const owned = new Map();

/** tab id => the label the overlay shows. Presence is the lock. */
const locks = new Map();

/** Owned tabs a person closed, so a run can tell that from its own closing. */
const closed_by_people = new Set();

/** Serializes registry writes, the way store.js serializes its own. */
let lane = Promise.resolve();

function write_registry(mutator) {
  const result = lane.then(async () => {
    let current = {};

    try {
      ({ [REGISTRY_KEY]: current = {} } = await chrome.storage.session.get(REGISTRY_KEY));
    } catch {
      current = {};
    }

    const next = mutator({ ...current });

    try {
      await chrome.storage.session.set({ [REGISTRY_KEY]: next });
    } catch {
      /* The in-memory registry is the one runs use. Losing the durable copy
         only costs the orphan sweep, which is not worth failing a run over. */
    }
  });

  lane = result.catch(() => {});

  return result;
}

/**
 * Open a tab this extension owns.
 *
 * Locked from the start when a label is given, so there is no moment between
 * the page appearing and the run beginning in which a click lands.
 */
export async function open_owned_tab(owner, url, { active = false, label = "" } = {}) {
  const tab = await chrome.tabs.create({ url, active }).catch(() => null);

  if (!tab?.id) return null;

  owned.set(tab.id, owner);
  if (label !== "") locks.set(tab.id, label);

  await write_registry((rows) => ({ ...rows, [tab.id]: { owner, boot: BOOT, at: Date.now() } }));

  return tab;
}

/** This owner's tab, if it is still open. Never a tab this module did not open. */
export async function owned_tab(owner) {
  for (const [tab_id, who] of owned) {
    if (who !== owner) continue;

    const tab = await chrome.tabs.get(tab_id).catch(() => null);
    if (tab) return tab_id;

    await forget(tab_id);
  }

  return null;
}

export function is_owned(tab_id) {
  return owned.has(tab_id);
}

export function lock(tab_id, label = "") {
  if (tab_id === null || tab_id === undefined || !owned.has(tab_id)) return;

  locks.set(tab_id, label);
  tell(tab_id, true, label);
}

export function unlock(tab_id) {
  if (tab_id === null || tab_id === undefined) return;

  locks.delete(tab_id);
  tell(tab_id, false, "");
}

/** Did a person close this tab, rather than a run? */
export function closed_by_person(tab_id) {
  return closed_by_people.has(tab_id);
}

/**
 * The tab is the person's now.
 *
 * For the two moments a person has to use one: a sign-in page, and a filled
 * invoice waiting for Submit. Unlocked and forgotten — not closed, since the
 * message the popup shows points at it, and not reused by the next run, since
 * she may well be working in it.
 */
export async function hand_over(tab_id) {
  if (tab_id === null || tab_id === undefined) return;

  unlock(tab_id);
  await forget(tab_id);
}

/**
 * Close an owned tab, recording why first if something went wrong.
 *
 * @param {object|null} failure
 *   `{ owner, label, number, step, state, error, detail, run }` — anything
 *   except null records a report before the tab goes.
 */
export async function close_owned_tab(tab_id, failure = null) {
  if (tab_id === null || tab_id === undefined) return;

  const label = locks.get(tab_id) || "";
  const was_owned = owned.has(tab_id) || closed_by_people.has(tab_id);

  if (!was_owned) return;

  unlock(tab_id);

  if (failure !== null) {
    /* A beat for the overlay to come off, so a screenshot shows the page. */
    await new Promise((resolve) => setTimeout(resolve, 250));

    const seen = await capture(tab_id);

    await record_tab_error({
      owner: owned.get(tab_id) || failure.owner || "",
      label: failure.label || label,
      ...failure,
      ...seen,
      tab_closed_by_person: closed_by_people.has(tab_id),
    });

    if (!CLOSE_ON_ERROR) {
      await forget(tab_id);

      return;
    }
  }

  await forget(tab_id);
  closed_by_people.delete(tab_id);

  await chrome.tabs.remove(tab_id).catch(() => null);
}

async function forget(tab_id) {
  owned.delete(tab_id);
  locks.delete(tab_id);

  await write_registry((rows) => {
    delete rows[tab_id];

    return rows;
  });
}

function tell(tab_id, locked, label) {
  try {
    Promise.resolve(
      chrome.tabs.sendMessage(tab_id, { type: "TAB_GUARD_SET", payload: { locked, label } }),
    ).catch(() => {});
  } catch {
    /* No listener yet. The page asks for itself when its guard starts. */
  }
}

chrome.tabs.onRemoved.addListener((tab_id) => {
  if (!owned.has(tab_id)) return;

  closed_by_people.add(tab_id);
  forget(tab_id);
});

/* The page asking whether it is still locked. Answered synchronously, from
   module state alone — see "fails open" above. */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "TAB_GUARD_STATUS") return false;

  const tab_id = sender?.tab?.id;
  const locked = tab_id !== undefined && locks.has(tab_id);

  respond({ locked, label: locked ? locks.get(tab_id) : "" });

  return false;
});

/**
 * Close what an earlier worker left behind.
 *
 * Only rows from another boot: a run in this worker may have registered a tab
 * a moment ago, and this runs at load, concurrently with whatever woke it.
 */
async function sweep_orphans() {
  let rows = {};

  try {
    ({ [REGISTRY_KEY]: rows = {} } = await chrome.storage.session.get(REGISTRY_KEY));
  } catch {
    return;
  }

  const orphans = Object.entries(rows)
    .filter(([, row]) => row?.boot !== BOOT)
    .map(([tab_id]) => Number(tab_id));

  if (orphans.length === 0) return;

  await write_registry((current) => {
    for (const tab_id of orphans) delete current[tab_id];

    return current;
  });

  for (const tab_id of orphans) await chrome.tabs.remove(tab_id).catch(() => null);
}

sweep_orphans();
