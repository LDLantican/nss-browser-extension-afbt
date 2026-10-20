/**
 * The worker's view of Chrome — every effect the runtime has, in one object.
 *
 * worker/runtime.js and worker/job.js never touch `chrome.*` themselves. They
 * are handed this `env`, and the tests hand them a fake one, which is how the
 * same job code is killed after every storage write and request under Node,
 * and run against a real web app.
 *
 *   version            the build, sent as X-Extension-Version
 *   base_url()         the web app address from Settings
 *   local, session     get / set / remove over chrome.storage
 *   fetch(url, init)   with a timeout, no cookies, no cache
 *   now(), sleep(ms), uuid()
 *   extension_url(p)   a page packaged in the extension
 *   tabs               open / navigate / exists / url / close / reveal / close_strays
 *   page.send(...)     one command to an adapter's page script
 *
 * ## The "ASH" tab group
 *
 * A job runs in a background tab, gathered into one collapsed tab group named
 * ASH, so a desk that works the queue all day collects one quiet chip rather
 * than a row of tabs — and not a minimized window, which can stall a page's
 * rendering. Every tab opened here is written down in `storage.session` the
 * moment it exists, so a worker that died holding one closes it at the next
 * tick (close_strays) unless the job in hand still needs it.
 */

import { settings } from "../background/store.js";
import { notify } from "../background/notify.js";
import { AdapterError, TabGone, TRANSIENT, UNKNOWN_OUTCOME } from "./errors.js";

const TABS_KEY = "ash_worker_tabs";
const GROUP_KEY = "ash_worker_group";
const GROUP_TITLE = "ASH";

const FETCH_TIMEOUT_MS = 20000;
const LOAD_TIMEOUT_MS = 30000;
const PAGE_TIMEOUT_MS = 30000;

function storage(area) {
  return {
    async get(key) {
      const { [key]: value } = await area.get(key);

      return value ?? null;
    },
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function remember_tab(tab_id) {
  const { [TABS_KEY]: tabs = [] } = await chrome.storage.session.get(TABS_KEY);

  await chrome.storage.session.set({ [TABS_KEY]: [...new Set([...tabs, tab_id])] });
}

async function forget_tab(tab_id) {
  const { [TABS_KEY]: tabs = [] } = await chrome.storage.session.get(TABS_KEY);

  await chrome.storage.session.set({ [TABS_KEY]: tabs.filter((id) => id !== tab_id) });
}

async function wait_loaded(tab_id, timeout = LOAD_TIMEOUT_MS) {
  const until = Date.now() + timeout;

  for (;;) {
    const tab = await chrome.tabs.get(tab_id).catch(() => null);

    if (!tab) return false;
    if (tab.status === "complete") return true;
    if (Date.now() > until) return true;

    await sleep(100);
  }
}

/**
 * Put a tab in the collapsed ASH group, making the group if this window has
 * none. Best effort: a browser without tab groups still works the job, in a
 * plain background tab.
 */
async function group(tab_id) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;

  try {
    const tab = await chrome.tabs.get(tab_id);
    const { [GROUP_KEY]: known = null } = await chrome.storage.session.get(GROUP_KEY);
    const existing = known === null ? null : await chrome.tabGroups.get(known).catch(() => null);

    if (existing && existing.windowId === tab.windowId) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: [tab_id] });

      return;
    }

    const id = await chrome.tabs.group({ tabIds: [tab_id], createProperties: { windowId: tab.windowId } });

    await chrome.tabGroups.update(id, { title: GROUP_TITLE, collapsed: true, color: "grey" });
    await chrome.storage.session.set({ [GROUP_KEY]: id });
  } catch {
    /* A tab group is tidiness, never a reason to fail a job. */
  }
}

export function create_chrome_env() {
  return {
    version: chrome.runtime.getManifest().version || "",

    async base_url() {
      return (await settings()).app_url || "";
    },

    local: storage(chrome.storage.local),
    session: storage(chrome.storage.session),

    async fetch(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        /* No cookies: every call is bearer-authenticated, and a request riding
           on an ambient session cookie is the thing CSRF tokens exist to stop. */
        return await fetch(url, { ...init, signal: controller.signal, credentials: "omit", cache: "no-store" });
      } finally {
        clearTimeout(timer);
      }
    },

    now: () => Date.now(),
    sleep,
    uuid: () => crypto.randomUUID(),
    extension_url: (path) => chrome.runtime.getURL(path),

    tabs: {
      async open(url) {
        const tab = await chrome.tabs.create({ url, active: false }).catch(() => null);

        if (!tab?.id) return null;

        await remember_tab(tab.id);
        await group(tab.id);
        await wait_loaded(tab.id);

        return tab.id;
      },

      async navigate(tab_id, url) {
        const tab = await chrome.tabs.update(tab_id, { url }).catch(() => null);

        if (!tab) return false;

        return wait_loaded(tab_id);
      },

      exists: (tab_id) => chrome.tabs.get(tab_id).then(() => true, () => false),

      /** The address a tab shows now — where a sign-in redirect shows first. */
      url: (tab_id) => chrome.tabs.get(tab_id).then((tab) => tab.pendingUrl || tab.url || null, () => null),

      async close(tab_id) {
        await forget_tab(tab_id);
        await chrome.tabs.remove(tab_id).catch(() => null);
      },

      /**
       * The tabs a page in `tab_id` opened — AppFolio opens an inspection from
       * its list in a new one (appfolio_pm). Each is remembered as this
       * worker's, so one left open by a worker that died is closed by the
       * next tick's close_strays.
       */
      async children(tab_id) {
        const tabs = await chrome.tabs.query({}).catch(() => []);
        const opened = tabs.filter((tab) => tab.openerTabId === tab_id);

        for (const tab of opened) await remember_tab(tab.id);

        return opened.map((tab) => ({ id: tab.id, url: tab.pendingUrl || tab.url || null }));
      },

      /** Hand the tab to a person: out of the collapsed group, in front, and said so. */
      async reveal(tab_id, message) {
        try {
          const tab = await chrome.tabs.get(tab_id);

          if (chrome.tabs.ungroup) await chrome.tabs.ungroup(tab_id).catch(() => null);
          await chrome.tabs.update(tab_id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch {
          /* The person is told either way. */
        }

        notify("ASH delivery", message || "A job is waiting for you in the browser.");
      },

      /** Close every tab this worker opened except `keep`. */
      async close_strays(keep) {
        const { [TABS_KEY]: tabs = [] } = await chrome.storage.session.get(TABS_KEY);
        const strays = tabs.filter((id) => id !== keep);

        for (const tab_id of strays) await chrome.tabs.remove(tab_id).catch(() => null);

        await chrome.storage.session.set({ [TABS_KEY]: keep === null ? [] : tabs.filter((id) => id === keep) });
      },
    },

    page: {
      /**
       * One command to the adapter's script in a tab.
       *
       * Asked again while nothing answers — a page still loading has no
       * listener yet. **Not** asked again when `once` is set and the message
       * may have arrived: the commit step's click is sent once, because a page
       * that pressed the button and navigated away before answering looks
       * exactly like a page that never heard, and asking twice is the double
       * invoice. That case is an unknown outcome, which verification settles.
       */
      async send(tab_id, command, args = {}, { once = false, timeout_ms = PAGE_TIMEOUT_MS } = {}) {
        const until = Date.now() + timeout_ms;
        const message = { type: "ASH_PAGE_COMMAND", tab_id, command, args };
        const own_pages = chrome.runtime.getURL("");

        for (;;) {
          const tab = await chrome.tabs.get(tab_id).catch(() => null);

          if (!tab) throw new TabGone();

          let answer;
          let unreached = false;

          try {
            /* An extension page in a tab (the fixture site) hears runtime
               messages; a content script on a real portal hears tab messages. */
            answer = String(tab.url || "").startsWith(own_pages)
              ? await chrome.runtime.sendMessage(message)
              : await chrome.tabs.sendMessage(tab_id, message);
          } catch (error) {
            unreached = /Receiving end does not exist/i.test(String(error?.message || ""));
            answer = undefined;
          }

          if (answer && typeof answer === "object") {
            if (answer.ok) return answer.result;

            throw new AdapterError(answer.error_class || "adapter_broken", answer.error || `The page refused "${command}".`);
          }

          if (once && !unreached)
            throw new AdapterError(UNKNOWN_OUTCOME, `The page did not confirm "${command}", so nobody knows whether it happened.`);

          if (Date.now() > until) throw new AdapterError(TRANSIENT, `The page did not answer "${command}".`);

          await sleep(250);
        }
      },
    },
  };
}
