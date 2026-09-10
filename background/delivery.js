/**
 * Delivering approved work orders into AppFolio's vendor portal.
 *
 * The other direction from everything else in this extension. Elsewhere it
 * reads AppFolio and writes to the web app; here the web app hands out work and
 * the extension performs it, because it is the only part of the system with a
 * browser — and a browser is the only thing that can submit an AppFolio
 * invoice. There is no vendor-side API: ASH is the vendor, and AppFolio's Stack
 * API is for property-management customers.
 *
 * ## The web app owns every decision
 *
 * Nothing here knows what a markup is, and nothing in the web app knows a
 * selector. The queue hands over a job's line items already priced, plus the
 * total AppFolio *should* reach when it multiplies the quantities and rates back
 * out. This side navigates, types, checks that total, and reports. If it cannot
 * check, it does not submit.
 *
 * ## Why this drives the navigation
 *
 * Notes and invoices are separate routes — `/workOrders/{id}/notes` and
 * `/invoices` — so one delivery spans several page loads, and each load
 * re-injects the content script. An earlier version held a single promise
 * across the whole job, which that cannot survive.
 *
 * So this file owns the sequence and the state, and asks the page one small
 * idempotent question at a time. Each step is separately testable and a failure
 * between two of them is a clean boundary rather than a half-filled form.
 *
 * ## The three-step handshake, unchanged
 *
 * claim → submitting → result, and the middle one is why this file is careful
 * rather than short. Filling AppFolio's form changes nothing on AppFolio's
 * side; pressing Submit Invoice bills Camelot. So the server is told *before*
 * the click, and a browser that dies in between leaves a row saying "may
 * already have been billed" that waits for a person, rather than one that gets
 * retried into a second invoice. A run that dies merely holding a claim goes
 * straight back in the queue, because nothing was sent.
 *
 * ## Differences from the Buildertrend orchestration next door
 *
 * That one opens a focused tab on purpose, because it dims the page while it
 * works and a manager should see it happening. This runs in a **background**
 * tab and reuses one tab for the whole run: a queue of forty jobs that steals
 * focus forty times is unusable, and the manager is meant to be doing something
 * else while it drains.
 */

import { api, fetch_photo, NetworkError } from "./api.js";

const VENDOR_ORIGIN = "https://vendor.appfolio.com";
const VENDOR_HOME = `${VENDOR_ORIGIN}/`;

const DRAIN_ALARM = "nss-delivery-drain";

/** The shortest period chrome.alarms will honour. */
const DRAIN_PERIOD_MINUTES = 1;

const HANDSHAKE_MS = 30000;

/** How long any one page command may take. Generous: it covers photo uploads. */
const STEP_MS = 120000;

/** AppFolio's own limit on one note. */
const PHOTOS_PER_NOTE = 10;

/**
 * One run at a time.
 *
 * Not a nicety. Two overlapping runs would both poll and both claim, and —
 * because a claim is a conditional UPDATE server-side — one would lose every
 * race and spend the jobs' attempt counters doing it.
 */
let running = false;

/** The tab this run uses, so a queue of forty opens one tab and not forty. */
let delivery_tab_id = null;

export function start_delivery_schedule() {
  chrome.alarms.create(DRAIN_ALARM, { periodMinutes: DRAIN_PERIOD_MINUTES });
}

export function is_delivery_alarm(name) {
  return name === DRAIN_ALARM;
}

/**
 * Work the queue until it is empty.
 *
 * Returns a summary rather than throwing, for the reason api.js resolves rather
 * than throwing: every outcome here is information somebody may need to see,
 * and only an unreachable server is exceptional.
 */
export async function deliver_now({ manual = false } = {}) {
  if (running) return { ok: true, skipped: "already running" };

  running = true;

  const summary = { delivered: 0, failed: 0, unconfirmed: 0, blocked: 0, skipped: 0, paused: false };
  const reports = [];

  try {
    for (let pass = 0; pass < 20; pass++) {
      const response = await api.deliveries("appfolio");

      if (response.status === 401) return { ok: false, error: "signed_out", summary };
      if (response.status === 403) return { ok: false, error: "not_permitted", summary };
      if (!response.ok)
        return { ok: false, error: response.body?.error || "The queue could not be read.", summary };

      if (response.body?.paused === true) {
        summary.paused = true;
        summary.reason = response.body.reason || "";

        return { ok: true, summary };
      }

      const queue = Array.isArray(response.body?.deliveries) ? response.body.deliveries : [];
      if (queue.length === 0) return { ok: true, summary, reports };

      const options = {
        auto_submit: response.body?.auto_submit !== false,
        dry_run: response.body?.dry_run === true,
        on_over_limit: response.body?.on_over_limit === "send" ? "send" : "block",
      };

      summary.dry_run = options.dry_run;

      for (const delivery of queue) {
        const outcome = await deliver_one(delivery, options, reports);

        if (outcome === "delivered") summary.delivered += 1;
        else if (outcome === "unconfirmed") summary.unconfirmed += 1;
        else if (outcome === "blocked") summary.blocked += 1;
        else if (outcome === "skipped") summary.skipped += 1;
        else if (outcome === "rehearsed") summary.rehearsed = (summary.rehearsed || 0) + 1;
        else summary.failed += 1;

        /* A rehearsal puts the job straight back, so a second pass would pick
           the same one up and rehearse it forever. One pass is the whole run. */
        if (options.dry_run) return { ok: true, summary, reports: reports.slice(0, 10) };

        /* A signed-out portal fails every remaining job identically and would
           burn the whole queue's attempts doing it. */
        if (outcome === "signed_out") {
          summary.reason = "Nobody is signed in to the AppFolio vendor portal.";

          return { ok: false, error: "vendor_signed_out", summary };
        }
      }
    }

    return { ok: true, summary, reports };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof NetworkError ? error.message : error?.message || "Delivery stopped.",
      summary,
    };
  } finally {
    running = false;

    /* Left open on a manual run so a manager can see what happened; closed on a
       scheduled one so an unattended queue does not leave a tab behind every
       minute. */
    if (!manual) await close_delivery_tab();
  }
}

/**
 * One work order, as five steps over four or five page loads.
 *
 *   A  locate and inspect      the guards, before anything is written
 *   B  accept, if it needs it  only for a job the web app already approved
 *   C  photographs as notes    ten per note, each its own page load
 *   D  the invoice             fill, verify, ask permission, submit
 *   E  work done               so Camelot has a reason to look
 *
 * A rehearsal runs A and D only, and D writes nothing.
 */
async function deliver_one(delivery, options, reports) {
  const claim = await api.claim_delivery(delivery.id);

  /* 409 is the ordinary answer when two managers drain the same queue. Not an
     error, not worth reporting, not worth retrying. */
  if (claim.status === 409) return "skipped";
  if (claim.status === 401) return "signed_out";
  if (!claim.ok) return "failed";

  const finish = (state, error = "", extra = {}) => report(delivery, options, reports, state, error, extra);

  /* ---- A: find the job and read what should stop it -------------------- */

  const located = await locate(delivery);

  if (located.signed_out) return finish("failed", "The AppFolio vendor portal is signed out.", { signed_out: true });
  if (!located.ok) return finish("failed", located.error);

  const url = located.url;

  if (located.number !== "" && located.number !== delivery.number)
    return finish(
      "failed",
      `That page is work order ${located.number}, not ${delivery.number}. Nothing was touched.`,
    );

  /* Remembered for next time, so a job found by scanning the list is found
     directly afterwards. */
  if (!delivery.target_url && url) api.remember_vendor_url(delivery.number, url).catch(() => null);

  /* ---- B: accept, if nobody has ---------------------------------------- */

  if (located.needs_accepting && !options.dry_run) {
    const accepted = await command(url, "VENDOR_ACCEPT", {});

    if (accepted?.ok !== true)
      return finish("blocked", accepted?.error || "That work order has not been accepted yet.");
  }

  /* ---- C: the photographs ---------------------------------------------- */

  if (!options.dry_run) {
    const photos = Array.isArray(delivery.photos) ? delivery.photos : [];

    for (let index = 0; index < photos.length; index += PHOTOS_PER_NOTE) {
      const batch = photos.slice(index, index + PHOTOS_PER_NOTE);
      const total = Math.ceil(photos.length / PHOTOS_PER_NOTE);
      const which = Math.floor(index / PHOTOS_PER_NOTE) + 1;

      const message =
        total === 1
          ? "Photos of the completed work."
          : `Photos of the completed work (${which} of ${total}).`;

      /* Reloaded per batch rather than reusing the saved form, because what a
         React form does to itself after a successful save is its business and
         a fresh page is one less thing to be wrong about. */
      const posted = await command(`${url}/notes`, "VENDOR_POST_NOTE", { message, photos: batch });

      if (posted?.ok !== true) return finish("failed", posted?.error || "The photos could not be posted.");
    }
  }

  /* ---- D: the invoice --------------------------------------------------- */

  const invoice = await command(`${url}/invoices`, "VENDOR_SUBMIT_INVOICE", {
    delivery_id: delivery.id,
    items: delivery.invoice?.items || [],
    expected_total_cents: delivery.invoice?.expected_total_cents || 0,
    auto_submit: options.auto_submit,
    dry_run: options.dry_run,
    on_over_limit: options.on_over_limit,
  });

  if (invoice?.ok !== true) {
    /* Three different answers, and the distinction is the whole safety story.
       `blocked` is a refusal nothing should retry; `unconfirmed` means Submit
       was pressed and the outcome is unknown; anything else is a clean failure
       with nothing sent. */
    if (invoice?.blocked === true) return finish("blocked", invoice.error);
    if (invoice?.unconfirmed === true) return finish("unconfirmed", invoice.error);

    return finish("failed", invoice?.error || "The invoice could not be filled in.", {
      read_back: invoice?.read_back || "",
    });
  }

  if (options.dry_run)
    return finish("dry_run", "", { read_back: invoice.read_back || "", expected: invoice.expected || "" });

  /* ---- E: work done ---------------------------------------------------- */

  /* Deliberately not fatal. The money is the delivery, and a job left In
     Progress with a correct invoice on it is untidy — reporting it as failed
     would invite a retry, and the retry would submit the invoice again. */
  await command(url, "VENDOR_WORK_DONE", {}).catch(() => null);

  return finish("delivered", "", { external_ref: invoice.external_ref || "" });
}

/**
 * Step A: get to the job's own page.
 *
 * `target_url` when the app knows it. Otherwise the list, because **the
 * displayed number cannot be turned into a URL** — `#18779 - 2` lives at
 * `/workOrders/19369` and the two ids are unrelated. The list is the only place
 * that mapping exists.
 */
async function locate(delivery) {
  if (delivery.target_url) {
    const inspected = await command(delivery.target_url, "VENDOR_INSPECT", { number: delivery.number });

    if (inspected?.signed_out) return { signed_out: true };

    if (inspected?.ok === true)
      return {
        ok: true,
        url: inspected.url || delivery.target_url,
        number: inspected.number || "",
        needs_accepting: inspected.needs_accepting === true,
      };

    /* A stale URL is not a dead end — fall through to the list. */
  }

  const found = await command(VENDOR_HOME, "VENDOR_INSPECT", { number: delivery.number });

  if (found?.signed_out) return { signed_out: true };

  if (found?.ok !== true || !found.href)
    return {
      ok: false,
      error: found?.error || `Work order ${delivery.number} could not be found in the vendor portal.`,
    };

  const inspected = await command(found.href, "VENDOR_INSPECT", { number: delivery.number });

  if (inspected?.signed_out) return { signed_out: true };
  if (inspected?.ok !== true) return { ok: false, error: inspected?.error || "That work order would not open." };

  return {
    ok: true,
    url: inspected.url || found.href,
    number: inspected.number || "",
    needs_accepting: inspected.needs_accepting === true,
  };
}

/**
 * Navigate, then ask the page one thing.
 *
 * The handshake before each command is not ceremony: the content script runs at
 * document_idle, and a message sent before it is listening throws "receiving
 * end does not exist", which looks exactly like a signed-out page.
 */
async function command(url, type, payload) {
  const tab_id = await ensure_delivery_tab(url);

  if (tab_id === null) return { ok: false, error: "Could not open an AppFolio vendor portal tab." };

  await navigate(tab_id, url);

  const state = await ask_page_state(tab_id);

  if (state === "signed_out") return { ok: false, signed_out: true, error: "The vendor portal is signed out." };
  if (state !== "ready") return { ok: false, error: "The vendor portal page did not finish loading." };

  try {
    return await with_timeout(chrome.tabs.sendMessage(tab_id, { type, payload }), STEP_MS);
  } catch {
    return { ok: false, error: "The vendor portal tab stopped responding." };
  }
}

/**
 * Tell the server what happened, or put a rehearsal back.
 *
 * A rehearsal is released rather than reported: nothing happened to an invoice,
 * so there is no result to record — and recording one would spend the job's
 * attempt and eventually trip the circuit breaker on a system that works.
 */
async function report(delivery, options, reports, state, error, extra = {}) {
  if (state === "dry_run" || (options.dry_run && state !== "skipped")) {
    if (reports)
      reports.push({
        number: delivery.number,
        ok: state === "dry_run",
        error,
        expected: extra.expected || delivery.invoice?.expected_total || "",
        read_back: extra.read_back || "",
      });

    await api.release_delivery(delivery.id).catch(() => null);

    return state === "dry_run" ? "rehearsed" : "failed";
  }

  await api
    .delivery_result(delivery.id, {
      state,
      error,
      external_ref: extra.external_ref || "",
      payload_hash: delivery.payload_hash,
    })
    .catch(() => null);

  return extra.signed_out === true ? "signed_out" : state;
}

/**
 * Messages from the vendor page.
 *
 * DELIVERY_ABOUT_TO_SUBMIT is the page asking permission to click Submit. The
 * worker records that server-side and only then answers, so if the answer is no
 * — or never arrives — the page must not submit. The page honours that; this is
 * the half that makes it mean something.
 *
 * DELIVERY_PHOTO is the page asking for bytes, which it cannot fetch itself: a
 * content script's fetch on vendor.appfolio.com is the *page's* request and
 * would meet CORS, the same reason every other call here lives in the worker.
 */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "DELIVERY_ABOUT_TO_SUBMIT") {
    api
      .submitting_delivery(message.payload?.delivery_id)
      .then((response) => respond({ ok: response.ok, status: response.status }))
      .catch((error) => respond({ ok: false, error: error?.message || "" }));

    return true;
  }

  if (message?.type === "DELIVERY_PHOTO") {
    fetch_photo(message.payload?.id)
      .then((photo) => respond(photo))
      .catch((error) => respond({ ok: false, error: error?.message || "" }));

    return true;
  }

  /* A person opening a vendor work order from their email is the only moment
     the app can learn that page's address, so it is remembered whenever seen.
     Nothing depends on it; it only saves a trip through the list. */
  if (message?.type === "VENDOR_PAGE_SEEN") {
    api
      .remember_vendor_url(message.payload?.number, message.payload?.url)
      .then((response) => respond({ ok: response.ok }))
      .catch(() => respond({ ok: false }));

    return true;
  }

  return false;
});

async function ensure_delivery_tab(url) {
  if (delivery_tab_id !== null) {
    const existing = await chrome.tabs.get(delivery_tab_id).catch(() => null);
    if (existing?.id) return existing.id;

    delivery_tab_id = null;
  }

  /* Not focused. See the note at the top: forty jobs stealing focus forty times
     is worse than no automation at all. */
  const tab = await chrome.tabs.create({ url, active: false }).catch(() => null);
  if (!tab?.id) return null;

  delivery_tab_id = tab.id;
  await wait_for_load(tab.id);

  return tab.id;
}

async function close_delivery_tab() {
  if (delivery_tab_id === null) return;

  const id = delivery_tab_id;
  delivery_tab_id = null;

  await chrome.tabs.remove(id).catch(() => null);
}

/**
 * Go to a URL, unless already there.
 *
 * Compared without the hash and with a trailing slash normalised, because this
 * is called with the same URL twice in a row (step E returns to the page step A
 * inspected) and a needless reload is a needless five seconds per job.
 */
async function navigate(tab_id, url) {
  const current = await chrome.tabs.get(tab_id).catch(() => null);

  if (current?.url && same_page(current.url, url)) return;

  await chrome.tabs.update(tab_id, { url }).catch(() => null);
  await wait_for_load(tab_id);
}

function same_page(a, b) {
  const strip = (value) => String(value).split("#")[0].replace(/\/+$/, "");

  return strip(a) === strip(b);
}

/**
 * Ask the page what state it is in, retrying only for a missing listener.
 *
 * The same shape as the Buildertrend handshake and for the same reason: the
 * content script runs at document_idle, usually in place by the time the tab
 * reports complete, and the failure when it is not looks exactly like a
 * signed-out page. A couple of retries tells the two apart.
 */
async function ask_page_state(tab_id, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await with_timeout(
        chrome.tabs.sendMessage(tab_id, { type: "VENDOR_PAGE_STATUS" }),
        HANDSHAKE_MS,
      );

      return response?.state || "unconfirmed";
    } catch {
      if (attempt === attempts - 1) return "unconfirmed";

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return "unconfirmed";
}

function with_timeout(promise, timeout) {
  let timer = null;

  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out.")), timeout);
    }),
  ]);
}

/**
 * Wait for the tab to finish loading, unless it already has.
 *
 * The check first is not an optimisation: the listener is armed after
 * tabs.create resolves, so a tab that loaded in between would never see a
 * `complete` event and this would sit out its whole timeout before carrying on
 * to succeed anyway.
 */
async function wait_for_load(tab_id, timeout = HANDSHAKE_MS) {
  const current = await chrome.tabs.get(tab_id).catch(() => null);
  if (current?.status === "complete") return;

  return new Promise((resolve) => {
    const settle = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (updated_tab_id, info) => {
      if (updated_tab_id === tab_id && info.status === "complete") settle();
    };

    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(settle, timeout);
  });
}

export { VENDOR_ORIGIN, VENDOR_HOME };
