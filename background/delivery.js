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
 * ## A background tab, reused
 *
 * This runs in a **background** tab and reuses one tab for the whole run: a
 * queue of forty jobs that steals focus forty times is unusable, and the
 * manager is meant to be doing something else while it drains. The estimate
 * writer in background/estimates.js works the same way and runs on the same
 * alarm, straight after this — see scheduled_delivery() in service_worker.js.
 * (The Buildertrend *job* filler in buildertrend.js is the one that still
 * brings its tab forward.)
 *
 * ## The tab is locked, and closed when anything goes wrong
 *
 * It is opened through background/owned_tabs.js, which locks it against a
 * person's clicks and keystrokes for as long as the run holds it. A job that
 * fails records a report — see background/tab_errors.js — and closes the tab,
 * and the next job opens a clean one. Closing is the one interruption a page
 * cannot prevent, so a tab a person closes stops the run rather than being
 * quietly replaced.
 *
 * Two tabs are handed over instead of closed, because a person has to use
 * them: a sign-in page, and a filled invoice waiting for Submit Invoice.
 */

import { api, fetch_photo, is_outdated, NetworkError } from "./api.js";
import { notify, outdated_reason, warn_outdated } from "./notify.js";
import { check_signed_in, remember_sign_in_tab, show_sign_in, waiting_sign_in_tab } from "./portals.js";
import { scope_admits } from "./scope.js";
import {
  closed_by_person,
  close_owned_tab,
  hand_over,
  lock,
  open_owned_tab,
} from "./owned_tabs.js";

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

/** Set when a person closed the run's tab, which stops the run. */
let tab_closed = false;

const TAB_CLOSED = "The vendor portal tab was closed while a delivery was running, so the run stopped.";

/** What the tab's overlay says, and what a report names as the step. */
let current_label = "Delivering invoices";
let current_step = "";

/** Whether somebody pressed the button, for the report. */
let run_kind = "scheduled";

/**
 * Set when a run filled an invoice that a person still has to submit.
 *
 * Module state because the thing that reads it is the `finally` in
 * deliver_now(), which runs on the error path too — a run that threw after
 * filling has left exactly the same page behind.
 */
let awaiting_submit = false;

/**
 * Photographs a run offered that the vendor page did not take.
 *
 * Module state for the reason the counts are collected at all: report() is the
 * only place holding a job's `extra`, and it hands back a single outcome
 * string, so there is nowhere in that return value to put a number. Summed
 * across the run and folded into the summary as each job finishes.
 *
 * Only ever a *partial* shortfall reaches here — a note that could attach none
 * of its photographs is refused outright by post_note() and never becomes a
 * delivery at all.
 */
let photos_missing = 0;

/**
 * The web app's refusal of this build, once one has been seen this run.
 *
 * Module state because the refusal that matters most arrives through the
 * page: DELIVERY_ABOUT_TO_SUBMIT is answered by the listener at the bottom of
 * this file, and the invoice page only hands back a sentence. Remembering the
 * body here is how deliver_one tells "refused because this build is stale"
 * — release the job, stop the run — from an ordinary failure that spends an
 * attempt.
 */
let outdated = null;

/**
 * Where the unsubmitted invoice is, across service-worker restarts.
 *
 * `chrome.storage.session` rather than module state, because the worker is
 * evicted after about thirty seconds idle and the next alarm would then drain
 * straight over the top of a page somebody was about to press Submit on. Not
 * `storage.local`, because this is true of a browsing session and not of an
 * installation: a browser restart takes the tab with it, and a remembered URL
 * with no tab behind it would stop the queue forever.
 */
const AWAITING_KEY = "nss_awaiting_submit_url";

async function remember_awaiting(url, tab_id) {
  try {
    await chrome.storage.session.set({ [AWAITING_KEY]: { url, tab_id } });
  } catch {
    /* Storage is a convenience here; the in-run break below is what actually
       stops a second invoice being filled over the first. */
  }
}

async function clear_awaiting() {
  try {
    await chrome.storage.session.remove(AWAITING_KEY);
  } catch {}
}

/**
 * Is an invoice still sitting on screen waiting to be submitted?
 *
 * Answered by looking for the tab rather than by trusting the record, so the
 * queue restarts on its own the moment somebody submits and navigates, or
 * simply closes the tab. A remembered URL with nothing open behind it is
 * cleared and ignored — the alternative is a queue that never moves again
 * because of a page nobody can see.
 */
async function invoice_is_waiting() {
  let waiting;

  try {
    ({ [AWAITING_KEY]: waiting } = await chrome.storage.session.get(AWAITING_KEY));
  } catch {
    return null;
  }

  if (!waiting?.url) return null;

  /* The tab it was left in, not any tab at that address. A manager who opens
     the same invoice page herself has not got an invoice waiting in it. */
  const tab = Number.isInteger(waiting.tab_id)
    ? await chrome.tabs.get(waiting.tab_id).catch(() => null)
    : null;

  if (tab?.url && same_page(tab.url, waiting.url)) return waiting.url;

  await clear_awaiting();

  return null;
}

export function start_delivery_schedule() {
  chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: DRAIN_PERIOD_MINUTES });
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

  /* One invoice at a time, because one person presses Submit at a time.
   *
   * With auto_submit off, a run fills the form and stops for somebody to press
   * Submit Invoice. Draining the next job navigates the same tab and destroys
   * that fill — which is what happened the first time two jobs were queued in
   * this mode: the first was filled, checked to the cent, and then thrown away
   * when the second took the tab. Only the last survived, and the next
   * scheduled run would have taken that one too.
   *
   * So while an unsubmitted invoice is on screen, this does nothing. The tab's
   * existence is the lock, which means it lifts by itself the moment she
   * submits and navigates, or closes the tab. */
  const waiting = await invoice_is_waiting();

  if (waiting !== null)
    return {
      ok: true,
      skipped: "awaiting_submit",
      summary: {
        awaiting_submit: true,
        reason:
          "An invoice is filled in and waiting to be submitted. Press Submit Invoice on that tab, "
          + "then mark the job as delivered on /deliveries.",
      },
    };

  running = true;
  tab_closed = false;
  run_kind = manual ? "manual" : "scheduled";
  current_label = "Delivering invoices";
  current_step = "";

  const summary = {
    delivered: 0,
    failed: 0,
    unconfirmed: 0,
    blocked: 0,
    skipped: 0,

    /* Delivered, but Work Done did not land — so the invoice is in and the job
       is still sitting on In Progress in AppFolio. Counted alongside
       `delivered` rather than instead of it, because it is not a money problem
       and must not read like one. */
    left_open: 0,

    /* Photographs offered that the page did not take, across the run. Counted
       beside `delivered` for the same reason `left_open` is: not a money
       problem, and it must not read like one. */
    photos_missing: 0,
    paused: false,
  };
  const reports = [];

  /* Set by the first pass that has work, so the sign-in check runs once. */
  let preflighted = false;

  awaiting_submit = false;
  photos_missing = 0;
  outdated = null;

  /* A build the web app will not let work, said once and in a sentence. */
  const refuse_outdated = async (body) => {
    await warn_outdated(body);
    summary.reason = outdated_reason(body);

    return { ok: false, error: "extension_outdated", summary };
  };

  try {
    for (let pass = 0; pass < 20; pass++) {
      const response = await api.deliveries("appfolio");

      /* Before anything else, including the sign-in check: that opens a tab,
         and a build that may not deliver has no business opening one. */
      if (is_outdated(response)) return await refuse_outdated(response.body);
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

      /* No scope, no run — before the first claim, so nothing spends an attempt
         finding out.
         
         Every other option on this response has a safe default to fall back on;
         this one does not, because it does not say *how* to write, it says
         *what may be written to*. A run that guessed would be guessing between
         a test work order and a real client's invoice, and the server sends it
         on every branch of this answer precisely so that a missing one means
         something is wrong rather than something is old. */
      const scope = response.body?.scope || null;

      if (scope?.mode !== "sample" && scope?.mode !== "live") {
        summary.reason =
          "The web app did not say which work orders it may deliver, so nothing was sent.";

        return { ok: false, error: "scope_unknown", summary };
      }

      const options = {
        auto_submit: response.body?.auto_submit !== false,
        dry_run: response.body?.dry_run === true,
        on_over_limit: response.body?.on_over_limit === "send" ? "send" : "block",
        scope,
      };

      summary.dry_run = options.dry_run;
      summary.scope = scope.mode;

      /* The guard, and the reason it sits exactly here.
       *
       * Above this line nothing has been claimed; below it, deliver_one's very
       * first act is a claim, which increments `attempts` server-side. The
       * check used to happen after that claim, inside locate(), so a signed-out
       * portal cost one job an attempt and a `failed` result — a row on
       * /deliveries, which is meant to be empty on a good day, and a tick
       * toward a circuit breaker counting something that was never a delivery
       * problem.
       *
       * It costs no extra page load. The tab it opens is the one tab this run
       * reuses for every job, pointed at the page step A was going to open
       * anyway, so locate()'s own navigate() finds it already there.
       *
       * Runs once per run, not once per pass: a second pass means the first one
       * delivered something, which is proof enough of a session. */
      if (!preflighted) {
        preflighted = true;

        /* A timed run that already left a sign-in tab open waits for it. This
           runs every minute, and each run used to open and focus a fresh
           sign-in tab of its own — see waiting_sign_in_tab() in portals.js. */
        if (run_kind === "scheduled" && await waiting_sign_in_tab("appfolio") !== null) {
          summary.reason = "Nobody is signed in to the AppFolio vendor portal.";

          return { ok: false, error: "vendor_signed_out", summary };
        }

        const portal = await preflight_vendor(queue[0]);

        if (portal.state === "signed_out") {
          summary.reason = portal.detail;

          return { ok: false, error: "vendor_signed_out", summary };
        }

        if (tab_closed) return { ok: false, error: TAB_CLOSED, summary };

        /* `unknown` proceeds. It is the answer for a slow page as well as an
           unrecognised one, and refusing to drain on it would let one sluggish
           load stop the day's billing. deliver_one still has every guard it
           had before this function existed. */
      }

      for (const delivery of queue) {
        const outcome = await deliver_one(delivery, options, reports);

        if (outcome === "delivered") summary.delivered += 1;
        else if (outcome === "delivered_open") {
          summary.delivered += 1;
          summary.left_open += 1;
        } else if (outcome === "unconfirmed") summary.unconfirmed += 1;
        else if (outcome === "blocked") summary.blocked += 1;
        else if (outcome === "skipped") summary.skipped += 1;
        else if (outcome === "rehearsed") summary.rehearsed = (summary.rehearsed || 0) + 1;
        /* Neither is a failure or counted as one. A released portal sign-out
           left the row untouched with its attempt refunded; an expired device
           token never got as far as claiming. Tallying either would report a
           failure against a job still sitting in the queue. `outdated` is the
           same: the job was released, or never claimed. */
        else if (outcome !== "signed_out" && outcome !== "app_signed_out" && outcome !== "outdated")
          summary.failed += 1;

        /* Assigned per job rather than once at the end, because deliver_now has
           seven return points and every one of them hands back this summary. */
        summary.photos_missing = photos_missing;

        /* Before the rehearsal's early return, so a rehearsal whose tab was
           closed says so rather than reporting a failed job and nothing else. */
        if (tab_closed) {
          summary.reason = TAB_CLOSED;

          return { ok: false, error: TAB_CLOSED, summary };
        }

        /* The version moved under a running build. Every job after this one
           would be refused identically, so the run stops here. Before the
           rehearsal's early return for the same reason the tab check is. */
        if (outcome === "outdated") return await refuse_outdated(outdated);

        /* A rehearsal puts the job straight back, so a second pass would pick
           the same one up and rehearse it forever. One pass is the whole run. */
        if (options.dry_run) return { ok: true, summary, reports: reports.slice(0, 10) };

        /* Filled and waiting for a person: stop here rather than filling the
           next one over the top of it. See the note in deliver_now above. */
        if (awaiting_submit) {
          summary.awaiting_submit = true;
          summary.reason =
            "Filled one invoice and stopped. Press Submit Invoice on the tab left open, then mark "
            + "the job as delivered.";

          return { ok: true, summary };
        }

        /* A signed-out portal fails every remaining job identically and would
           burn the whole queue's attempts doing it. */
        if (outcome === "signed_out") {
          summary.reason = "Nobody is signed in to the AppFolio vendor portal.";

          return { ok: false, error: "vendor_signed_out", summary };
        }

        /* Same shape, different service. Reported with the code the popup
           already uses for an expired device token. */
        if (outcome === "app_signed_out") {
          summary.reason = "This device is no longer signed in to the web app.";

          return { ok: false, error: "signed_out", summary };
        }
      }
    }

    return { ok: true, summary, reports };
  } catch (error) {
    const message = error instanceof NetworkError ? error.message : error?.message || "Delivery stopped.";

    await close_delivery_tab({ state: "failed", step: current_step, error: message });

    return { ok: false, error: message, summary };
  } finally {
    running = false;

    /* Closed at the end of every run, manual or scheduled. A tab somebody has
       to use — a sign-in page, or a filled invoice waiting for Submit Invoice —
       was handed over where that was decided, which also forgot it, so this
       leaves it alone. A job that failed closed its own tab when it reported.

       The job with an invoice waiting is reported `blocked`, and `blocked` is
       not claimable, so the next scheduled run does not pick it up and fill it
       over the top of her. */
    await close_delivery_tab();
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
  /* This device's own token, not the portal's session — a different problem
     with a different fix, and it must not send her to AppFolio to solve
     something that lives in this extension's settings. */
  if (claim.status === 401) return "app_signed_out";

  if (is_outdated(claim)) {
    outdated = claim.body;

    return "outdated";
  }

  if (!claim.ok) return "failed";

  const finish = (state, error = "", extra = {}) => report(delivery, options, reports, state, error, extra);

  /* Before each step that writes, ask whether this device still holds the job.
   *
   * `null` means carry on. Anything else is the outcome to return, and none of
   * them reports a result: a job another device now holds is theirs to report,
   * and a build refused mid-run puts its job back rather than spending an
   * attempt on a refusal that had nothing to do with the job.
   *
   * Only ever called before `submitting`. After Submit has been pressed the
   * result has to be reported whatever happened to the lease, so step E does
   * not ask. */
  const still_held = async () => {
    const touched = await api.touch_delivery(delivery.id);

    if (touched.ok) return null;
    if (touched.status === 409) return "skipped";
    if (touched.status === 401) return "app_signed_out";

    if (is_outdated(touched)) {
      outdated = touched.body;
      await api.release_delivery(delivery.id).catch(() => null);

      return "outdated";
    }

    /* Anything else is the web app misbehaving, not the job — carry on, and let
       the lease decide as it always has. */
    return null;
  };

  current_label = `Delivering work order ${delivery.number}`;
  current_step = "A: locate";
  lock(delivery_tab_id, current_label);

  /* ---- A: find the job and read what should stop it -------------------- */

  const located = await locate(delivery);

  /* A session that lapsed between the preflight and this job.
   *
   * Released rather than reported, for the reason a rehearsal is: step A writes
   * nothing to AppFolio, so nothing happened to an invoice and there is no
   * result to record. `release` puts the row back as `pending` and refunds the
   * attempt; `failed` would leave a row on /deliveries about a delivery that
   * was never attempted and feed a circuit breaker counting something that is
   * not a delivery problem.
   *
   * Correct *only* here. The endpoint refuses anything past `claimed` by
   * design, and nothing downstream of step D's `submitting` may ever be quietly
   * returned to the queue — Save has been pressed by then. */
  if (located.signed_out) {
    await api.release_delivery(delivery.id).catch(() => null);
    await hand_over_delivery_tab();

    return "signed_out";
  }

  if (!located.ok) return finish("failed", located.error);

  const url = located.url;

  if (located.number !== "" && located.number !== delivery.number)
    return finish(
      "failed",
      `That page is work order ${located.number}, not ${delivery.number}. Nothing was touched.`,
    );

  /* Remembered for next time, so a job found by scanning the list is found
     directly afterwards. Worth keeping even for a job about to be refused: the
     URL is correct whatever the portal thinks of the job's state. */
  if (!delivery.target_url && url) api.remember_vendor_url(delivery.number, url).catch(() => null);

  /* ---- does the page agree this is the population we may bill? --------- */

  const wrong_population = scope_refusal(located.description, options.scope);

  if (wrong_population !== null) return finish("blocked", wrong_population);

  /* ---- the portal's own verdict ---------------------------------------- */

  /* Deliberately here: after the URL is banked and before step B clicks
     anything. Every path through this function passes this point, because
     locate() is the only way to get `url` and `url` is the only thing steps B
     through E act on. */
  const refusal = portal_refusal(delivery, located);

  if (refusal !== null) return finish("blocked", refusal);

  /* ---- B: accept, if nobody has ---------------------------------------- */

  /* Finding the job can take a list scan and several page loads, so this is
     the first point the lease may have lapsed — and everything from here on
     writes to AppFolio. */
  const before_accept = await still_held();
  if (before_accept !== null) return before_accept;

  if (located.needs_accepting && !options.dry_run) {
    current_step = "B: accept";

    const accepted = await command(url, "VENDOR_ACCEPT", {});

    if (accepted?.ok !== true)
      return finish("failed", accepted?.error || "That work order could not be accepted.");
  }

  /* ---- C: the photographs ---------------------------------------------- */

  /* What the pages actually took, against what was offered. A note can succeed
     having dropped a photograph that would not download — post_note() only
     refuses when *none* of them arrived — and that shortfall is not a money
     problem but is still something a person should be told, so it rides back
     the way work_done does rather than being discarded here. */
  let photos_offered = 0;
  let photos_attached = 0;

  if (!options.dry_run) {
    current_step = "C: photos";

    const photos = Array.isArray(delivery.photos) ? delivery.photos : [];

    for (let index = 0; index < photos.length; index += PHOTOS_PER_NOTE) {
      const batch = photos.slice(index, index + PHOTOS_PER_NOTE);
      const total = Math.ceil(photos.length / PHOTOS_PER_NOTE);
      const which = Math.floor(index / PHOTOS_PER_NOTE) + 1;

      const message =
        total === 1
          ? "Photos of the completed work."
          : `Photos of the completed work (${which} of ${total}).`;

      /* Per batch, because this is the step that made jobs outlast the lease
         and the step whose duplicates land on the client's work order. */
      const before_note = await still_held();
      if (before_note !== null) return before_note;

      /* Reloaded per batch rather than reusing the saved form, because what a
         React form does to itself after a successful save is its business and
         a fresh page is one less thing to be wrong about. */
      const posted = await command(`${url}/notes`, "VENDOR_POST_NOTE", { message, photos: batch });

      if (posted?.ok !== true) return finish("failed", posted?.error || "The photos could not be posted.");

      photos_offered += Number(posted.photos_offered ?? batch.length) || 0;
      photos_attached += Number(posted.photos_attached ?? 0) || 0;
    }
  }

  /* ---- D: the invoice --------------------------------------------------- */

  current_step = "D: invoice";

  const before_invoice = await still_held();
  if (before_invoice !== null) return before_invoice;

  const invoice = await command(`${url}/invoices`, "VENDOR_SUBMIT_INVOICE", {
    delivery_id: delivery.id,
    items: delivery.invoice?.items || [],
    expected_total_cents: delivery.invoice?.expected_total_cents || 0,
    auto_submit: options.auto_submit,
    dry_run: options.dry_run,
    on_over_limit: options.on_over_limit,

    /* Checked at step A too, on the work order's own page. Repeated here
       because this is the page the invoice is actually typed into, and between
       the two the run has posted notes and reloaded twice — the guard that
       matters is the one on the page being written to, not the one two
       navigations ago. */
    scope: options.scope,
  });

  if (invoice?.ok !== true) {
    /* The page asked to submit and the web app refused this build. Nothing was
       submitted — the page only presses Submit on a yes — and the row is still
       `claimed`, so it goes back untouched rather than being reported as a
       failure that spends an attempt. Checked first, because the page's own
       sentence for this ("could not be told") reads like any other failure. */
    if (outdated !== null && invoice?.unconfirmed !== true) {
      await api.release_delivery(delivery.id).catch(() => null);

      return "outdated";
    }

    /* Three different answers, and the distinction is the whole safety story.
       `blocked` is a refusal nothing should retry; `unconfirmed` means Submit
       was pressed and the outcome is unknown; anything else is a clean failure
       with nothing sent. */
    if (invoice?.awaiting_submit === true) {
      awaiting_submit = true;
      await remember_awaiting(`${url}/invoices`, delivery_tab_id);

      /* Hers now. Unlocked so Submit Invoice can be pressed, and forgotten so
         neither the end of this run nor the next one closes or reuses it. */
      await hand_over(delivery_tab_id);
      delivery_tab_id = null;
    }
    if (invoice?.blocked === true) return finish("blocked", invoice.error);
    if (invoice?.unconfirmed === true) return finish("unconfirmed", invoice.error);

    return finish("failed", invoice?.error || "The invoice could not be filled in.", {
      read_back: invoice?.read_back || "",
    });
  }

  if (options.dry_run)
    return finish("dry_run", "", { read_back: invoice.read_back || "", expected: invoice.expected || "" });

  /* ---- E: work done ---------------------------------------------------- */

  current_step = "E: work done";

  /* Deliberately not fatal. The money is the delivery, and a job left In
     Progress with a correct invoice on it is untidy — reporting it as failed
     would invite a retry, and the retry would submit the invoice again.

     Not fatal is not the same as not worth knowing, though, and this used to
     be discarded entirely: the step had no wait and no confirmation, so it
     probably missed often and nothing anywhere would have said so. The
     outcome now rides back on the result for the popup to total up. It is
     deliberately not sent to the server — mark_delivered() nulls last_error,
     so there is nowhere honest to put it, and inventing a field to carry a
     non-failure is worse than reporting it where somebody is already looking. */
  const done = await command(url, "VENDOR_WORK_DONE", {}).catch(() => null);

  return finish("delivered", "", {
    external_ref: invoice.external_ref || "",
    work_done: done?.ok === true,
    photos_offered,
    photos_attached,
  });
}

/**
 * When a delivery may be refused outright.
 *
 * `blocked` is irreversible by machine: nothing retries it, it does not count
 * toward the circuit breaker, and it waits for a person on /deliveries. So it
 * is asserted only for something actually **seen** — a settled status badge,
 * the Estimates tab, an invoice AppFolio already holds, a total over the
 * property's limit, a job that arrived with no expected total. Never for a
 * failure to see: a number found on no tab and a missing Accept button are
 * both `failed`, which retries, because nothing was written either way.
 *
 * This reverses an earlier version that called a clean-looking miss `blocked`.
 * The reasoning was that three tabs read without error is evidence about the
 * number — and it was, until a tab could report itself read when it was still
 * a skeleton. Then a job sitting in plain sight on In Progress was permanently
 * refused by a sentence that named the tabs it had supposedly searched. An
 * inference about what is absent is not an observation.
 */

/**
 * The portal statuses that mean there is nothing left to invoice.
 *
 * A deny-list of the terminal words, not an allow-list of the good ones, and an
 * unrecognised status proceeds. That is the opposite of this file's usual
 * direction and it is deliberate. The guard that protects money is
 * already_invoiced() on the invoices page, which is keyed on the *absence* of
 * one fixed sentence and so fails closed by construction; this one's job is
 * cheaper — stop burning attempts, photo notes and circuit-breaker budget on
 * jobs AppFolio has already paid for. An allow-list here would turn one
 * reworded badge into every job refused; a deny-list turns a new terminal word
 * into one job reaching the invoices page and being refused there instead.
 *
 * And the vocabulary is known to be incomplete: the saved Completed capture
 * holds `Payment Sent`, `Payment Pending` and `Under Review` but no
 * `Needs Invoice` and no `Closed` row, so the filter dropdown is the only
 * evidence for two of these five. Treating that as closed would be a guess.
 */
const SETTLED_STATUSES = ["under review", "payment pending", "payment sent", "closed"];

/**
 * Why this job should not be invoiced, or null to go ahead.
 *
 * Reads the *list row's* badge first, because that is the one word that is
 * certainly about this job: it came off the row whose number matched, whereas
 * the tab is an inference about which panel was rendered when the row was read,
 * and a tab switch that did not confirm can be wrong about it.
 *
 * `Needs Invoice` is not in here, and that is the whole point of reading the
 * Completed tab: a job sitting there needing an invoice is exactly the job this
 * queue exists to serve.
 */
function portal_refusal(delivery, located) {
  /* Collapsed here as well as in the content script, because the two arms of
     locate() clean their status to different degrees: a list badge comes
     through badge_text(), which collapses, but the detail page's comes through
     app.text(), which only trims — and that is the arm where the badge is
     absent and this string is the only signal there is. A stray double space
     inside `Payment  Sent` must not read as an unrecognised status. */
  const collapse = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const list_status = collapse(located.list_status);
  const status = list_status || collapse(located.status);
  const settled = SETTLED_STATUSES.includes(status.toLowerCase());

  if (settled)
    return `AppFolio has work order ${delivery.number} as "${status}"`
      + `${located.list_tab === "completed" ? " on the Completed tab" : ""}`
      + ", so there is nothing left to invoice. Nothing was touched.";

  /* The Estimates tab is not a slower route to the same job, it is a different
     kind of thing. A job being invoiced has already been done; an estimate is a
     price nobody has agreed to. */
  if (located.list_tab === "estimates")
    return `AppFolio has work order ${delivery.number} on the Estimates tab`
      + `${status === "" ? "" : ` as "${status}"`}`
      + ", which is a quote rather than work to invoice. Nothing was touched.";

  /* `Accept/Reject` is the one badge that appears on two tabs, and the two mean
     opposite things. On In Progress it is the work order waiting to be
     accepted, which step B handles and which appfolio_vendor_invoice.js argues
     is safe because the work demonstrably happened. On Estimates it is a
     *price* waiting to be accepted, and that argument does not carry — taking
     it would commit ASH to a figure nobody here has seen. So it proceeds only
     when the tab is known to be In Progress.

     Guarded on list_status being non-empty because the detail-page arm of
     locate() has no tab at all, and refusing every Accept/Reject reached by a
     remembered URL would be a new way to fail at what already works. */
  if (/accept/i.test(status) && list_status !== "" && located.list_tab !== "in_progress")
    return `AppFolio shows work order ${delivery.number} as "${status}" on the `
      + `${located.list_tab || "unknown"} tab, and only In Progress work is accepted `
      + "automatically. Nothing was touched.";

  return null;
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
        status: inspected.status || "",
        needs_accepting: inspected.needs_accepting === true,
        description: inspected.description || "",

        /* No list was read on this path, so there is no badge and no tab. That
           is not a gap to paper over: portal_refusal() falls back to the
           detail page's own status, and the already-invoiced guard on the
           invoices page is what it has always been backed by. */
        list_tab: "",
        list_status: "",
        tabs: [],
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
    status: inspected.status || "",
    needs_accepting: inspected.needs_accepting === true,
    description: inspected.description || "",

    /* Transient. Nothing persists these — the list row is gone by the next
       page load, and work_order_deliveries holds only target_url. They exist to
       be classified below and then to become prose in last_error. */
    list_tab: found.list_tab || "",
    list_status: found.list_status || "",
    tabs: Array.isArray(found.tabs) ? found.tabs : [],
  };
}

/**
 * The page's own answer to "may this be billed here", or null to proceed.
 *
 * The web app already answered it once — `work_orders.is_sample` was frozen
 * when the job was admitted, and `DeliveryQueue::drain()` only offered jobs
 * matching the current scope. This asks the vendor portal the same question
 * about the same job, a second time, from a page nobody here wrote.
 *
 * The value is in the disagreement. Because the stored answer cannot move and
 * this one is read fresh, the two *can* differ — somebody adding the marker to
 * a real work order, or removing it from a test one — and that difference is
 * caught here instead of becoming an invoice. Both halves of the check are
 * needed: a stored flag alone cannot notice AppFolio changing under it, and a
 * page read alone would just do whatever free text somebody last typed.
 *
 * `blocked`, not `failed`: nothing was written, a retry would not help, and a
 * person has to look. It spends no attempt and does not feed the breaker.
 *
 * **An unreadable description blocks in sample mode and proceeds in live.**
 * That asymmetry is deliberate. In sample mode this is the only thing standing
 * between the run and a real client's work order, so it fails closed. In live
 * mode the web app's own flag is the primary guard and has already passed, so
 * a renamed class on AppFolio's side should not stop the day's billing for
 * everybody. The check that protects a real client is the one that fails
 * closed.
 */
function scope_refusal(description, scope) {
  const text = String(description || "").trim();

  if (text === "")
    return scope.mode === "sample"
      ? "Sample mode is on and this work order's description could not be read from the vendor page, "
        + "so it cannot be confirmed as a test work order. Nothing was touched."
      : null;

  if (scope_admits(text, scope)) return null;

  return scope.mode === "sample"
    ? "Sample mode is on, but the vendor page does not describe this as a test work order. "
      + "Nothing was touched."
    : "The vendor page describes this as a test work order, and this web app is set to real work "
      + "only. Nothing was touched.";
}

/**
 * Is anybody signed in to the vendor portal, before anything is claimed?
 *
 * Aimed at the first job's own page rather than the portal home, so the
 * navigation this performs is the navigation step A was about to perform: for a
 * job with a remembered `target_url` that is the work order, and for one
 * without it is the list. Either way `command()`'s own `navigate()` finds the
 * tab already there and does not reload it, which is what makes the guard free.
 *
 * `portals.js` explains why the verdict is the tab's URL and not the DOM. The
 * short version: a signed-out manager ends up on `passport.appf.io`, which no
 * content script matches, so there is nothing on that page to ask.
 */
async function preflight_vendor(first) {
  const url = first?.target_url || VENDOR_HOME;

  const tab_id = await ensure_delivery_tab(url);

  if (tab_id === null)
    return { state: "unknown", detail: "Could not open an AppFolio vendor portal tab." };

  await navigate(tab_id, url);

  const verdict = await check_signed_in("appfolio", tab_id);

  /* Put the sign-in page in front of her. The tab is already on it — being
     redirected there is what produced the verdict — so this is a focus and not
     a navigation, and nothing is typed into it. */
  if (verdict.state === "signed_out") await hand_over_delivery_tab();

  return verdict;
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

  if (tab_id === null)
    return { ok: false, error: tab_closed ? TAB_CLOSED : "Could not open an AppFolio vendor portal tab." };

  await navigate(tab_id, url);

  const state = await ask_page_state(tab_id);

  /* Checked before reading the page's answer, because a person closing the tab
     produces exactly the symptoms below and deserves its own words. */
  if (noticed_closed(tab_id)) return { ok: false, error: TAB_CLOSED };
  if (state === "signed_out") return { ok: false, signed_out: true, error: "The vendor portal is signed out." };
  if (state !== "ready") return { ok: false, error: "The vendor portal page did not finish loading." };

  try {
    return await with_timeout(chrome.tabs.sendMessage(tab_id, { type, payload }), STEP_MS);
  } catch {
    if (noticed_closed(tab_id)) return { ok: false, error: TAB_CLOSED };

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
  /* A job that went wrong closes its tab, and says what the tab showed first.
     `blocked` is not in this: it is a decision made from what the page said,
     not a page that misbehaved. */
  if (state === "failed" || state === "unconfirmed")
    await close_delivery_tab({
      number: delivery.number,
      state,
      step: current_step,
      error,
      detail: extra.read_back ? { read_back: extra.read_back } : null,
    });

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

    /* A refusal is still a refusal in a rehearsal, and saying so is the point
       of rehearsing: a job the portal's verdict turns away here is a job a live
       run turns away identically, so calling it `failed` would have the very
       first rehearsal report failures against a system working exactly right.
       The release above is unchanged — nothing was written and the attempt is
       refunded either way; only the word in the tally moves. */
    if (options.dry_run && state === "blocked") return "blocked";

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

  /* A portal sign-out used to arrive here as a `failed` result carrying
     `signed_out: true`. It no longer reaches report() at all — deliver_one
     releases the row instead, because nothing had happened to an invoice and
     there was no result to record. */

  /* Counted here rather than returned, because the caller gets a string. A
     shortfall is not a failure — the invoice is right and the money went — but
     it is the one thing about a delivered job that nobody would otherwise
     notice, which is exactly how four text-only notes went out unremarked. */
  if (state === "delivered")
    photos_missing += Math.max(0, Number(extra.photos_offered ?? 0) - Number(extra.photos_attached ?? 0));

  /* `delivered_open` is not a delivery state and never reaches the server —
     the result was posted as `delivered` just above, which is what it is. It
     exists only so deliver_now can total the jobs whose Work Done click did
     not land, since a delivered row's last_error is nulled and the server has
     nowhere to keep a note about a non-failure. */
  return state === "delivered" && extra.work_done === false ? "delivered_open" : state;
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
      .then((response) => {
        /* Kept for deliver_one, which gets only the page's sentence back. */
        if (is_outdated(response)) outdated = response.body;

        respond({ ok: response.ok, status: response.status });
      })
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

    /* Kept rather than cleared, so the failure this causes is reported
       against the tab a person closed. */
    if (noticed_closed(delivery_tab_id)) return null;

    delivery_tab_id = null;
  }

  /* Not reopened behind a person's back. They closed it; the run stops. */
  if (tab_closed) return null;

  /* Not focused. See the note at the top: forty jobs stealing focus forty times
     is worse than no automation at all. */
  const tab = await open_owned_tab("delivery", url, { active: false, label: current_label });
  if (!tab?.id) return null;

  delivery_tab_id = tab.id;
  await wait_for_load(tab.id);

  return tab.id;
}

/** Notes a person closing the tab, and answers whether they did. */
function noticed_closed(tab_id) {
  if (tab_id === null || !closed_by_person(tab_id)) return false;

  tab_closed = true;

  return true;
}

/**
 * Close the run's tab, with a report when `failure` says what went wrong.
 *
 * The next job opens a fresh tab, which is also a clean page: nothing a failed
 * job left half-done on a form is inherited by the one after it. A tab a
 * person already closed is still reported, and says so.
 */
async function close_delivery_tab(failure = null) {
  const id = delivery_tab_id;
  delivery_tab_id = null;

  if (id === null) return;

  await close_owned_tab(
    id,
    failure === null ? null : { owner: "delivery", label: current_label, run: run_kind, ...failure },
  );
}

/**
 * A sign-in page, unlocked and no longer this run's.
 *
 * Put in front of somebody only when they pressed the button. A timed run
 * leaves it where it is and says so once: it fires every minute whether or not
 * anybody is at the desk, and pulling a window forward over whatever a person
 * is typing is not a thing a timer gets to do.
 */
async function hand_over_delivery_tab() {
  const id = delivery_tab_id;
  delivery_tab_id = null;

  if (id === null) return;

  await hand_over(id);
  await remember_sign_in_tab("appfolio", id);

  if (run_kind === "manual") {
    await show_sign_in(id);

    return;
  }

  notify(
    "AppFolio",
    "Approved invoices are waiting, and the AppFolio vendor portal is signed out. Sign in on the tab that "
      + "was just opened; they will be delivered within a minute.",
  );
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

      const state = response?.state || "unconfirmed";

      /* "unknown" is the page saying it has neither portal chrome nor a
         sign-in marker yet, which is what a half-rendered page looks like —
         so it is retried on the same budget as a missing listener rather than
         returned. read_state() used to answer "ready" in this case, and
         command() would go on to drive a page that had not arrived. */
      if (state !== "unknown") return state;

      if (attempt === attempts - 1) return "unconfirmed";
    } catch {
      if (attempt === attempts - 1) return "unconfirmed";
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
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
