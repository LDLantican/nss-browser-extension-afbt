/**
 * The extension's service worker: Settings' half of it.
 *
 * Since 4.0.0 the extension is the delivery worker and nothing else, and the
 * worker answers its own messages (worker/index.js): its state and switches
 * for the popup, and the three a content script may send — IMPORT and
 * IMPORT_STATUSES from the property manager's AppFolio pages, ASH_VENDOR_SEEN
 * from the vendor portal. What is left here is what Settings asks for before
 * there is a worker to ask: the web app's address and the permission to call
 * it, signing in and out, and the vendor-page check.
 *
 * Every handler returns a plain object; nothing throws across the message
 * boundary, because a rejected sendMessage on the far side is
 * indistinguishable from a closed popup and hides the reason.
 */

import { settings, save_settings, remove_legacy } from "./store.js";
import { normalize_base, origin_pattern } from "./api.js";
import { from_extension_page } from "./senders.js";
import { start_worker_schedule, worker_sign_in, worker_sign_out } from "../worker/index.js";

/**
 * The tabs the worker has opened for its jobs, as worker/chrome_env.js writes
 * them down. Read here only to leave them out of a page check.
 */
const WORKER_TABS_KEY = "ash_worker_tabs";

/** The legacy runtime's alarms, which an update leaves armed with nothing listening. */
const LEGACY_ALARMS = ["nss-delivery-drain", "nss-sync-retry"];

/**
 * The vendor-portal tab a page check should read.
 *
 * The active tab when it is one — that is the page the person is looking at.
 * Otherwise the vendor tab they used most recently, because the check is run
 * from Settings, which is a tab of its own and so is always the active one.
 * Tabs the worker opened are skipped: they belong to a job, and a check that
 * read one mid-job would describe a page nobody chose.
 */
async function probe_target() {
  let owned = [];

  try {
    ({ [WORKER_TABS_KEY]: owned = [] } = await chrome.storage.session.get(WORKER_TABS_KEY));
  } catch {
    /* Nothing known to skip; a person's own tab is still the likelier answer. */
  }

  const skip = new Set(Array.isArray(owned) ? owned : []);
  const is_vendor = (tab) => String(tab?.url || "").startsWith("https://vendor.appfolio.com");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (is_vendor(active) && !skip.has(active.id)) return active;

  const tabs = await chrome.tabs.query({ url: "https://vendor.appfolio.com/*" });

  return tabs
    .filter((tab) => !skip.has(tab.id))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

const handlers = {
  /**
   * What Settings and the popup render from that is not the worker's: the
   * address. Who is signed in is the worker's to say (WORKER_STATE), because
   * its identity is the only sign-in there is.
   */
  async STATE() {
    return { settings: await settings() };
  },

  /**
   * Ask the vendor page a person has open what the adapter would find on it.
   *
   * The adapter's own page script (adapters/appfolio_vendor/page.js) reads the
   * page with the hooks in selectors.v1.js and answers which it found: step 0
   * of the rollout ladder. It clicks nothing and types nothing, so it is safe
   * on a live client's work order — which matters, because there is no
   * AppFolio sandbox and the alternative is finding out by submitting
   * something.
   */
  async PROBE_PAGE() {
    const tab = await probe_target();

    if (!tab?.id)
      return {
        ok: false,
        error: "Open an AppFolio vendor work order in another tab first, then check again.",
      };

    const answer = await chrome.tabs
      .sendMessage(tab.id, { type: "ASH_PAGE_COMMAND", command: "probe", args: {} })
      .catch(() => null);

    if (!answer?.ok)
      return {
        ok: false,
        error: "That page did not answer. Reload it and try again.",
      };

    return { ok: true, report: { tab_title: tab.title || tab.url || "", adapter: answer.result } };
  },

  /**
   * Save the address, and sign out if it is a different web app.
   *
   * A worker identity is only meaningful to the web app that issued it, and
   * the new address would refuse its token — so a changed address signs the
   * worker out here rather than leaving a deliberate change to look like a
   * surprise sign-out a minute later. (The worker also ignores an identity
   * stored against another address; this makes it plain, and drops its
   * outbox and connections with it.)
   *
   * The comparison is the whole normalized address, not the origin. Origin
   * would be the natural choice and it is wrong here: under XAMPP every project
   * shares http://localhost and is told apart only by its path, so
   * /projects/alabamasignaturehomes and /projects/something-else are different
   * applications with identical origins. Normalizing first is what keeps a
   * dropped trailing slash from reading as a move.
   *
   * Only the address is accepted: it is the only setting there is, and taking
   * whatever else a patch carried would put back the keys remove_legacy()
   * just took away.
   */
  async SAVE_SETTINGS({ patch }) {
    if (typeof patch?.app_url !== "string") return { ok: false, error: "There is nothing to save." };

    const before = await settings();
    const app_url = normalize_base(patch.app_url);
    const had = normalize_base(before.app_url);
    const moved = had !== "" && app_url !== had;

    await save_settings({ app_url });

    if (!moved) return { ok: true, settings: await settings() };

    /* Forgotten locally rather than retired. The device belongs to the address
       we are leaving, and the worker API has no way for a device to retire
       itself — it is ended from the old app's own /account page. */
    await worker_sign_out();

    return {
      ok: true,
      settings: await settings(),
      moved: true,
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

  /**
   * Register this browser as a worker (`/api/worker/register`). A real sign-in
   * — the web app's throttle and lockout apply — and the only one there is:
   * the password is sent once, for a device token, and never stored.
   */
  async SIGN_IN({ email, password, device_name }) {
    return worker_sign_in({ email, password, device_name });
  },

  async SIGN_OUT() {
    await worker_sign_out();

    return { ok: true };
  },
};

/**
 * Every message here comes from the extension's own pages: none of them is
 * anything a content script needs, and all of them change what the extension
 * is. See background/senders.js.
 *
 * `true` is returned synchronously so Chrome keeps the port open for the async
 * answer — the single most common way an MV3 message handler silently returns
 * undefined is forgetting it. A type this file does not know is left for
 * worker/index.js's listener to answer.
 */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];

  if (!handler) return false;

  if (!from_extension_page(sender)) {
    respond({ ok: false, error: "That request is not accepted from this page." });

    return false;
  }

  Promise.resolve(handler(message.payload ?? {}, sender))
    .then((result) => respond(result ?? { ok: true }))
    .catch((error) =>
      respond({ ok: false, error: error?.message || "Something went wrong." }),
    );

  return true;
});

/**
 * Clear away what the legacy runtime left: its storage (store.js says what),
 * its alarms, and the count it kept on the toolbar icon.
 */
async function remove_legacy_runtime() {
  await remove_legacy().catch(() => null);

  for (const name of LEGACY_ALARMS) await chrome.alarms.clear(name).catch(() => false);

  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    /* A badge is decoration; never a reason to fail an install. */
  }
}

/**
 * On install and on every browser start.
 *
 * Created rather than checked for: chrome.alarms.create replaces an alarm of
 * the same name, so re-arming on every wake is how the schedule survives an
 * update that changed its period.
 */
function wake() {
  start_worker_schedule();
}

chrome.runtime.onInstalled.addListener(async () => {
  await remove_legacy_runtime();
  wake();
});

chrome.runtime.onStartup.addListener(() => {
  wake();
});
