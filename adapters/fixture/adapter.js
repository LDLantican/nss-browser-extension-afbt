/**
 * The fixture adapter: the service-worker half.
 *
 * Its steps are the shape the vendor-portal adapter's will be (roadmap
 * phase 9): open the work order, look for what an earlier attempt may already
 * have done, fill, check the page's own total against the server's to the
 * cent, then — and only then — the commit step, then read back what it made.
 * Every step only asks the page script (page.js) one small question, so a step
 * that is run twice after a crash does no harm.
 *
 * Money is the server's: the adapter types the figures it is handed and
 * compares the page's total with `expected_total_cents`. It computes nothing.
 */

import manifest from "./manifest.js";
import { SITE_KEY } from "./site/ledger.js";
import { AdapterError, PERMANENT, SESSION_EXPIRED, UNKNOWN_OUTCOME } from "../../worker/errors.js";

/** The fixture site's work-order page, inside the extension. */
const PAGE = "adapters/fixture/site/work_order.html";

/** How long a person is given to press the button on a hands-off connection. */
const PERSON_WAIT_MS = 10 * 60 * 1000;
const PERSON_POLL_MS = 2000;

function number_of(job) {
  return String(job.link?.number || job.entity?.public_id || "");
}

function page_url(ctx, number) {
  return `${ctx.extension_url(PAGE)}?wo=${encodeURIComponent(number)}`;
}

/** Open the work order and make sure it is the right one, signed in. */
const open = {
  name: "open",
  async run(ctx) {
    const number = number_of(ctx.job);

    if (number === "") throw new AdapterError(PERMANENT, "This job has no work-order number to open.");

    await ctx.open(page_url(ctx, number));

    const page = await ctx.ask("state");

    if (page?.signed_in === false) throw new AdapterError(SESSION_EXPIRED, "The fixture site is signed out.");

    if (page?.number !== number)
      throw new AdapterError(PERMANENT, `The page shows work order ${page?.number || "(none)"}, not ${number}.`);

    return undefined;
  },
};

function identity_of(ctx, invoice) {
  return { id: invoice.id, number: invoice.number, url: `${page_url(ctx, number_of(ctx.job))}#invoice-${invoice.id}` };
}

/** The steps of each operation, by name. */
const PLANS = {
  submit_invoice: () => [
    open,
    {
      name: "find_existing",
      async run(ctx) {
        const found = await ctx.ask("find_invoice", { total_cents: ctx.job.expected_total_cents });

        if (!found?.invoice) return undefined;

        return {
          already_done: true,
          identity: identity_of(ctx, found.invoice),
          evidence: `${found.invoice.number} for ${found.invoice.total_cents} cents was already there.`,
        };
      },
    },
    {
      name: "fill",
      async run(ctx) {
        const items = ctx.job.payload?.invoice?.items;

        if (!Array.isArray(items) || items.length === 0) throw new AdapterError(PERMANENT, "The claim carried no invoice lines.");

        const filled = await ctx.ask("fill_invoice", {
          items: items.map(({ description, quantity, rate }) => ({ description, quantity, rate })),
        });

        if (filled?.lines !== items.length)
          throw new AdapterError(PERMANENT, `The form took ${filled?.lines ?? 0} of ${items.length} lines.`);

        return undefined;
      },
    },
    {
      name: "check_total",
      async run(ctx) {
        const { total_cents } = (await ctx.ask("read_total")) || {};

        if (total_cents !== ctx.job.expected_total_cents)
          throw new AdapterError(
            PERMANENT,
            `The page totals ${total_cents} cents against the ${ctx.job.expected_total_cents} expected, so it was not submitted.`,
          );

        return undefined;
      },
    },
    {
      name: "submit",
      commit: true,
      async act(ctx) {
        await ctx.ask("submit", {}, { once: true });

        return undefined;
      },
      async await_person(ctx) {
        await ctx.reveal("Check the invoice and press Submit.");

        return wait_for_person(ctx, "submit", async () => {
          const found = await ctx.ask("find_invoice", { total_cents: ctx.job.expected_total_cents });

          return found?.invoice ? { identity: identity_of(ctx, found.invoice), evidence: `${found.invoice.number} submitted by hand.` } : null;
        });
      },
    },
    {
      name: "capture",
      async run(ctx) {
        if (ctx.data.identity) return undefined;

        /* The page re-renders its list once the platform has the invoice, which
           can be a moment after the click. */
        const found = await ctx.ask("find_invoice", { total_cents: ctx.job.expected_total_cents, wait_ms: 5000 });

        if (!found?.invoice)
          throw new AdapterError(UNKNOWN_OUTCOME, "Submit was pressed but no invoice with the expected total appeared.");

        return {
          data: {
            identity: identity_of(ctx, found.invoice),
            evidence: `Submitted ${found.invoice.number} for ${found.invoice.total_cents} cents.`,
          },
        };
      },
    },
  ],

  accept: () => [
    open,
    {
      name: "find_existing",
      async run(ctx) {
        const page = await ctx.ask("state");

        return page?.accepted ? { already_done: true, identity: { number: page.number }, evidence: "Already accepted." } : undefined;
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
        await ctx.reveal("Press Accept.");

        return wait_for_person(ctx, "accept", async () => {
          const page = await ctx.ask("state");

          return page?.accepted ? { identity: { number: page.number }, evidence: "Accepted by hand." } : null;
        });
      },
    },
    {
      name: "capture",
      async run(ctx) {
        const page = await ctx.ask("state");

        if (!page?.accepted) throw new AdapterError(UNKNOWN_OUTCOME, "Accept was pressed but the page does not show it accepted.");

        return { data: { identity: { number: page.number }, evidence: "Accepted." } };
      },
    },
  ],
};

/** Verification: open and look, never act. */
const VERIFY = {
  submit_invoice: () => [
    open,
    {
      name: "look",
      async run(ctx) {
        const found = await ctx.ask("find_invoice", { total_cents: ctx.job.expected_total_cents });

        return found?.invoice
          ? { verdict: "found", identity: identity_of(ctx, found.invoice), evidence: `${found.invoice.number} is there.` }
          : { verdict: "absent", evidence: "No invoice with the expected total is on the work order." };
      },
    },
  ],

  accept: () => [
    open,
    {
      name: "look",
      async run(ctx) {
        const page = await ctx.ask("state");

        return page?.accepted
          ? { verdict: "found", identity: { number: page.number }, evidence: "It is accepted." }
          : { verdict: "absent", evidence: "It is not accepted." };
      },
    },
  ],
};

/**
 * A commit step left to a person: poll for what their click produced, renewing
 * the lease while waiting, until it appears or the wait runs out — which is
 * reported as unknown, because they may yet press it.
 */
async function wait_for_person(ctx, step, look) {
  const deadline = ctx.now() + PERSON_WAIT_MS;

  while (ctx.now() < deadline) {
    const seen = await look();

    if (seen) return { data: seen };

    await ctx.sleep(PERSON_POLL_MS);
    await ctx.touch(step);
  }

  throw new AdapterError(UNKNOWN_OUTCOME, "Nobody pressed the button in time.");
}

export default {
  ...manifest,

  async session(env) {
    const site = await env.local.get(SITE_KEY);

    return { state: site?.signed_in === false ? "expired" : "live", account_hint: "fixture" };
  },

  plan(job) {
    const plan = PLANS[job.operation];

    if (!plan) throw new Error(`The fixture adapter cannot ${job.operation}.`);

    return plan();
  },

  verify_plan(job) {
    const plan = VERIFY[job.operation];

    if (!plan) throw new Error(`The fixture adapter cannot verify ${job.operation}.`);

    return plan();
  },

  parse_url(url) {
    const match = /[?&]wo=([^&#]+)(?:#invoice-(\d+))?/.exec(String(url || ""));

    return match ? { number: decodeURIComponent(match[1]), id: match[2] || null } : null;
  },
};
