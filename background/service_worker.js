/**
 * The extension's one long-lived brain.
 *
 * Everything that talks to the network, holds a credential or owns a queue is
 * here rather than in a content script or the popup, for three reasons that all
 * turned out to be the same reason.
 *
 * A content script's fetch is subject to the page's CORS rules under Manifest
 * V3, so it cannot call the web app. The popup is destroyed the instant focus
 * returns to the page, so it cannot own a batch that takes thirty seconds. And
 * a content script dies with its tab, so it cannot own a retry. All three are
 * "the thing you were tempted to put it in does not live long enough."
 *
 * So the pages and the popup send messages, and this answers them. Every
 * handler returns a plain object; nothing throws across the message boundary,
 * because a rejected sendMessage on the far side is indistinguishable from a
 * closed popup and hides the reason.
 */

import * as auth from "./auth.js";
import * as sync from "./sync.js";
import {
  migrate_v1_queue,
  settings,
  save_settings,
  clear_auth,
  bt_queue,
  update_bt_queue,
} from "./store.js";
import { notify, set_badge } from "./notify.js";
import { normalize_base, origin_pattern } from "./api.js";
import { fill_job } from "./buildertrend.js";

/**
 * The message out of a payload that may be a bare string.
 *
 * Every handler here takes an object except the three Buildertrend reports,
 * which send a string — v1's shape, kept rather than changed, because changing
 * it would mean touching the Buildertrend script for no gain.
 */
function text_of(payload) {
  if (typeof payload === "string") return payload;

  return typeof payload?.message === "string" ? payload.message : "";
}

/** Keeps the toolbar badge honest without anybody having to remember to. */
async function refresh_badge() {
  set_badge(await sync.summary());
}

const handlers = {
  /* ---- state the UI renders from ---------------------------------------- */

  async STATE() {
    const [config, session, counts, jobs, queue] = await Promise.all([
      settings(),
      auth.state(),
      sync.summary(),
      sync.sync_jobs_snapshot(),
      bt_queue(),
    ]);

    return {
      settings: config,
      session,
      counts,
      jobs,
      bt_queue: queue,
      suggested_device_name: auth.suggested_device_name(),
    };
  },

  /* ---- settings and sign-in --------------------------------------------- */

  /**
   * Save settings, and reset anything that belonged to a previous web app.
   *
   * Changing the address is not an ordinary setting change. Three things in
   * storage are only meaningful relative to one particular web app, and all
   * three are actively wrong if carried across to another:
   *
   * - **the access token**, which the new address will refuse — leaving it in
   *   place makes a deliberate change look like a surprise sign-out;
   * - **the sync ledger's statuses**, which describe the other app's records;
   * - **the work-order ids**, which is the dangerous one. The popup builds a
   *   record link as `<current address>/work-orders/<stored id>`, so a stale id
   *   against a new address does not give a broken link. It gives a working
   *   link to a different, real work order.
   *
   * So a changed address clears the token and the ledger.
   *
   * The comparison is the whole normalized address, not the origin. Origin
   * would be the natural choice and it is wrong here: under XAMPP every project
   * shares http://localhost and is told apart only by its path, so
   * /projects/alabamasignaturehomes and /projects/something-else are different
   * applications with identical origins. Normalizing first is what keeps a
   * dropped trailing slash from reading as a move.
   *
   * It errs toward resetting, deliberately. A needless sign-out is a minute's
   * annoyance; a stale work-order id against a live address is a link to the
   * wrong record, and nobody would know to check.
   *
   * The Buildertrend queue is deliberately kept. It holds work orders scraped
   * from Appfolio on their way to Buildertrend and has nothing to do with which
   * web app is configured.
   */
  async SAVE_SETTINGS({ patch }) {
    const clean = { ...patch };
    const before = await settings();

    if (typeof clean.app_url === "string") clean.app_url = normalize_base(clean.app_url);

    const had = normalize_base(before.app_url);
    const moved =
      typeof clean.app_url === "string" && had !== "" && clean.app_url !== had;

    await save_settings(clean);

    if (!moved) return { ok: true, settings: await settings() };

    /* Cleared locally rather than revoked. The token belongs to the address we
       are leaving, and asking the new one to revoke it would be asking the
       wrong server — it can be ended from the old app's own account page. */
    await clear_auth();

    const cleared = await sync.clear_all();
    await refresh_badge();

    return {
      ok: true,
      settings: await settings(),
      moved: true,
      cleared: cleared.removed,
      previous_url: before.app_url,
    };
  },

  /**
   * Whether we may call the address that is configured.
   *
   * A user-typed endpoint cannot be a static host permission, so it is an
   * optional one granted at runtime. Only the options page can ask, because
   * chrome.permissions.request needs a user gesture — which is why this reports
   * rather than requests.
   */
  async CHECK_ORIGIN_PERMISSION() {
    const config = await settings();
    const pattern = origin_pattern(config.app_url);

    if (pattern === "") return { granted: false, pattern: "" };

    const granted = await chrome.permissions.contains({ origins: [pattern] });

    return { granted, pattern };
  },

  async SIGN_IN({ email, password, device_name }) {
    const result = await auth.sign_in({ email, password, device_name });

    /* A sign-in is the one event that can unstick a queue full of `blocked`,
       so it retries them itself rather than leaving the manager to find the
       button. */
    if (result.ok) {
      const jobs = await sync.sync_jobs_snapshot();
      const blocked = Object.values(jobs)
        .filter((job) => job.state === "blocked")
        .map((job) => job.number);

      if (blocked.length > 0) await sync.retry(blocked);
    }

    await refresh_badge();

    return result;
  },

  async SIGN_OUT() {
    const result = await auth.sign_out();
    await refresh_badge();

    return result;
  },

  async HEARTBEAT() {
    const result = await auth.heartbeat();
    await refresh_badge();

    return result;
  },

  /* ---- the web app leg -------------------------------------------------- */

  async SYNC({ work_orders }) {
    const result = await sync.enqueue(work_orders);
    await refresh_badge();

    return result;
  },

  async RETRY({ numbers }) {
    await sync.retry(numbers);
    await refresh_badge();

    return { ok: true };
  },

  async CLEAR_FINISHED() {
    const result = await sync.clear_finished();
    await refresh_badge();

    return result;
  },

  /**
   * Live status for a page of Appfolio rows.
   *
   * Reports its failures instead of returning an empty map, because the badges
   * must be able to say "unknown" rather than show a remembered value as
   * current — which is the one thing that would make them untrustworthy.
   */
  async STATUSES({ numbers }) {
    return sync.statuses(numbers);
  },

  /* ---- the Buildertrend leg --------------------------------------------- */

  async QUEUE_FOR_BT({ work_orders }) {
    const list = Array.isArray(work_orders) ? work_orders : [];

    await update_bt_queue((queue) => {
      const next = { ...queue };

      for (const work_order of list) {
        const number = String(work_order?.number || "").trim();
        if (number === "") continue;

        next[number] = work_order;
      }

      return next;
    });

    return { queued: list.length };
  },

  async UNQUEUE_FROM_BT({ numbers }) {
    const wanted = new Set((Array.isArray(numbers) ? numbers : [numbers]).map(String));

    await update_bt_queue((queue) => {
      const next = { ...queue };

      for (const number of wanted) delete next[number];

      return next;
    });

    return { ok: true };
  },

  async CLEAR_BT_QUEUE() {
    let removed = 0;

    await update_bt_queue((queue) => {
      removed = Object.keys(queue).length;

      return {};
    });

    return { removed };
  },

  /**
   * The Buildertrend page reporting on itself.
   *
   * These three exist because that script runs in a tab of its own for half a
   * minute, and in v1 they went to a flash list in the popup — which is shut by
   * then. So they were correct messages delivered to nothing, and the only way
   * a manager learned a fill had failed was that the row stayed in the queue.
   *
   * Routed to a notification instead. It is the same reasoning as the sync
   * engine's: the report has to outlive the window that asked for the work.
   */
  async CRITICAL_ERROR(payload) {
    notify("Buildertrend", text_of(payload) || "Something went wrong.");

    return { ok: true };
  },

  async FLASH_ERROR(payload) {
    notify("Buildertrend", text_of(payload) || "Something went wrong.");

    return { ok: true };
  },

  async FLASH_ALERT(payload) {
    notify("Buildertrend", text_of(payload) || "Done.");

    return { ok: true };
  },

  async FILL_JOB({ number }) {
    const config = await settings();

    if (config.buildertrend_enabled === false)
      return { ok: false, error: "Buildertrend is switched off in Settings." };

    const queue = await bt_queue();
    const work_order = queue[String(number)];

    if (!work_order) return { ok: false, error: "That work order is not in the queue." };

    return fill_job(work_order, config);
  },
};

/**
 * The message boundary.
 *
 * `true` is returned synchronously so Chrome keeps the port open for the async
 * answer — the single most common way an MV3 message handler silently returns
 * undefined is forgetting it.
 */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];

  if (!handler) return false;

  /* `?? {}` rather than `|| {}`: the Buildertrend script's reports carry a bare
     string as their payload, and `||` would throw an empty object away along
     with it. */
  Promise.resolve(handler(message.payload ?? {}, sender))
    .then((result) => respond(result ?? { ok: true }))
    .catch((error) =>
      respond({ ok: false, error: error?.message || "Something went wrong." }),
    );

  return true;
});

/* Retries live on an alarm rather than a timer, because an alarm is the only
   thing that survives the service worker being evicted — which happens after
   thirty seconds of idleness, i.e. during exactly the wait a backoff is. */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== sync.ALARM) return;

  sync.trigger();
});

/**
 * On install and on every browser start.
 *
 * The badge is redrawn because it does not survive a restart while the queue
 * does, and a queue with three stuck rows and no badge is a queue nobody looks
 * at. trigger() picks up anything left mid-flight from the last session.
 */
async function wake() {
  await migrate_v1_queue();
  await refresh_badge();

  sync.trigger();
}

chrome.runtime.onInstalled.addListener(() => {
  wake();
});

chrome.runtime.onStartup.addListener(() => {
  wake();
});

/* The worker may also be started by a message, in which case neither event
   above fires. Redrawing here costs one storage read. */
refresh_badge();
