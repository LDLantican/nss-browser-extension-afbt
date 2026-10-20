/**
 * The delivery worker, wired into Chrome — the extension's only runtime since
 * 4.0.0, when the legacy drain and its `/api/session` sign-in were removed
 * (roadmap phase 11). Imported by background/service_worker.js. It has its own
 * credentials (a worker device token, exchanged hourly for an access token),
 * its own alarm and its own tabs.
 *
 * The timer is `chrome.alarms`, every minute — the shortest period Chrome
 * honours, and the only timer that survives the service worker being ended.
 * A worker that wakes for any other reason with a job in hand resumes it at
 * once rather than waiting for the alarm, because that job holds a lease.
 */

import { from_extension_page, from_tab_on } from "../background/senders.js";
import { create_chrome_env } from "./chrome_env.js";
import { SESSION_KEY as VENDOR_SESSION_KEY } from "../adapters/appfolio_vendor/adapter.js";
import { create_imports } from "./imports.js";
import { JOB_KEY, STOP_AFTER_PRESS_KEY } from "./job.js";
import { create_registry } from "./registry.js";
import { create_runtime } from "./runtime.js";

const ALARM = "ash-worker-tick";

const env = create_chrome_env();
const runtime = create_runtime(env, create_registry());
const imports = create_imports({ client: runtime.rt.client });

/**
 * The two messages a content script may send here, and from where: the
 * property manager's AppFolio pages, which is where the Import button is.
 * Everything else in this file answers only the extension's own pages.
 */
const PAGE_MESSAGES = {
  IMPORT_STATUSES: ["*.appfolio.com"],
  IMPORT: ["*.appfolio.com"],
  ASH_VENDOR_SEEN: ["vendor.appfolio.com"],
};

export function start_worker_schedule() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

/**
 * Register this browser as a worker with the person's email and password —
 * the extension's only sign-in, called by the SIGN_IN handler.
 */
export async function worker_sign_in({ email, password, device_name }) {
  try {
    const answer = await runtime.sign_in({ email, password, device_name });

    if (!answer.ok)
      return {
        ok: false,
        error: answer.status === 404
          ? "The web app's worker API is switched off, so this browser can neither import nor deliver."
          : answer.body?.error || `The web app refused the worker sign-in (${answer.status}).`,
      };

    runtime.tick("sign_in");

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not sign in the delivery worker." };
  }
}

export async function worker_sign_out() {
  await runtime.sign_out().catch(() => null);
}

const handlers = {
  WORKER_STATE: () => runtime.state(),

  async WORKER_SET_PROCESSING({ on }) {
    await runtime.set_processing(on === true);

    /* Told to the server straight away, in the heartbeat, rather than at the
       next minute — a person switching it off wants it off. */
    await runtime.tick("switch");

    return runtime.state();
  },

  async WORKER_TICK() {
    await runtime.tick("manual");

    return runtime.state();
  },

  /* Troubleshooting: stop dead after the next press (worker/job.js says why). */
  async WORKER_STOP_AFTER_NEXT_PRESS() {
    await env.local.set(STOP_AFTER_PRESS_KEY, 1);

    return { ok: true };
  },

  /* The AppFolio import (phase 8): the rows' status, and the rows themselves.
     Which connection is the page's host (3.3.0), taken from the tab Chrome says
     sent the message rather than from anything the page wrote; the company is
     what the page shows, for the web app to check. */
  IMPORT_STATUSES: ({ numbers, company }, sender) =>
    imports.lookup(Array.isArray(numbers) ? numbers : [], { host: host_of(sender), company }),
  IMPORT: ({ records, company }, sender) =>
    imports.send(Array.isArray(records) ? records : [], { host: host_of(sender), company }),

  /* A vendor-portal page loaded in this browser, and said whether it is
     signed in (adapters/appfolio_vendor/page.js). Kept as the adapter's
     cached session, so a person's own browsing spares a probe tab. */
  async ASH_VENDOR_SEEN({ state, account }) {
    if (state !== "live" && state !== "expired") return { ok: false };

    await env.local.set(VENDOR_SESSION_KEY, { state, account: /^\d+$/.test(String(account || "")) ? String(account) : null, at: env.now() });

    return { ok: true };
  },
};

/** The host of the page a message came from, as Chrome reports the sender. */
function host_of(sender) {
  try {
    return new URL(sender?.url || sender?.tab?.url || "").host;
  } catch {
    return "";
  }
}

function sender_allowed(type, sender) {
  if (from_extension_page(sender)) return true;

  const hosts = PAGE_MESSAGES[type];

  return hosts !== undefined && from_tab_on(sender, hosts);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];

  if (!handler) return false;

  if (!sender_allowed(message.type, sender)) {
    respond({ ok: false, error: "That request is not accepted from this page." });

    return false;
  }

  Promise.resolve(handler(message.payload ?? {}, sender))
    .then((result) => respond(result ?? { ok: true }))
    .catch((error) => respond({ ok: false, error: error?.message || "Something went wrong." }));

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runtime.tick("alarm");
});

/* Every wake: make sure the alarm exists (an update or a cleared alarm would
   otherwise leave the worker deaf), and resume a job a dead worker left. */
chrome.alarms.get(ALARM).then((alarm) => {
  if (!alarm) start_worker_schedule();
});

env.session.get(JOB_KEY).then((held) => {
  if (held) runtime.tick("resume");
});
