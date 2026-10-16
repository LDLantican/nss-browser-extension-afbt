/**
 * The appfolio_vendor adapter: the service-worker half (roadmap phase 9).
 *
 * Every plan is short steps that each ask the page script (page.js) one small
 * question, so a step run twice after a crash does no harm, and exactly one
 * commit step per operation — the press AppFolio keeps. Before it, the steps
 * only navigate, read and type; the order is always:
 *
 *   locate         find the work order (its URL, or by number on the list),
 *                  check it is the right one, signed in, still open, and that
 *                  its live description agrees with the connection's scope;
 *   find_existing  look for what an earlier attempt may already have done —
 *                  a note with this text, an invoice, a status already past
 *                  this step — and if it is there, complete without pressing;
 *   prepare        fill: photographs attached and counted, invoice lines typed
 *                  and the page's arithmetic checked to the cent;
 *   <commit>       the one press, after the web app's commit;
 *   capture        read back what the press produced, or report that nobody
 *                  knows — never press again.
 *
 * Money is the web app's: lines are typed as handed over, and the page's own
 * Amounts and Total are compared with `expected_total_cents` and each item's
 * figure. Nothing is computed here.
 *
 * The rules that refuse are legacy's, kept (docs/browser-extension.md,
 * Delivery): a settled or Estimates work order is not billed; a test-scope
 * connection bills only a work order whose description *on the live page*
 * carries the marker, a live one only one that does not; an invoice over the
 * property's maintenance limit is held unless the connection says `send`; a
 * note is never saved short of its photographs.
 */

import manifest from "./manifest.js";
import { AdapterError, PERMANENT, SESSION_EXPIRED, TRANSIENT, UNKNOWN_OUTCOME } from "../../worker/errors.js";

export const ORIGIN = "https://vendor.appfolio.com";

/** The cached answer to "is this browser signed in to the vendor portal?" */
export const SESSION_KEY = "ash_vendor_session";

/** The web app wants a session report under 5 minutes old; refresh before that. */
const SESSION_FRESH_MS = 4 * 60 * 1000;
const PROBE_MS = 20000;

/**
 * Reasons a probe tab could change. Anything else — switched off, not an
 * operator, killed — a probe cannot fix, so no tab is opened for it.
 */
const PROBE_HELPS = new Set([null, "session_not_live", "session_stale", "heartbeat_stale", "adapter_not_reported"]);

const SETTLED = /^(under review|payment pending|payment sent|closed)$/i;
const ESTIMATE = /^(estimate needed|estimated)$/i;
const NEEDS_ACCEPTING = /accept/i;

const PERSON_WAIT_MS = 10 * 60 * 1000;
const PERSON_POLL_MS = 2000;
const LOOK_MS = 15000;
const LOOK_POLL_MS = 1000;

function number_of(job) {
  return String(job.link?.number || "").trim();
}

/** `/2433209/workOrders/20020` out of a stored vendor URL, or null. */
export function path_of(url) {
  const match = /^https:\/\/vendor\.appfolio\.com(\/\d+\/workOrders\/\d+)/.exec(String(url || ""));

  return match ? match[1] : null;
}

/** The marker check's folding: the three invisible ways it would otherwise break. */
function fold(text) {
  return String(text ?? "")
    .replace(/[ ​]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function identity_of(ctx) {
  return ctx.data.path ? { id: ctx.data.id || null, url: `${ORIGIN}${ctx.data.path}` } : null;
}

/** Navigate this job's tab to one of the work order's pages, and check it arrived. */
async function go(ctx, suffix = "") {
  await ctx.open(`${ORIGIN}${ctx.data.path}${suffix}`);

  const state = await page_state(ctx);
  const kind = suffix === "/notes" ? "notes" : suffix === "/invoices" ? "invoices" : "work_order";

  if (state.kind !== kind) throw new AdapterError(TRANSIENT, `Expected the ${kind} page, but the portal shows ${state.kind}.`);
  if (state.number !== number_of(ctx.job))
    throw new AdapterError(PERMANENT, `The portal shows work order ${state.number || "(none)"}, not ${number_of(ctx.job)}.`);

  return state;
}

/**
 * What the page in this job's tab says about itself. Signing out sends the
 * portal to AppFolio's sign-in host a few seconds after the page loads, where
 * no page script answers, so the tab's address is watched while asking.
 */
async function page_state(ctx) {
  const until = ctx.now() + PROBE_MS;

  for (;;) {
    const url = await ctx.tab_url();

    if (url && !url.startsWith(ORIGIN)) throw new AdapterError(SESSION_EXPIRED, "This browser is signed out of the AppFolio vendor portal.");

    let state = null;

    try {
      state = await ctx.ask("state", {}, { timeout_ms: 3000 });
    } catch (error) {
      if (error?.error_class !== TRANSIENT || ctx.now() > until) throw error;
    }

    if (state?.signed_in === false) throw new AdapterError(SESSION_EXPIRED, "This browser is signed out of the AppFolio vendor portal.");
    if (state) return state;

    await ctx.sleep(LOOK_POLL_MS);
  }
}

/**
 * The live description against the connection's scope (legacy's last check
 * before typing, docs/browser-extension.md, Scope). Unreadable is a refusal
 * on a test connection and allowed on a live one, as legacy had it: a test
 * connection must *see* the marker, a live one must not.
 */
function check_scope(ctx, description) {
  const marker = fold(ctx.job.payload?.work_order?.sample_marker);
  const testing = ctx.job.connection?.scope !== "live";

  if (testing && marker === "") throw new AdapterError(PERMANENT, "The connection is in test mode but the web app named no test marker.");

  if (description === null || description === undefined) {
    if (testing) throw new AdapterError(PERMANENT, "Could not read the work order's description to confirm it is a test work order.");

    return;
  }

  const marked = marker !== "" && fold(description).includes(marker);

  if (testing && !marked)
    throw new AdapterError(PERMANENT, "The connection is in test mode, but this work order's description in AppFolio does not carry the test marker.");

  if (!testing && marked)
    throw new AdapterError(PERMANENT, "The connection is live, but this work order's description in AppFolio carries the test marker.");
}

/** Find the work order, open its detail page, and check it may be worked. */
const locate = {
  name: "locate",
  async run(ctx) {
    const number = number_of(ctx.job);

    if (number === "") throw new AdapterError(PERMANENT, "This job has no AppFolio work-order number to look for.");

    let path = ctx.data.path || path_of(ctx.job.link?.url);
    let state = null;

    if (path) {
      ctx.data.path = path;
      await ctx.open(`${ORIGIN}${path}`);
      state = await page_state(ctx);

      /* A remembered address can go stale; the number on the list cannot. */
      if (state.number !== number) path = null;
    }

    if (!path) {
      await ctx.open(`${ORIGIN}/`);
      await page_state(ctx);

      const found = await ctx.ask("find_in_list", { number });

      if (!found?.path)
        throw new AdapterError(PERMANENT, `Work order ${number} is not on any tab of the vendor portal (looked at ${(found?.looked || []).join(", ") || "none"}).`);

      path = found.path;
      ctx.data.path = path;
      state = await go(ctx);
    }

    if (ESTIMATE.test(state.status)) throw new AdapterError(PERMANENT, `Work order ${number} is an estimate (${state.status}) in AppFolio, not a job to bill.`);

    check_scope(ctx, state.description);

    return { data: { path, id: state.id, account: state.account, status: state.status, limit_cents: state.limit_cents ?? null } };
  },
};

/** Refuse a step that only makes sense on a job still open in AppFolio. */
function must_be_open(ctx, what) {
  const status = String(ctx.data.status || "");

  if (NEEDS_ACCEPTING.test(status))
    throw new AdapterError(PERMANENT, `Work order ${number_of(ctx.job)} still waits to be accepted (${status}), so ${what} was not done.`);

  if (SETTLED.test(status))
    throw new AdapterError(PERMANENT, `Work order ${number_of(ctx.job)} is already ${status} in AppFolio, so ${what} was not done.`);
}

/**
 * Poll `look` until it answers, for at most `ms`. Page commands that fail
 * because the page is between renders are asked again; anything else stops.
 */
async function poll(ctx, look, ms = LOOK_MS) {
  const until = ctx.now() + ms;

  for (;;) {
    try {
      const seen = await look();

      if (seen) return seen;
    } catch (error) {
      if (error?.error_class !== TRANSIENT && error?.error_class !== "adapter_broken") throw error;
    }

    if (ctx.now() >= until) return null;

    await ctx.sleep(LOOK_POLL_MS);
  }
}

/**
 * A commit step left to a person: poll for what their press produced,
 * renewing the lease while waiting, until it appears or the wait runs out —
 * which is reported as unknown, because they may yet press it.
 */
async function wait_for_person(ctx, step, look) {
  const deadline = ctx.now() + PERSON_WAIT_MS;

  while (ctx.now() < deadline) {
    let seen = null;

    try {
      seen = await look();
    } catch {
      seen = null;
    }

    if (seen) return { data: seen };

    await ctx.sleep(PERSON_POLL_MS);
    await ctx.touch(step);
  }

  throw new AdapterError(UNKNOWN_OUTCOME, "Nobody pressed the button in time.");
}

// -- accept -------------------------------------------------------------------

function accepted(state) {
  return !NEEDS_ACCEPTING.test(String(state?.status || ""));
}

const ACCEPT = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      if (NEEDS_ACCEPTING.test(String(ctx.data.status || ""))) return undefined;

      return { already_done: true, identity: identity_of(ctx), evidence: `Nothing to accept: AppFolio shows it ${ctx.data.status || "open"}.` };
    },
  },
  {
    name: "accept",
    commit: true,
    async act(ctx) {
      await ctx.ask("accept", {}, { once: true });

      return undefined;
    },
    async await_person(ctx) {
      await ctx.reveal(`Press Accept on AppFolio work order ${number_of(ctx.job)}.`);

      return wait_for_person(ctx, "accept", async () => {
        const state = await ctx.ask("state");

        return accepted(state) ? { evidence: `Accepted by hand; AppFolio shows ${state.status}.` } : null;
      });
    },
  },
  {
    name: "capture",
    async run(ctx) {
      const state = await poll(ctx, async () => {
        const seen = await ctx.ask("state");

        return accepted(seen) ? seen : null;
      });

      if (!state) throw new AdapterError(UNKNOWN_OUTCOME, "Accept was pressed but AppFolio still shows the work order waiting to be accepted.");

      return { data: { identity: identity_of(ctx), evidence: ctx.data.evidence || `Accepted; AppFolio shows ${state.status}.` } };
    },
  },
];

// -- post_photos --------------------------------------------------------------

function note_of(ctx) {
  const note = String(ctx.job.payload?.note || "").trim();

  if (note === "") throw new AdapterError(PERMANENT, "The claim carried no note text.");

  return note;
}

function photos_of(ctx) {
  const photos = ctx.job.payload?.photos;

  if (!Array.isArray(photos) || photos.length === 0) throw new AdapterError(PERMANENT, "The claim carried no photographs.");

  return photos;
}

/** The notes list once it has rendered: `{count, match}` — or null while it has not. */
async function notes_now(ctx) {
  const notes = await ctx.ask("notes", { text: note_of(ctx) });

  return notes?.settled ? notes : null;
}

const POST_PHOTOS = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      must_be_open(ctx, "the photographs");
      await go(ctx, "/notes");

      const notes = await poll(ctx, () => notes_now(ctx));

      if (!notes) throw new AdapterError(TRANSIENT, "The notes list never finished loading.");

      return notes.match ? { already_done: true, evidence: `A note saying "${note_of(ctx)}" is already on the work order.` } : undefined;
    },
  },
  {
    name: "prepare",
    async run(ctx) {
      const photos = photos_of(ctx);

      /* A fresh page every time: a form half-filled by a worker that died is
         thrown away, never added to. */
      await go(ctx, "/notes");

      for (const photo of photos) {
        const file = await ctx.photo(photo.id);

        await ctx.ask("stage_photo", { name: file.name || photo.name || `photo-${photo.id}.jpg`, mime_type: file.mime_type, b64: file.b64 });
        await ctx.touch("prepare");
      }

      const { attached = 0 } = (await ctx.ask("attach_staged")) || {};

      if (attached !== photos.length)
        throw new AdapterError(TRANSIENT, `The note took ${attached} of ${photos.length} photographs, so it was not saved.`);

      await ctx.ask("fill_note", { text: note_of(ctx) });

      return { data: { attached } };
    },
  },
  {
    name: "save_note",
    commit: true,
    async act(ctx) {
      await ctx.ask("save_note", {}, { once: true });

      return undefined;
    },
    async await_person(ctx) {
      await ctx.reveal(`Check the photographs on AppFolio work order ${number_of(ctx.job)} and press Save Note.`);

      return wait_for_person(ctx, "save_note", async () => {
        const notes = await ctx.ask("notes", { text: note_of(ctx) });

        return notes?.match ? { evidence: `"${note_of(ctx)}" saved by hand.` } : null;
      });
    },
  },
  {
    name: "capture",
    async run(ctx) {
      /* Saving may take the portal back to the work order, and must not be
         navigated away from while it is still sending: wait for the page to
         settle first, then look at the notes. */
      await ctx.sleep(3000);

      let notes = await poll(ctx, async () => {
        const state = await ctx.ask("state");

        return state.kind === "notes" ? notes_now(ctx).then((seen) => (seen?.match ? seen : null)) : null;
      }, 8000);

      if (!notes) {
        await go(ctx, "/notes");
        notes = await poll(ctx, async () => {
          const seen = await notes_now(ctx);

          return seen?.match ? seen : null;
        });
      }

      if (!notes) throw new AdapterError(UNKNOWN_OUTCOME, `Save Note was pressed but no note saying "${note_of(ctx)}" appeared.`);

      return { data: { evidence: ctx.data.evidence || `Posted "${note_of(ctx)}" with ${ctx.data.attached} photographs.` } };
    },
  },
];

// -- submit_invoice -----------------------------------------------------------

function items_of(ctx) {
  const items = ctx.job.payload?.invoice?.items;

  if (!Array.isArray(items) || items.length === 0) throw new AdapterError(PERMANENT, "The claim carried no invoice lines.");

  return items;
}

function invoice_identity(ctx, bills) {
  const bill = [...(bills || [])].reverse().find((b) => b.number) || (bills || [])[0];

  return {
    ...(bill?.number ? { number: bill.number } : {}),
    url: `${ORIGIN}${ctx.data.path}/invoices`,
  };
}

/** The invoices page once it says one way or the other — or null while it has not. */
async function invoices_now(ctx) {
  const state = await ctx.ask("invoice_state");

  return state && (state.invoiced || state.none) ? state : null;
}

const SUBMIT_INVOICE = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      if (NEEDS_ACCEPTING.test(String(ctx.data.status || "")))
        throw new AdapterError(PERMANENT, `Work order ${number_of(ctx.job)} still waits to be accepted, so it was not invoiced.`);

      const state = await go(ctx, "/invoices");
      const invoices = await poll(ctx, () => invoices_now(ctx));

      if (!invoices) throw new AdapterError(TRANSIENT, "Could not tell whether the work order has an invoice already.");

      if (invoices.invoiced)
        return {
          already_done: true,
          identity: invoice_identity(ctx, invoices.bills),
          evidence: `An invoice is already on the work order (${invoices.bills.map((b) => b.file).join(", ")}).`,
        };

      if (SETTLED.test(state.status)) throw new AdapterError(PERMANENT, `Work order ${number_of(ctx.job)} is already ${state.status} in AppFolio, with no invoice.`);

      return { data: { limit_cents: invoices.limit_cents ?? ctx.data.limit_cents ?? null } };
    },
  },
  {
    name: "check_limit",
    async run(ctx) {
      const limit = ctx.data.limit_cents;
      const expected = ctx.job.expected_total_cents;

      if (limit === null || limit === undefined || expected === null || expected <= limit) return undefined;

      if (ctx.job.connection?.on_over_limit === "send") return undefined;

      throw new AdapterError(
        PERMANENT,
        `The invoice totals ${(expected / 100).toFixed(2)}, over this property's maintenance limit of ${(limit / 100).toFixed(2)}, so it was held for a person.`,
      );
    },
  },
  {
    name: "fill",
    async run(ctx) {
      const items = items_of(ctx);

      /* A fresh page, as for a note: never finish somebody else's half-typed form. */
      await go(ctx, "/invoices");
      await poll(ctx, () => invoices_now(ctx));

      const filled = await ctx.ask("fill_invoice", { items: items.map(({ description, quantity, rate }) => ({ description, quantity, rate })) });

      if (filled?.lines !== items.length) throw new AdapterError(PERMANENT, `The form took ${filled?.lines ?? 0} of ${items.length} lines.`);

      return undefined;
    },
  },
  {
    name: "check_total",
    async run(ctx) {
      const items = items_of(ctx);
      const page = (await ctx.ask("read_total")) || {};

      items.forEach((item, i) => {
        if (page.amounts?.[i] !== item.expected_total_cents)
          throw new AdapterError(
            PERMANENT,
            `Line ${i + 1} reads ${page.amounts?.[i] ?? "nothing"} cents against the ${item.expected_total_cents} expected, so it was not submitted.`,
          );
      });

      if (page.total_cents !== ctx.job.expected_total_cents)
        throw new AdapterError(
          PERMANENT,
          `The page totals ${page.total_cents ?? "nothing"} cents against the ${ctx.job.expected_total_cents} expected, so it was not submitted.`,
        );

      return undefined;
    },
  },
  {
    name: "submit",
    commit: true,
    async act(ctx) {
      await ctx.ask("submit_invoice", {}, { once: true });

      return undefined;
    },
    async await_person(ctx) {
      await ctx.reveal(`Check the invoice on AppFolio work order ${number_of(ctx.job)} and press Submit Invoice.`);

      return wait_for_person(ctx, "submit", async () => {
        const state = await ctx.ask("invoice_state");

        return state?.invoiced ? { identity: invoice_identity(ctx, state.bills), evidence: "Submitted by hand." } : null;
      });
    },
  },
  {
    name: "capture",
    async run(ctx) {
      if (ctx.data.identity) return undefined;

      let invoices = await poll(ctx, async () => {
        const state = await ctx.ask("invoice_state");

        return state?.invoiced ? state : null;
      });

      if (!invoices) {
        await go(ctx, "/invoices");
        invoices = await poll(ctx, async () => {
          const state = await ctx.ask("invoice_state");

          return state?.invoiced ? state : null;
        });
      }

      if (!invoices) throw new AdapterError(UNKNOWN_OUTCOME, "Submit Invoice was pressed but no invoice appeared on the work order.");

      return {
        data: {
          identity: invoice_identity(ctx, invoices.bills),
          evidence: `Submitted ${invoices.bills.map((b) => b.file).join(", ")} for ${ctx.job.expected_total_cents} cents.`,
        },
      };
    },
  },
];

// -- mark_work_done -----------------------------------------------------------

const MARK_WORK_DONE = () => [
  locate,
  {
    name: "find_existing",
    async run(ctx) {
      const status = String(ctx.data.status || "");

      if (SETTLED.test(status)) return { already_done: true, identity: identity_of(ctx), evidence: `Already ${status} in AppFolio.` };

      if (NEEDS_ACCEPTING.test(status))
        throw new AdapterError(PERMANENT, `Work order ${number_of(ctx.job)} still waits to be accepted, so Work Done was not pressed.`);

      return undefined;
    },
  },
  {
    name: "work_done",
    commit: true,
    async act(ctx) {
      await ctx.ask("work_done", {}, { once: true });

      return undefined;
    },
    async await_person(ctx) {
      await ctx.reveal(`Press Work Done on AppFolio work order ${number_of(ctx.job)}, then Yes.`);

      return wait_for_person(ctx, "work_done", async () => {
        const state = await ctx.ask("state");

        return SETTLED.test(String(state?.status || "")) ? { evidence: `Marked done by hand; AppFolio shows ${state.status}.` } : null;
      });
    },
  },
  {
    name: "capture",
    async run(ctx) {
      /* The badge is read again after a reload, as legacy learned to: the
         first render after Yes can still show the old status. */
      await ctx.sleep(3000);
      await go(ctx);

      const state = await poll(ctx, async () => {
        const seen = await ctx.ask("state");

        return SETTLED.test(String(seen?.status || "")) ? seen : null;
      });

      if (!state) throw new AdapterError(UNKNOWN_OUTCOME, "Work Done was pressed but AppFolio does not show the work order as done.");

      return { data: { identity: identity_of(ctx), evidence: ctx.data.evidence || `Work Done; AppFolio shows ${state.status}.` } };
    },
  },
];

const PLANS = { accept: ACCEPT, post_photos: POST_PHOTOS, submit_invoice: SUBMIT_INVOICE, mark_work_done: MARK_WORK_DONE };

// -- Verification: open and look, never press ---------------------------------

const VERIFY = {
  accept: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        return NEEDS_ACCEPTING.test(String(ctx.data.status || ""))
          ? { verdict: "absent", evidence: `AppFolio still shows ${ctx.data.status}.` }
          : { verdict: "found", identity: identity_of(ctx), evidence: `AppFolio shows ${ctx.data.status}.` };
      },
    },
  ],

  post_photos: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        await go(ctx, "/notes");

        const notes = await poll(ctx, () => notes_now(ctx));

        if (!notes) throw new AdapterError(TRANSIENT, "The notes list never finished loading.");

        return notes.match
          ? { verdict: "found", evidence: `A note saying "${note_of(ctx)}" is on the work order.` }
          : { verdict: "absent", evidence: `No note says "${note_of(ctx)}" (${notes.count} notes on the work order).` };
      },
    },
  ],

  submit_invoice: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        await go(ctx, "/invoices");

        const invoices = await poll(ctx, () => invoices_now(ctx));

        if (!invoices) throw new AdapterError(TRANSIENT, "Could not tell whether the work order has an invoice.");

        return invoices.invoiced
          ? { verdict: "found", identity: invoice_identity(ctx, invoices.bills), evidence: `On the work order: ${invoices.bills.map((b) => b.file).join(", ")}.` }
          : { verdict: "absent", evidence: "AppFolio says no invoice has been uploaded for this work order." };
      },
    },
  ],

  mark_work_done: () => [
    locate,
    {
      name: "look",
      async run(ctx) {
        return SETTLED.test(String(ctx.data.status || ""))
          ? { verdict: "found", identity: identity_of(ctx), evidence: `AppFolio shows ${ctx.data.status}.` }
          : { verdict: "absent", evidence: `AppFolio still shows ${ctx.data.status}.` };
      },
    },
  ],
};

// -- The session ----------------------------------------------------------------

/**
 * Open the portal in a background tab of the ASH group and see where it lands:
 * the portal, signed in, or AppFolio's sign-in page. Closed again either way.
 */
async function probe(env) {
  const tab = await env.tabs.open(`${ORIGIN}/`);

  if (tab === null || tab === undefined) return { state: "unknown" };

  try {
    const until = env.now() + PROBE_MS;

    while (env.now() <= until) {
      const url = await env.tabs.url(tab);

      if (url && !url.startsWith(ORIGIN)) return { state: /appf\.io|sign_in|login/i.test(url) ? "expired" : "unknown" };

      try {
        const state = await env.page.send(tab, "state", {}, { timeout_ms: 3000 });

        if (state?.signed_in === false) return { state: "expired" };
        if (state?.signed_in === true) return { state: "live", account: state.account || null };
      } catch {
        /* Not answering yet: still loading, or on its way to the sign-in page. */
      }

      await env.sleep(1000);
    }

    return { state: "unknown" };
  } finally {
    await env.tabs.close(tab).catch(() => null);
  }
}

export default {
  ...manifest,

  /**
   * Signed in to the vendor portal? A vendor page this browser loaded in the
   * last four minutes says so for free (page.js, ASH_VENDOR_SEEN); older than
   * that, and only while this browser is processing and the web app's last
   * answer was one a probe could change, a probe tab looks.
   */
  async session(env, connection = {}, { processing = true } = {}) {
    const seen = await env.local.get(SESSION_KEY);

    if (seen && env.now() - seen.at < SESSION_FRESH_MS) return { state: seen.state, account_hint: seen.account || null };

    if (!processing || connection.enabled === false || !PROBE_HELPS.has(connection.reason ?? null))
      return { state: "unknown" };

    const probed = await probe(env);

    await env.local.set(SESSION_KEY, { state: probed.state, account: probed.account || null, at: env.now() });

    return { state: probed.state, account_hint: probed.account || null };
  },

  /** A job found this browser signed out: forget the cached "live" at once. */
  async session_lost(env) {
    await env.local.set(SESSION_KEY, { state: "expired", account: null, at: env.now() });
  },

  plan(job) {
    const plan = PLANS[job.operation];

    if (!plan) throw new Error(`The vendor-portal adapter cannot ${job.operation}.`);

    return plan();
  },

  verify_plan(job) {
    const plan = VERIFY[job.operation];

    if (!plan) throw new Error(`The vendor-portal adapter cannot verify ${job.operation}.`);

    return plan();
  },

  parse_url(url) {
    const match = /^https:\/\/vendor\.appfolio\.com\/(\d+)\/workOrders\/(\d+)/.exec(String(url || ""));

    return match ? { account: match[1], id: match[2] } : null;
  },
};
