/**
 * The phase 7 acceptance, against the fake web app: killing the service
 * worker anywhere in a job never makes the platform do it twice.
 *
 * A job's operations are counted in an undisturbed run first. Then the job is
 * run again from scratch once per operation, with the worker killed straight
 * after that operation, and left to the alarm to finish. Then again with two
 * kills, at seeded random points, until there are at least 100 runs per
 * operation. Then once per operation with the *browser* closed instead —
 * storage.session and the tabs gone, so only the server's lease expiring can
 * recover it.
 *
 * Every run must end with the platform holding exactly one invoice (or
 * acceptance), or none and the delivery waiting for a person **because a
 * verification looked and found nothing** — the one case where an unknown
 * outcome is not settled automatically, by design, for an invoice. Nothing may
 * be left in hand or in the outbox.
 *
 * tests/e2e.mjs runs the same loop against the real web app.
 */

import {
  leftovers,
  seeded,
  settle,
  tick,
  world_with_job,
} from "../support/scenario.js";

const OPERATIONS = ["submit_invoice", "accept"];
const RUNS = 100;

function platform_count(world, operation) {
  const order = world.site.orders["WO-000001"];

  return operation === "submit_invoice" ? order?.submits ?? 0 : order?.accepts ?? 0;
}

/** The operation count of one undisturbed job, from the first tick. */
async function operations_in_a_job(operation) {
  const { world } = await world_with_job({ operation });
  const { life } = await tick(world);

  return life.ops;
}

/** Check a finished run; returns how it ended. */
function judge(t, world, delivery, operation, label) {
  const count = platform_count(world, operation);
  const left = leftovers(world);

  t.ok(count <= 1, `${label}: the platform did it ${count} times`);
  t.equal(left.job, false, `${label}: a job was left in hand`);
  t.equal(left.outbox, 0, `${label}: reports were left unsent`);

  if (delivery.status === "succeeded") {
    t.equal(count, 1, `${label}: succeeded without the platform holding it`);

    return delivery.history.includes("committing->outcome_unknown") || delivery.history.includes("claimed->outcome_unknown")
      ? "succeeded after verification"
      : "succeeded";
  }

  t.equal(delivery.status, "needs_manual", `${label}: ended ${delivery.status}`);
  t.equal(count, 0, `${label}: handed to a person although the platform holds it`);
  t.equal(delivery.last_error, "verified_absent", `${label}: handed to a person without a verification`);

  return "verified absent, for a person";
}

async function kill_loop(t, operation) {
  const total = await operations_in_a_job(operation);
  const random = seeded(7 + operation.length);
  const tally = {};
  let runs = 0;

  const run = async (kills, label) => {
    const { world, delivery } = await world_with_job({ operation });

    for (const after of kills) {
      const { outcome } = await tick(world, { kill_after: after });

      if (outcome !== "killed") break;
    }

    await settle(world, delivery);

    const ended = judge(t, world, delivery, operation, label);

    tally[ended] = (tally[ended] || 0) + 1;
    runs++;
  };

  for (let k = 1; k <= total; k++) await run([k], `${operation}, killed after operation ${k}`);

  while (runs < RUNS) {
    const first = 1 + Math.floor(random() * total);
    const second = 1 + Math.floor(random() * total);

    await run([first, second], `${operation}, killed after ${first} then ${second}`);
  }

  t.ok(total >= 10, `a job should take more than ${total} operations`);

  return { total, runs, tally };
}

export default {
  async "an undisturbed job submits one invoice and leaves nothing behind"(t) {
    const { world, delivery } = await world_with_job();

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(world.site.orders["WO-000001"].submits, 1);
    t.equal(world.site.orders["WO-000001"].invoices[0].total_cents, 10497);
    t.deep(leftovers(world), { job: false, outbox: 0 });
  },

  async "killing the worker after any operation never submits an invoice twice"(t) {
    const { total, runs, tally } = await kill_loop(t, "submit_invoice");

    t.ok(runs >= RUNS, `only ${runs} runs`);
    t.ok(tally["succeeded after verification"] > 0, "no run needed a verification, so the loop never killed past the commit point");
    globalThis.__kill_loop_report?.push({ operation: "submit_invoice", total, runs, tally });
  },

  async "killing the worker after any operation never accepts twice"(t) {
    const { total, runs, tally } = await kill_loop(t, "accept");

    t.ok(runs >= RUNS, `only ${runs} runs`);
    /* accept trusts a negative, so nothing ever needs a person. */
    t.equal(tally["verified absent, for a person"] ?? 0, 0, "an accept was handed to a person");
    globalThis.__kill_loop_report?.push({ operation: "accept", total, runs, tally });
  },

  async "closing the browser at any point is recovered when the lease runs out"(t) {
    for (const operation of OPERATIONS) {
      const total = await operations_in_a_job(operation);

      for (let k = 1; k <= total; k++) {
        const { world, delivery } = await world_with_job({ operation });
        const { outcome } = await tick(world, { kill_after: k });

        if (outcome === "killed") {
          world.close_browser();
          world.clock.ms += 121000;
        }

        await settle(world, delivery);
        judge(t, world, delivery, operation, `${operation}, browser closed after operation ${k}`);
      }
    }
  },

  async "a click whose result was never recorded is verified, not repeated"(t) {
    const { world, delivery } = await world_with_job();

    /* Find the operation that pressed Submit, and die straight after it. */
    const { life } = await tick((await world_with_job()).world);
    const click = life.trace.indexOf("page.send:submit") + 1;

    t.ok(click > 0, "could not find the submit in the trace");

    const killed = await tick(world, { kill_after: click });

    t.equal(killed.outcome, "killed");
    t.equal(world.site.orders["WO-000001"].submits, 1, "the click did not happen before the kill");

    const resumed = await tick(world);

    t.equal(resumed.life.trace.includes("page.send:submit"), false, "the resumed worker pressed Submit again");
    t.equal(world.site.orders["WO-000001"].submits, 1);

    await settle(world, delivery);

    t.equal(delivery.status, "succeeded");
    t.ok(delivery.history.includes("committing->outcome_unknown"), `never went through outcome_unknown: ${delivery.history}`);
    t.equal(world.site.orders["WO-000001"].submits, 1);
  },
};
