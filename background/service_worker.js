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
  bt_pending_links,
  update_bt_pending_links,
  bt_last_run,
  save_bt_last_run,
  bt_last_estimate_run,
  save_bt_last_estimate_run,
  delivery_status,
  save_delivery_status,
  migrate_bt_unrecorded,
  tab_errors,
  clear_tab_errors,
  tab_errors_seen_at,
  mark_tab_errors_seen,
} from "./store.js";
import { notify, set_badge } from "./notify.js";
import { api, normalize_base, origin_pattern } from "./api.js";
import { run_queue, find_existing_job } from "./buildertrend.js";
import { deliver_estimates_now } from "./estimates.js";
import { is_owned } from "./owned_tabs.js";
import { PORTALS, show_sign_in, waiting_sign_in_tab } from "./portals.js";
import {
  deliver_now,
  is_delivery_alarm,
  start_delivery_schedule,
} from "./delivery.js";

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

/**
 * The vendor-portal tab a page check should read.
 *
 * The active tab when it is one — that is the page the person is looking at.
 * Otherwise the vendor tab they used most recently, because the check is now
 * run from Settings, which is a tab of its own and so is always the active one.
 * Tabs this extension opened are skipped: they belong to a run, and a check
 * that read one mid-fill would describe a page nobody chose.
 */
async function probe_target() {
  const is_vendor = (tab) => String(tab?.url || "").startsWith("https://vendor.appfolio.com");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (is_vendor(active) && !is_owned(active.id)) return active;

  const tabs = await chrome.tabs.query({ url: "https://vendor.appfolio.com/*" });

  return tabs
    .filter((tab) => !is_owned(tab.id))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

/** Keeps the toolbar badge honest without anybody having to remember to. */
async function refresh_badge() {
  set_badge(await sync.summary());
}

const handlers = {
  /* ---- state the UI renders from ---------------------------------------- */

  async STATE() {
    const [config, session, counts, jobs, queue, pending, last_run, last_estimate, errors, seen_at, outgoing] =
      await Promise.all([
        settings(),
        auth.state(),
        sync.summary(),
        sync.sync_jobs_snapshot(),
        bt_queue(),
        bt_pending_links(),
        bt_last_run(),
        bt_last_estimate_run(),
        tab_errors(),
        tab_errors_seen_at(),
        delivery_status(),
      ]);

    return {
      settings: config,
      session,
      counts,
      jobs,
      bt_queue: queue,
      /* Both new, and both for the same reason: what the Buildertrend leg did
         was knowable only to itself. A pending link is work somebody has to
         finish, and the last run is the only account of why. */
      bt_pending_links: pending,
      /* Rows a Buildertrend run is working on right now, so the popup stops
         offering Add for a job that is being created in another tab. */
      bt_in_flight: [...bt_in_flight],
      bt_last_run: last_run,
      bt_last_estimate_run: last_estimate,
      /* Where the invoice and estimate queues stood after their last run, so
         the status line covers work going out as well as work coming in. */
      delivery: outgoing,
      /* A count and not the reports: they carry screenshots, and the popup
         only says how many there are and where to read them. */
      tab_errors_unseen: errors.filter((entry) => entry.at > seen_at).length,
      suggested_device_name: auth.suggested_device_name(),
    };
  },

  /* ---- tab-error reports, for the Diagnostics card in Settings ----------- */

  async TAB_ERRORS() {
    return { ok: true, reports: await tab_errors() };
  },

  async TAB_ERRORS_SEEN() {
    await mark_tab_errors_seen();

    return { ok: true };
  },

  async CLEAR_TAB_ERRORS() {
    await clear_tab_errors();

    return { ok: true };
  },

  /**
   * Check everything the popup remembers against what the web app holds now.
   *
   * Everything STATE returns is this extension's own memory, and memory outlives
   * the things it describes: work orders removed from the web app kept showing as
   * synced, as waiting to be linked to Buildertrend, and in the run reports. So
   * the popup asks for this once each time it opens, and whatever describes a
   * work order the web app no longer has is forgotten.
   *
   * One lookup answers all three stores. A lookup that fails deletes nothing —
   * being unable to ask is never evidence that something is gone.
   *
   * The Buildertrend queue is deliberately left alone. It is work on its way to
   * Buildertrend, which does not depend on the web app holding the number.
   */
  async REFRESH() {
    const [ledger, pending, last_run, last_estimate] = await Promise.all([
      sync.landed_numbers(),
      bt_pending_links(),
      bt_last_run(),
      bt_last_estimate_run(),
    ]);

    const numbers = [
      ...new Set([
        ...ledger,
        ...Object.keys(pending),
        ...(last_run?.jobs || []).map((job) => String(job.number)),
        ...(last_estimate?.reports || []).map((report) => String(report.number)),
      ]),
    ].filter((number) => number !== "");

    const removed = { synced: 0, pending: 0, runs: 0 };

    if (numbers.length === 0) return { ok: true, removed };

    const found = await lookup_all(numbers);

    if (found.ok === false) {
      /* Still drops the remembered status labels, which is the one thing a
         failed lookup does make wrong. */
      await sync.refresh_ledger(null);

      return { ok: false, reason: found.reason, error: found.error, removed };
    }

    const held = found.work_orders;

    removed.synced = (await sync.refresh_ledger(held)).removed;

    /* Gone from the web app, there is nothing to link against; already holding a
       URL, it was linked some other way. Either way the Link now button could
       only fail or do nothing. */
    const settled = Object.keys(pending).filter(
      (number) => !held[number] || (held[number].buildertrend_url || "") !== "",
    );

    if (settled.length > 0) await forget_pending_links(settled);

    removed.pending = settled.length;

    /* A run report is history, so its summary line is left as it was — but the
       jobs it names that no longer exist are dropped, and a report left naming
       nothing is removed rather than shown. */
    if ((last_run?.jobs || []).length > 0) {
      const jobs = last_run.jobs.filter((job) => held[String(job.number)]);

      if (jobs.length !== last_run.jobs.length) {
        await save_bt_last_run(jobs.length === 0 ? null : { ...last_run, jobs });
        removed.runs++;
      }
    }

    if ((last_estimate?.reports || []).length > 0) {
      const reports = last_estimate.reports.filter((report) => held[String(report.number)]);

      if (reports.length !== last_estimate.reports.length) {
        await save_bt_last_estimate_run(reports.length === 0 ? null : { ...last_estimate, reports });
        removed.runs++;
      }
    }

    await refresh_badge();

    return { ok: true, removed };
  },

  /* ---- delivery ---------------------------------------------------------- */

  /**
   * Work the delivery queue now, rather than waiting for the alarm.
   *
   * `manual` is only recorded, on any tab-error report the run writes. It used
   * to leave the tab open afterwards so somebody could see what happened; every
   * run closes its tab now, and the report is what is left to look at.
   */
  async DELIVER_NOW() {
    return record_delivery("invoices", await deliver_now({ manual: true }));
  },

  /**
   * Ask the vendor page the manager is looking at what controls it has.
   *
   * The cheapest answer to the only thing nobody has been able to check: are
   * the labels the content script looks for the labels that page actually uses.
   * It clicks nothing and types nothing, so it is safe to run against a live
   * client's work order — which matters, because there is no AppFolio sandbox
   * and the alternative is finding out by submitting something.
   *
   * Deliberately a tab a person opened rather than the delivery tab — the
   * active one if it is on the portal, else the most recently used. It is run
   * from Settings > Troubleshooting now, so see probe_target().
   */
  async PROBE_PAGE() {
    const tab = await probe_target();

    if (!tab?.id)
      return {
        ok: false,
        error: "Open an AppFolio vendor work order in another tab first, then check again.",
      };

    try {
      const report = await chrome.tabs.sendMessage(tab.id, { type: "VENDOR_PAGE_PROBE" });

      return { ok: true, report: { ...report, tab_title: tab.title || tab.url || "" } };
    } catch {
      return {
        ok: false,
        error: "That page did not answer. Reload it and try again.",
      };
    }
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

  /**
   * Take a row out of the Buildertrend queue by hand.
   *
   * The popup's Remove button, and nothing else. The new-job page used to send
   * this too, the moment it saw its own save — which quietly defeated the
   * queue: a job whose URL could not be recorded afterwards was dropped anyway,
   * leaving the work order in Buildertrend with no link and nothing left to
   * retry. The run clears its own rows now, after the link is recorded.
   *
   * A person asking for a row to go is a different thing, and still allowed.
   */
  async UNQUEUE_FROM_BT({ numbers }) {
    const wanted = new Set((Array.isArray(numbers) ? numbers : [numbers]).map(String));

    await update_bt_queue((queue) => {
      const next = { ...queue };

      for (const number of wanted) delete next[number];

      return next;
    });

    return { ok: true };
  },

  /**
   * Settle one pending link, on demand, without touching Buildertrend's form.
   *
   * Two shapes to settle, and the difference is only whether the id is known:
   * a row that has a URL is one POST, and a row without one has to be found in
   * Buildertrend first. Finding it reuses the job picker search the run itself
   * uses — but from a tab opened for this and brought to the front, with no
   * fill racing it and no batch waiting behind it, which is the difference
   * between a lookup that has one chance and one that can simply be tried
   * again.
   *
   * It never opens the add-job page, so it cannot create anything. That is
   * what makes it safe to offer as a button.
   */
  async LINK_NOW({ number }) {
    const wanted = String(number || "").trim();

    if (wanted === "") return { ok: false, error: "No work order was named." };

    const parked = await bt_pending_links();
    const entry = parked[wanted];

    if (!entry) return { ok: false, error: `${wanted} is not waiting to be linked.` };

    let url = entry.url || null;

    if (!url) {
      const found = await find_existing_job(wanted, entry.title || "");

      if (!found.ok) return found;

      url = found.url;
    }

    const answer = await record_link(wanted, url);

    if (!answer.ok) return { ok: false, error: answer.error };

    await forget_pending_links([wanted]);

    return { ok: true, url };
  },

  /**
   * Write the approved work waiting for a Buildertrend estimate, now.
   *
   * The popup's "run now". The same run also happens by itself on the delivery
   * alarm below, straight after the invoice run. It used to be asked for
   * rather than scheduled, because driving Buildertrend's job picker needed a
   * tab brought to the front; the estimate leg calls Buildertrend's own API
   * now, never takes focus, and so has no reason to wait for a button.
   */
  async DELIVER_ESTIMATES() {
    return record_delivery("estimates", await deliver_estimates_now({ manual: true }));
  },

  /**
   * Put a portal's sign-in page in front of somebody.
   *
   * The tab a timed run already left open when there is one — opening a second
   * is how a desk collects sign-in tabs — and the portal's home page otherwise,
   * which redirects to the sign-in page by itself.
   */
  async OPEN_SIGN_IN(payload) {
    const site = payload?.site;
    const portal = PORTALS[site];

    if (!portal) return { ok: false, error: `Unknown portal: ${site}.` };

    const waiting = await waiting_sign_in_tab(site);

    if (waiting !== null) {
      await show_sign_in(waiting);

      return { ok: true };
    }

    await chrome.tabs.create({ url: portal.home, active: true });

    return { ok: true };
  },

  /**
   * The popup's one "Send now": invoices, then estimates, as a single pass.
   *
   * It shares the alarm's `scheduled_pass` guard rather than calling the two
   * handlers above one after the other, so a press during a timed pass does not
   * start a second run beside it — and the answer to that press is "already
   * sending", which is true, rather than a summary of nothing.
   *
   * Estimates run here even when `bt_auto_estimates` is off. That setting is
   * about what happens with nobody watching; pressing the button is somebody
   * choosing, which is exactly what that browser was set up to wait for.
   */
  async SEND_NOW() {
    if (scheduled_pass !== null) return { ok: true, busy: true };

    const failed = (error) => ({ ok: false, error: String(error?.message || error) });
    let answer = { ok: true };

    scheduled_pass = (async () => {
      const invoices = await record_delivery("invoices", await deliver_now({ manual: true }).catch(failed));
      const config = await settings();

      const estimates = config.buildertrend_enabled !== false
        ? await record_delivery("estimates", await deliver_estimates_now({ manual: true }).catch(failed))
        : null;

      answer = { ok: true, invoices, estimates };
    })().finally(() => {
      scheduled_pass = null;
    });

    await scheduled_pass;

    return answer;
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

  /**
   * The popup's "Add to Buildertrend", for one queued row.
   *
   * The same run as RUN_BT_QUEUE over a queue of one. It used to call fill_job
   * directly and stop, so a job it saved never left the queue and its link was
   * never recorded — the popup went on offering Add, and pressing it again made
   * a second real job. Everything that happens after a save lives in
   * create_bt_jobs() so there is one copy of it.
   */
  async FILL_JOB({ number }) {
    const config = await settings();

    if (config.buildertrend_enabled === false)
      return { ok: false, error: "Buildertrend is switched off in Settings." };

    const queue = await bt_queue();
    const work_order = queue[String(number)];

    if (!work_order) return { ok: false, error: "That work order is not in the queue." };

    return create_bt_jobs([work_order], config);
  },

  /**
   * Create every queued BuilderTrend job, one after another, in one tab.
   *
   * Started by the AppFolio sync rather than by a button, because the point of
   * this leg is that a manager ticks rows, presses Sync once, and the work
   * orders land in both places. Twenty rows must not be twenty button presses.
   *
   * Nothing is created for a work order the web app already has a BuilderTrend
   * URL for. That is the only idempotency available — BuilderTrend has no API
   * to ask whether a job exists, and the queue clears only on a positive save
   * signal sent fire-and-forget from a tab that may be closed a second later.
   * Without this check a re-run makes a second real job.
   */
  async RUN_BT_QUEUE() {
    const config = await settings();

    if (config.buildertrend_enabled === false)
      return { ok: false, error: "Buildertrend is switched off in Settings." };

    const rows = Object.values(await bt_queue());

    if (rows.length === 0) return { ok: true, summary: { created: 0, failed: 0, skipped: 0 } };

    return create_bt_jobs(rows, config);
  },
};

/**
 * The one Buildertrend creation run that may be going, if any.
 *
 * Module state, like `scheduled_pass`. Two runs side by side — a sync's run and
 * a press of Add, or two presses from a popup that closed and reopened — each
 * saw the row still queued and each created a job, and two jobs sharing a title
 * make both unlinkable. A second request now answers `busy` instead.
 *
 * An evicted worker forgets this, and look_before_creating() in buildertrend.js
 * is what still stops a duplicate then.
 */
let bt_run = null;

/** The numbers the current run holds, so the popup can stop offering Add. */
const bt_in_flight = new Set();

function create_bt_jobs(rows, config) {
  if (bt_run !== null) return Promise.resolve({ ok: true, busy: true });

  for (const row of rows) bt_in_flight.add(String(row.number));

  bt_run = work_bt_jobs(rows, config).finally(() => {
    bt_run = null;
    bt_in_flight.clear();
  });

  return bt_run;
}

async function work_bt_jobs(rows, config) {
  /* One lookup for the whole batch rather than one per job. A web app that
     cannot be reached answers nothing, and then nothing is skipped — which is
     the safe direction only because fill_job refuses on its own when the
     scope cannot be read. */
  const already = new Set();

  try {
    const answer = await api.lookup(rows.map((row) => String(row.number)));

    if (answer.ok)
      for (const [number, held] of Object.entries(answer.body?.work_orders || {}))
        if ((held?.buildertrend_url || "") !== "") already.add(String(number));
  } catch {
    /* Left empty on purpose; see above. */
  }

  /* Anything left over from a previous run goes first: it is a single POST to
     our own server and, until it lands, the work order looks to everything
     else like a job that was never created. */
  await flush_pending_links();

  const outstanding = rows.filter((row) => !already.has(String(row.number)));

  if (already.size > 0) await drop_from_bt_queue([...already]);

  if (outstanding.length === 0)
    return { ok: true, summary: { created: 0, failed: 0, skipped: 0, already: already.size } };

  const started_at = Date.now();
  const jobs = [];

  const summary = await run_queue(outstanding, config, async (outcome) => {
    const entry = {
      number: outcome.number,
      created: outcome.created === true,
      existing: outcome.existing === true,
      ok: outcome.ok === true,
      url: outcome.url || null,
      error: outcome.error || "",
      detail: outcome.detail || null,
      link: null,
    };

    /* Nothing was created, so the row stays queued and there is nothing to
       link. This is the only path that leaves `bt_queue` untouched, and it
       has to be, because it is the only one where Buildertrend holds
       nothing. */
    if (!entry.created) {
      jobs.push(entry);

      return;
    }

    /* From here Buildertrend holds a job, so the row leaves the queue
       whatever else happens: leaving it is what makes a second real job on
       the next run, and two jobs sharing a title make the id unfindable for
       both. The shortfall is parked instead — never dropped. */
    await drop_from_bt_queue([outcome.number]);

    if (!outcome.url) {
      await park_pending_link(outcome.number, null, outcome.title || "", outcome.error || "");
      jobs.push(entry);

      return;
    }

    entry.link = await record_link(outcome.number, outcome.url);

    if (!entry.link.ok)
      await park_pending_link(outcome.number, outcome.url, outcome.title || "", entry.link.error);

    jobs.push(entry);
  });

  summary.already = (summary.already || 0) + already.size;
  summary.pending = Object.keys(await bt_pending_links()).length;

  await save_bt_last_run({
    started_at,
    finished_at: Date.now(),
    summary,
    jobs,
  });

  /* One notification for the run, not one per job: notify.js reuses a single
     id, so per-job messages would overwrite each other and only the last
     would ever be readable. */
  notify("Buildertrend", bt_run_message(summary));

  return { ok: true, summary };
}

/**
 * Tell the web app where a job ended up, and say plainly whether it took it.
 *
 * `request()` answers `{ ok: false }` for an HTTP error rather than throwing —
 * the same shape `api.lookup` is read for a few lines above — so the `.catch()`
 * this used to rely on fired only for a dead network. A 401, a 422 or a 500
 * sailed straight through as success and the link was dropped on the next line.
 *
 * `recorded: false` is not a failure: it means the work order already had a
 * URL, which is the answer that prevents a second job rather than an error.
 */
async function record_link(number, url) {
  let last = { ok: false, status: 0, error: "The web app was never reached." };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));

    try {
      const answer = await api.remember_buildertrend(number, url);

      if (answer?.ok === true) return { ok: true, status: answer.status, error: "" };

      /* Kept rather than reduced to false. A lapsed token, a refused payload
         and a dead server all ended as the same silent parking, so the one
         question worth asking — *why* would the web app not take it* — had no
         answer anywhere. */
      last = {
        ok: false,
        status: answer?.status || 0,
        error: answer?.body?.error || `The web app answered ${answer?.status || "nothing"}.`,
      };

      /* A refusal is settled, not slow. Retrying a 422 just delays the parking
         and a 404 means the work order is not there to record against. */
      if (answer?.status === 422 || answer?.status === 404) return last;
    } catch (error) {
      /* Network. Worth another go. */
      last = { ok: false, status: 0, error: error?.message || "Could not reach the web app." };
    }
  }

  return last;
}

/**
 * Remember that Buildertrend holds a job the web app cannot point at.
 *
 * `url` may be null, and that is the point: a job whose id could not be read is
 * just as unlinked as one the server refused, and whoever is looking needs to
 * see both. What must never happen is the row staying in `bt_queue`, because
 * that is what makes a second real job on the next run.
 */
async function park_pending_link(number, url, title, reason) {
  await update_bt_pending_links((parked) => ({
    ...parked,
    [String(number)]: { url: url || null, title: title || "", reason: reason || "", at: Date.now() },
  }));
}

async function forget_pending_links(numbers) {
  const wanted = new Set(numbers.map(String));

  await update_bt_pending_links((current) => {
    const next = { ...current };

    for (const number of wanted) delete next[number];

    return next;
  });
}

/**
 * Settle every pending link that can be settled without a browser.
 *
 * Only the ones whose URL is already known: those are one POST each. A row
 * with no URL needs Buildertrend open and searched, which is what LINK_NOW is
 * for — doing it here would open tabs behind a manager who only pressed Sync.
 */
async function flush_pending_links() {
  const parked = await bt_pending_links();
  const settled = [];

  for (const [number, entry] of Object.entries(parked)) {
    const url = entry?.url;
    if (!url) continue;

    const answer = await record_link(number, url);

    /* A 404 is settled too, in the other direction: the work order it would be
       recorded against is gone, so there is nothing this can ever accomplish.
       Keeping it would leave a row in the popup that no amount of pressing
       could clear — a permanent piece of confusing furniture. Dropping a link
       is normally the thing this whole area exists to prevent, which is why it
       is done only for the one answer that means the other end no longer
       exists. */
    if (answer.ok || answer.status === 404) settled.push(number);
  }

  if (settled.length > 0) await forget_pending_links(settled);

  return settled.length;
}

/** Matches the web app's work_orders.api.lookup_max. */
const LOOKUP_MAX = 500;

/**
 * What the web app holds for any number of work orders, as one map.
 *
 * All or nothing: one failed chunk fails the whole answer, because a partial
 * map would read the unasked numbers as gone.
 */
async function lookup_all(numbers) {
  const work_orders = {};

  for (let index = 0; index < numbers.length; index += LOOKUP_MAX) {
    let answer;

    try {
      answer = await api.lookup(numbers.slice(index, index + LOOKUP_MAX));
    } catch (error) {
      return { ok: false, reason: "unreachable", error: error?.message || "Could not reach the web app." };
    }

    if (!answer.ok)
      return {
        ok: false,
        reason: answer.status === 401 ? "signed_out" : "error",
        error: answer.body?.error || `The web app answered ${answer.status}.`,
      };

    Object.assign(work_orders, answer.body?.work_orders || {});
  }

  return { ok: true, work_orders };
}

async function drop_from_bt_queue(numbers) {
  const wanted = new Set(numbers.map(String));

  await update_bt_queue((queue) => {
    const next = { ...queue };

    for (const number of wanted) delete next[number];

    return next;
  });
}

function bt_run_message(summary) {
  const parts = [];

  if (summary.created > 0) parts.push(`${summary.created} added to Buildertrend`);
  if (summary.already > 0) parts.push(`${summary.already} already there`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} not attempted`);

  /* Named rather than folded into `failed`, because it is a different job for
     whoever reads it: the Buildertrend work is done and only the link is
     missing, and it is repairable from the popup without re-running anything. */
  if (summary.pending > 0)
    parts.push(`${summary.pending} waiting to be linked to the web app`);

  if (parts.length === 0) return "Nothing was waiting for Buildertrend.";

  return parts.join(" · ") + (summary.stopped && summary.reason ? `. ${summary.reason}` : ".");
}

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
  if (is_delivery_alarm(alarm.name)) {
    /* Not awaited and deliberately not reported anywhere. A scheduled run that
       finds nothing is the normal case, and a run that fails has already said
       so on the web app's own /deliveries screen — which is where somebody
       looking for it will look. A notification per empty minute would be
       noise that teaches people to ignore notifications. */
    scheduled_delivery();

    return;
  }

  if (alarm.name !== sync.ALARM) return;

  sync.trigger();
});

/**
 * One timed pass: invoices, then estimates.
 *
 * In sequence rather than side by side, so a minute never has a vendor portal
 * tab and a Buildertrend tab working at once. And the whole pass is the unit
 * of "already running", not each half: a forty-job invoice drain outlasts
 * several alarms, and without this every one of them would find the invoice
 * run busy, skip it, and start an estimate run beside it.
 *
 * Module state, so an evicted worker forgets it — which is harmless, because
 * the worker is only evicted when nothing is running.
 */
let scheduled_pass = null;

/**
 * Keep where an outgoing queue stood, for the popup's status line.
 *
 * Every run's result used to be dropped here, on the reasoning that a failure
 * shows on /deliveries. A signed-out portal never gets that far — the run
 * refuses before claiming anything, which is right — so it showed nowhere, and
 * the popup said "All caught up" over a queue of approved invoices.
 *
 * Returns what it was given, so a caller can wrap a run in it. A run that did
 * not happen (another was already going) leaves the last record alone.
 */
async function record_delivery(kind, result) {
  if (!result || result.skipped === "already running") return result;

  const summary = result.summary || {};

  await save_delivery_status(kind, {
    at: Date.now(),
    ok: result.ok !== false,
    error: result.ok === false ? String(result.error || "") : "",
    waiting: Number(summary.waiting) || 0,
    paused: summary.paused === true,
    awaiting_submit: summary.awaiting_submit === true,
    dry_run: summary.dry_run === true || (summary.rehearsed || 0) > 0,
    reason: String(summary.reason || ""),
  }).catch(() => null);

  return result;
}

function scheduled_delivery() {
  if (scheduled_pass !== null) return scheduled_pass;

  scheduled_pass = (async () => {
    await record_delivery("invoices", await deliver_now().catch(() => null));

    /* Read fresh each pass, so switching it off in Settings takes effect on
       the next minute rather than the next browser start. */
    const config = await settings();

    if (config.buildertrend_enabled !== false && config.bt_auto_estimates !== false)
      await record_delivery("estimates", await deliver_estimates_now().catch(() => null));
  })().finally(() => {
    scheduled_pass = null;
  });

  return scheduled_pass;
}

/**
 * On install and on every browser start.
 *
 * The badge is redrawn because it does not survive a restart while the queue
 * does, and a queue with three stuck rows and no badge is a queue nobody looks
 * at. trigger() picks up anything left mid-flight from the last session.
 */
async function wake() {
  await migrate_v1_queue();
  await migrate_bt_unrecorded();
  await refresh_badge();

  /* Created rather than checked for: chrome.alarms.create replaces an alarm of
     the same name, so re-arming on every wake is how the schedule survives an
     update that changed its period. */
  start_delivery_schedule();

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
