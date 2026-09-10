/**
 * Delivering approved work orders into AppFolio's vendor portal.
 *
 * This is the other direction from everything else in the extension. Until now
 * the extension read AppFolio and wrote to the web app; here the web app hands
 * out work and the extension performs it, because it is the only part of the
 * system with a browser — and a browser is the only thing that can submit an
 * AppFolio invoice. There is no vendor-side API. ASH is the vendor, and
 * AppFolio's Stack API is for property-management customers.
 *
 * ## The web app owns every decision
 *
 * Nothing here knows what a markup is, and nothing in the web app knows a
 * selector. The queue hands over a work order's line items already priced, plus
 * the total AppFolio *should* arrive at when it multiplies the quantities and
 * rates back out. This side types, checks that total, and reports. If it cannot
 * check, it does not submit.
 *
 * ## Why the three-step handshake exists
 *
 * claim → submitting → result, and the middle one is the whole reason this file
 * is careful rather than short.
 *
 * Filling AppFolio's form changes nothing on AppFolio's side. Pressing Save
 * Invoice bills Camelot. So the server is told *before* the click, and a
 * browser that dies in between leaves a row that says "may already have been
 * billed" and waits for a person, rather than one that gets retried into a
 * second invoice. A run that dies while merely holding a claim is put straight
 * back in the queue, because nothing was sent.
 *
 * This is why `submitting` is a separate request and not a field on the result.
 * A flag reported afterwards is no use: the case it exists for is the case
 * where nothing is reported afterwards.
 *
 * ## Differences from the Buildertrend orchestration next door
 *
 * That one opens a focused tab, on purpose, because it dims the page while it
 * works and a manager should see it happening. This one runs in a **background**
 * tab and reuses a single tab for the whole run: a queue of forty jobs that
 * steals focus forty times is unusable, and the manager is meant to be doing
 * something else while it drains.
 */

import { api, fetch_photo, NetworkError } from "./api.js";

const VENDOR_ORIGIN = "https://vendor.appfolio.com";
const VENDOR_HOME = `${VENDOR_ORIGIN}/`;

const DRAIN_ALARM = "nss-delivery-drain";

/** The shortest period chrome.alarms will honour. */
const DRAIN_PERIOD_MINUTES = 1;

const HANDSHAKE_MS = 30000;

/**
 * How long one job may take before the run gives up on it.
 *
 * Generous, because it covers up to ten photograph uploads on somebody's
 * office connection. The server's own lease is what actually protects the
 * queue; this only stops one stuck job from holding the run forever.
 */
const JOB_MS = 240000;

/**
 * One run at a time.
 *
 * Not a nicety. Two overlapping runs would both poll, both claim, and — because
 * a claim is a conditional UPDATE server-side — one would lose every race and
 * spend the jobs' attempt counters doing it.
 */
let running = false;

/** The tab this run is using, so a queue of forty opens one tab and not forty. */
let delivery_tab_id = null;

export function start_delivery_schedule() {
  chrome.alarms.create(DRAIN_ALARM, { periodMinutes: DRAIN_PERIOD_MINUTES });
}

export function is_delivery_alarm(name) {
  return name === DRAIN_ALARM;
}

/**
 * Work the queue until it is empty, then stop.
 *
 * Returns a summary rather than throwing, for the reason api.js resolves
 * instead of throwing: every outcome here is information somebody may need to
 * see, and only an unreachable server is exceptional.
 */
export async function deliver_now({ manual = false } = {}) {
  if (running) return { ok: true, skipped: "already running" };

  running = true;

  const summary = { delivered: 0, failed: 0, unconfirmed: 0, skipped: 0, paused: false };

  /* What a rehearsal saw, kept so the popup can show it. Only ever populated on
     a dry run: on a real run the outcome is the delivery, and anything worth
     saying about a failure is already on the web app's own screen. */
  const reports = [];

  try {
    /* Passes, not jobs. Each pass asks for a page of the queue; the loop ends
       when a pass comes back empty, so a queue that grows while we work is
       drained in the same run rather than waiting for the next alarm. */
    for (let pass = 0; pass < 20; pass++) {
      const response = await api.deliveries("appfolio");

      if (response.status === 401) return { ok: false, error: "signed_out", summary };
      if (response.status === 403) return { ok: false, error: "not_permitted", summary };
      if (!response.ok) return { ok: false, error: response.body?.error || "The queue could not be read.", summary };

      if (response.body?.paused === true) {
        summary.paused = true;
        summary.reason = response.body.reason || "";

        return { ok: true, summary };
      }

      const queue = Array.isArray(response.body?.deliveries) ? response.body.deliveries : [];
      if (queue.length === 0) return { ok: true, summary, reports };

      const auto_submit = response.body?.auto_submit !== false;
      const dry_run = response.body?.dry_run === true;

      summary.dry_run = dry_run;

      for (const delivery of queue) {
        const outcome = await deliver_one(delivery, auto_submit, dry_run, reports);

        if (outcome === "delivered") summary.delivered += 1;
        else if (outcome === "unconfirmed") summary.unconfirmed += 1;
        else if (outcome === "skipped") summary.skipped += 1;
        else if (outcome === "rehearsed") summary.rehearsed = (summary.rehearsed || 0) + 1;
        else summary.failed += 1;

        /* A rehearsal puts the job straight back, so a second pass would pick
           the same one up and rehearse it forever. One pass is the whole run. */
        if (dry_run) return { ok: true, summary, reports: reports.slice(0, 10) };

        /* A signed-out portal fails every remaining job identically and would
           burn the whole queue's attempt counters doing it. Stop, and let the
           person sign in. */
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
      error: error instanceof NetworkError ? error.message : (error?.message || "Delivery stopped."),
      summary,
    };
  } finally {
    running = false;

    /* The tab is left open on a manual run so a manager can see what happened,
       and closed on a scheduled one so an unattended queue does not leave a
       tab behind every minute. */
    if (!manual) await close_delivery_tab();
  }
}

/**
 * One work order, start to finish.
 *
 * Every exit reports something to the server, except the one where the claim
 * was lost — which needs no report, because whoever won it will report instead.
 */
async function deliver_one(delivery, auto_submit, dry_run = false, reports = null) {
  const claim = await api.claim_delivery(delivery.id);

  /* 409 is the ordinary answer when two managers are draining the same queue.
     Not an error, not worth reporting, and not worth a retry. */
  if (claim.status === 409) return "skipped";
  if (claim.status === 401) return "signed_out";
  if (!claim.ok) return "failed";

  const tab_id = await ensure_delivery_tab(delivery.target_url || VENDOR_HOME);

  if (tab_id === null) {
    await report(delivery, {
      state: "failed",
      error: "Could not open an AppFolio vendor portal tab.",
    });

    return "failed";
  }

  if (delivery.target_url) await navigate(tab_id, delivery.target_url);

  const state = await ask_page_state(tab_id);

  if (state === "signed_out") {
    /* Deliberately `failed` rather than `unconfirmed`: nothing was typed, let
       alone submitted, so a retry after somebody signs in is safe. */
    await report(delivery, {
      state: "failed",
      error: "The AppFolio vendor portal is signed out. Sign in and it will be tried again.",
    });

    return "signed_out";
  }

  if (state !== "ready") {
    await report(delivery, {
      state: "failed",
      error: "The vendor portal page did not finish loading.",
    });

    return "failed";
  }

  let result;

  try {
    result = await with_timeout(
      chrome.tabs.sendMessage(tab_id, {
        type: "DELIVER_WORK_ORDER",

        /* Only what that page needs. It runs on vendor.appfolio.com, and the
           web app's address and our token are no business of a third party's
           page — every call back to the web app goes through this worker. */
        payload: {
          delivery_id: delivery.id,
          number: delivery.number,
          invoice: delivery.invoice,
          photos: delivery.photos,
          payload_hash: delivery.payload_hash,
          auto_submit,
          dry_run,
        },
      }),
      JOB_MS,
    );
  } catch {
    /* A rehearsal never pressed Save, so a tab that dies during one is put back
       rather than becoming a question about an invoice that does not exist. */
    if (dry_run) {
      await api.release_delivery(delivery.id).catch(() => null);

      if (reports !== null)
        reports.push({
          number: delivery.number,
          ok: false,
          error: "The vendor portal tab stopped responding part way through.",
        });

      return "failed";
    }

    /* On a real run the page stopping is genuinely ambiguous. Which state it is
       depends on whether it had already told us it was about to submit — and it
       is the server that knows, because that is what the submitting call
       recorded. So report the honest answer and let the server refuse it if the
       row has moved on. */
    await report(delivery, {
      state: "unconfirmed",
      error: "The vendor portal tab stopped responding part way through.",
    });

    return "unconfirmed";
  }

  /* A rehearsal is put back rather than reported. Nothing happened to an
     invoice, so there is no result to record — and recording one would spend
     the job's attempt and eventually trip the circuit breaker on a system that
     is working perfectly. */
  if (dry_run) {
    if (reports !== null)
      reports.push({
        number: delivery.number,
        ok: result?.state === "dry_run",
        error: result?.error || "",
        found: result?.found || null,
        expected: delivery.invoice?.expected_total || "",
        read_back: result?.read_back || "",
      });

    await api.release_delivery(delivery.id).catch(() => null);

    return result?.state === "dry_run" ? "rehearsed" : "failed";
  }

  const reported = {
    state: result?.state === "delivered" || result?.state === "unconfirmed" ? result.state : "failed",
    error: result?.error || "",
    external_ref: result?.external_ref || "",
  };

  await report(delivery, reported);

  return reported.state;
}

async function report(delivery, result) {
  await api
    .delivery_result(delivery.id, { ...result, payload_hash: delivery.payload_hash })
    .catch(() => null);
}

/**
 * Messages from the vendor page.
 *
 * Two of them, and the first is the one that matters.
 *
 * DELIVERY_ABOUT_TO_SUBMIT is the page asking permission to click Save. The
 * worker records that server-side and only then answers — so if the answer is
 * no, or never arrives, the page must not submit. The page honours that; this
 * is the half that makes it meaningful.
 *
 * DELIVERY_PHOTO is the page asking for bytes. It cannot fetch them itself: a
 * content script's fetch on vendor.appfolio.com is the *page's* request and
 * would meet CORS, which is the same reason every other call in this extension
 * lives in the worker.
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

  /* A manager opening a vendor work order from her email is the only moment
     the app can learn that page's address, so it is remembered whenever it is
     seen. Nothing depends on it; it only makes delivery quicker. */
  if (message?.type === "VENDOR_PAGE_SEEN") {
    api
      .remember_vendor_url(message.payload?.number, message.payload?.url)
      .then((response) => respond({ ok: response.ok }))
      .catch(() => respond({ ok: false }));

    return true;
  }

  return false;
});

/** The run's one tab, created on first use. */
async function ensure_delivery_tab(url) {
  if (delivery_tab_id !== null) {
    const existing = await chrome.tabs.get(delivery_tab_id).catch(() => null);
    if (existing?.id) return existing.id;

    delivery_tab_id = null;
  }

  /* Not focused. See the note at the top of the file: forty jobs stealing
     focus forty times is worse than no automation at all. */
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

async function navigate(tab_id, url) {
  const current = await chrome.tabs.get(tab_id).catch(() => null);
  if (current?.url === url) return;

  await chrome.tabs.update(tab_id, { url }).catch(() => null);
  await wait_for_load(tab_id);
}

/**
 * Ask the page what state it is in, retrying only for a missing listener.
 *
 * The same shape as the Buildertrend handshake and for the same reason: the
 * content script runs at document_idle, which is usually in place by the time
 * the tab reports complete, and the failure when it is not looks exactly like a
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
