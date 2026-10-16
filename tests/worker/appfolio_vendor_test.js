/**
 * The appfolio_vendor adapter (roadmap phase 9), against the fake web app and
 * a pretend vendor portal kept in the same books the fixture pages use
 * (adapters/appfolio_vendor/site/portal.js).
 *
 * Two halves. The rules: each operation does its one press, finds what an
 * earlier attempt left instead of pressing again, and refuses what legacy
 * refused — a test connection on a work order whose live description lacks
 * the marker, an invoice over the property's maintenance limit, a page that
 * totals differently from the web app, a note short of its photographs.
 *
 * Then the acceptance: the kill loop over all four operations. The worker is
 * killed after every single operation of a job, then twice at random, at
 * least 100 runs each, then with the browser closed instead — and the portal
 * must end up holding each thing exactly once, or an invoice nobody can vouch
 * for must go to a person. No duplicate note and no duplicate invoice, ever.
 */

import { SESSION_KEY } from "../../adapters/appfolio_vendor/adapter.js";
import { save_note, submit_invoice } from "../../adapters/appfolio_vendor/site/portal.js";
import { STOP_AFTER_PRESS_KEY } from "../../worker/job.js";
import { INVOICE, INVOICE_TOTAL, leftovers, reports, seeded, settle, tick, vendor_world } from "../support/scenario.js";

const OPERATIONS = ["accept", "post_photos", "submit_invoice", "mark_work_done"];
const RUNS = 100;

/** How many times the portal was made to do this operation's thing. */
function pressed(order, operation) {
  return { accept: order.accepts, post_photos: order.note_saves, submit_invoice: order.submits, mark_work_done: order.work_dones }[operation];
}

function opened(life) {
  return life.trace.filter((name) => name === "tabs.open").length;
}

async function operations_in_a_job(operation) {
  const { world } = await vendor_world({ operation });
  const { life } = await tick(world);

  return life.ops;
}

function judge(t, world, order, delivery, operation, label) {
  const count = pressed(order, operation);
  const left = leftovers(world);

  t.ok(count <= 1, `${label}: the portal did it ${count} times`);
  t.equal(left.job, false, `${label}: a job was left in hand`);
  t.equal(left.outbox, 0, `${label}: reports were left unsent`);

  if (delivery.status === "succeeded") {
    t.equal(count, 1, `${label}: succeeded without the portal holding it`);

    return delivery.history.some((h) => h.endsWith("->outcome_unknown")) ? "succeeded after verification" : "succeeded";
  }

  /* Only an invoice may end with a person, and only after looking. */
  t.equal(operation, "submit_invoice", `${label}: ended ${delivery.status}`);
  t.equal(delivery.status, "needs_manual", `${label}: ended ${delivery.status}`);
  t.equal(count, 0, `${label}: handed to a person although the portal holds it`);
  t.equal(delivery.last_error, "verified_absent", `${label}: handed to a person without a verification`);

  return "verified absent, for a person";
}

async function kill_loop(t, operation) {
  const total = await operations_in_a_job(operation);
  const random = seeded(11 + operation.length);
  const tally = {};
  let runs = 0;

  const run = async (kills, label) => {
    const { world, delivery, order } = await vendor_world({ operation });

    for (const after of kills) {
      const { outcome } = await tick(world, { kill_after: after });

      if (outcome !== "killed") break;
    }

    await settle(world, delivery, 20);

    const ended = judge(t, world, order, delivery, operation, label);

    tally[ended] = (tally[ended] || 0) + 1;
    runs++;
  };

  for (let k = 1; k <= total; k++) await run([k], `${operation}, killed after operation ${k}`);

  while (runs < RUNS) {
    const first = 1 + Math.floor(random() * total);
    const second = 1 + Math.floor(random() * total);

    await run([first, second], `${operation}, killed after ${first} then ${second}`);
  }

  return { total, runs, tally };
}

export default {
  // -- One press each -----------------------------------------------------------

  async "accept presses Accept once and captures the vendor portal's id"(t) {
    const { world, delivery, order } = await vendor_world({ operation: "accept" });

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(order.accepts, 1);
    t.equal(order.status, "Available");
    t.deep(reports(world, delivery)[0].identity, { id: order.id, url: `https://vendor.appfolio.com/2433209/workOrders/${order.id}` });
  },

  async "a work order already Available is not accepted again, and its id is still captured"(t) {
    const { world, delivery, order } = await vendor_world({ operation: "accept", order: { status: "Available" } });

    const run = await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(order.accepts, 0);
    t.equal(run.life.trace.includes("page.send:accept"), false);
    t.equal(reports(world, delivery)[0].identity.id, order.id);
  },

  async "a note carries every photograph the web app named, fetched by the holder"(t) {
    const { world, delivery, order } = await vendor_world({ operation: "post_photos", photos: 4 });

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.deep(order.notes, [{ body: "Photos 1–4 of 4", photos: 4 }]);
    t.equal(world.server.photos_served, 4);
    t.equal(reports(world, delivery)[0].identity, null, "a note sent an identity, which would overwrite nothing but means nothing");
  },

  async "a note already posted is found by its words, not posted twice"(t) {
    const { world, delivery, order } = await vendor_world({ operation: "post_photos" });

    save_note(world.vendor, order.id, "Photos 1–3 of 3", 3);

    const run = await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(order.note_saves, 1);
    t.equal(run.life.trace.includes("page.send:save_note"), false);
    t.equal(world.server.photos_served || 0, 0, "photographs were fetched for a note already there");
  },

  async "a note the portal took short of its photographs is never saved"(t) {
    /* The pretend portal, like AppFolio's, takes ten to a note. */
    const { world, delivery, order } = await vendor_world({ operation: "post_photos", photos: 12 });

    await settle(world, delivery, 30);

    t.equal(order.note_saves, 0, "a short note was saved");
    t.equal(delivery.status, "needs_manual");
    t.equal(delivery.last_error, "transient");
  },

  async "an invoice is typed as handed over and submitted once"(t) {
    const { world, delivery, order } = await vendor_world();

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(order.submits, 1);
    t.equal(order.invoices[0].total_cents, INVOICE_TOTAL);
    t.deep(order.invoices[0].lines, INVOICE.invoice.items.map(({ description, quantity, rate }) => ({ description, quantity, rate })));
    t.deep(reports(world, delivery)[0].identity, { number: order.invoices[0].number, url: `https://vendor.appfolio.com/2433209/workOrders/${order.id}/invoices` });
  },

  async "an invoice already on the work order is completed, not submitted again"(t) {
    const { world, delivery, order } = await vendor_world();

    submit_invoice(world.vendor, order.id, INVOICE.invoice.items);

    const run = await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(order.submits, 1);
    t.equal(run.life.trace.includes("page.send:submit_invoice"), false);
  },

  async "Work Done is pressed once, and a settled work order is left alone"(t) {
    const first = await vendor_world({ operation: "mark_work_done" });

    await tick(first.world);

    t.equal(first.delivery.status, "succeeded");
    t.equal(first.order.work_dones, 1);
    t.equal(first.order.status, "Under Review");

    const second = await vendor_world({ operation: "mark_work_done", order: { status: "Payment Pending" } });

    await tick(second.world);

    t.equal(second.delivery.status, "succeeded");
    t.equal(second.order.work_dones, 0);
  },

  // -- What is refused ------------------------------------------------------------

  async "an invoice over the property's maintenance limit is held for a person unless the connection says send"(t) {
    const held = await vendor_world({ order: { limit_cents: 10000 } });

    await tick(held.world);

    t.equal(held.order.submits, 0);
    t.equal(held.delivery.status, "needs_manual");
    t.equal(held.delivery.last_error, "permanent");

    const sent = await vendor_world({ order: { limit_cents: 10000 }, connection: { on_over_limit: "send" } });

    await tick(sent.world);

    t.equal(sent.order.submits, 1);
    t.equal(sent.delivery.status, "succeeded");
  },

  async "a page that totals differently from the web app is never submitted"(t) {
    const { world, delivery, order } = await vendor_world({ expected_total_cents: INVOICE_TOTAL + 1 });

    await tick(world);

    t.equal(order.submits, 0);
    t.equal(delivery.status, "needs_manual");
    t.equal(delivery.committed_at, null);
  },

  async "a line whose Amount differs is never submitted, even when the total agrees"(t) {
    const items = INVOICE.invoice.items.map((item, i) => ({ ...item, expected_total_cents: item.expected_total_cents + (i === 0 ? 1 : -1) }));
    const { world, delivery, order } = await vendor_world({ payload: { invoice: { items } } });

    await tick(world);

    t.equal(order.submits, 0);
    t.equal(delivery.status, "needs_manual");
  },

  async "a test connection refuses a work order whose live description lacks the marker"(t) {
    for (const operation of OPERATIONS) {
      const { world, delivery, order } = await vendor_world({ operation, order: { description: "Replace the kitchen faucet." } });

      await tick(world);

      t.equal(pressed(order, operation), 0, `${operation} pressed on an unmarked work order`);
      t.equal(delivery.status, "needs_manual", operation);
    }
  },

  async "a live connection refuses a work order whose live description carries the marker"(t) {
    const { world, delivery, order } = await vendor_world({ connection: { scope: "live" } });

    await tick(world);

    t.equal(order.submits, 0);
    t.equal(delivery.status, "needs_manual");
  },

  async "a work order on no tab of the list is a refusal, not a guess"(t) {
    const { world, delivery, order } = await vendor_world({ link: { number: "99999-9" } });

    await tick(world);

    t.equal(order.submits, 0);
    t.equal(delivery.status, "needs_manual");
  },

  async "a remembered address that now shows another work order is found again by number"(t) {
    const { world, delivery, order } = await vendor_world({ link: { url: "https://vendor.appfolio.com/2433209/workOrders/999" } });
    const other = world.vendor;

    other.orders["999"] = { ...order, id: "999", number: "11111-1", invoices: [], notes: [], submits: 0 };

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(order.submits, 1);
    t.equal(other.orders["999"].submits, 0, "the invoice went on the work order the stale address shows");
  },

  async "a step that only makes sense on an accepted job refuses one still waiting to be accepted"(t) {
    const { world, delivery, order } = await vendor_world({ operation: "post_photos", order: { status: "Accept/Reject" } });

    await tick(world);

    t.equal(order.note_saves, 0);
    t.equal(delivery.status, "needs_manual");
  },

  // -- The switches ---------------------------------------------------------------

  async "a dry run prepares the note, then gives it back unsaved"(t) {
    const { world, delivery, order } = await vendor_world({ operation: "post_photos", connection: { dry_run: true } });

    await tick(world);

    t.equal(order.note_saves, 0);
    t.equal(world.server.photos_served, 3, "the rehearsal did not attach the photographs");
    t.equal(delivery.status, "retry_scheduled");
    t.equal(delivery.attempt_count, 0);
  },

  async "a hands-off connection leaves Submit Invoice to a person"(t) {
    const { world, delivery, order } = await vendor_world({ connection: { auto_submit: false } });

    const person = (env) => ({
      ...env,
      tabs: {
        ...env.tabs,
        async reveal(tab_id) {
          await env.tabs.reveal(tab_id);
          submit_invoice(world.vendor, order.id, world.tabs.get(tab_id).form);
        },
      },
    });

    const run = await tick(world, { wrap: person });

    t.equal(run.life.trace.includes("page.send:submit_invoice"), false, "the worker pressed Submit Invoice itself");
    t.equal(order.submits, 1);
    t.equal(delivery.status, "succeeded");
  },

  // -- The session ----------------------------------------------------------------

  async "a browser signed out of the portal claims nothing and leaves no tab open"(t) {
    const { world, delivery, order } = await vendor_world();

    world.vendor.signed_in = false;
    await tick(world);

    t.equal(delivery.status, "pending");
    t.equal(order.submits, 0);
    t.equal(world.tabs.size, 0, "the probe tab was left open");
    t.equal(world.local.get(SESSION_KEY)?.state, "expired");
  },

  async "a fresh session is not probed again, and a stale one is"(t) {
    const { world } = await vendor_world();

    world.vendor.signed_in = false;
    await tick(world);

    world.clock.ms += 60000;
    const soon = await tick(world);

    t.equal(opened(soon.life), 0, "a probe tab opened a minute after the last");

    world.clock.ms += 4 * 60000;
    const later = await tick(world);

    t.ok(opened(later.life) >= 1, "no probe tab after the cached answer went stale");
  },

  async "a vendor page a person opened counts, and spares the probe"(t) {
    const { world, delivery } = await vendor_world();

    world.local.set(SESSION_KEY, { state: "live", account: "2433209", at: world.clock.ms });

    const run = await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(opened(run.life), 1, "a probe tab opened beside the job's own");
  },

  async "a job that finds the browser signed out forgets the cached session at once"(t) {
    const { world, delivery } = await vendor_world();

    world.local.set(SESSION_KEY, { state: "live", account: "2433209", at: world.clock.ms });
    world.vendor.signed_in = false;
    await tick(world);

    t.equal(delivery.last_error, "session_expired");
    t.equal(delivery.attempt_count, 0, "a sign-out spent an attempt");
    t.equal(world.local.get(SESSION_KEY)?.state, "expired");
  },

  async "armed from Troubleshooting, a press is followed by a dead stop, and verification recovers it"(t) {
    const { world, delivery, order } = await vendor_world();

    world.local.set(STOP_AFTER_PRESS_KEY, 1);

    const stopped = await tick(world);

    t.equal(order.submits, 1, "the press happened");
    t.equal(delivery.status, "committing", "and nothing was reported");
    t.equal(world.local.has(STOP_AFTER_PRESS_KEY), false, "the switch is spent");

    await settle(world, delivery);

    t.equal(stopped.life.trace.filter((name) => name === "page.send:submit_invoice").length, 1);
    t.equal(order.submits, 1, "pressed again after the stop");
    t.equal(delivery.status, "succeeded");
    t.ok(delivery.history.includes("committing->outcome_unknown"), `never went through outcome_unknown: ${delivery.history}`);
  },

  // -- The acceptance -------------------------------------------------------------

  async "killing the worker after any operation never accepts, notes, invoices or marks done twice"(t) {
    for (const operation of OPERATIONS) {
      const { total, runs, tally } = await kill_loop(t, operation);

      t.ok(runs >= RUNS, `${operation}: only ${runs} runs`);
      t.ok(total >= 10, `${operation}: a job should take more than ${total} operations`);
      if (operation !== "submit_invoice") t.equal(tally["verified absent, for a person"] ?? 0, 0, `${operation} was handed to a person`);

      globalThis.__kill_loop_report?.push({ operation: `appfolio_vendor ${operation}`, total, runs, tally });
    }
  },

  async "closing the browser at any point of any operation is recovered when the lease runs out"(t) {
    for (const operation of OPERATIONS) {
      const total = await operations_in_a_job(operation);

      for (let k = 1; k <= total; k++) {
        const { world, delivery, order } = await vendor_world({ operation });
        const { outcome } = await tick(world, { kill_after: k });

        if (outcome === "killed") {
          world.close_browser();
          world.clock.ms += 121000;
        }

        await settle(world, delivery, 20);
        judge(t, world, order, delivery, operation, `${operation}, browser closed after operation ${k}`);
      }
    }
  },
};
