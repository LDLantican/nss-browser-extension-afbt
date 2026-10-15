/**
 * Building and driving a world for the worker's tests: a fake web app with
 * jobs waiting, a browser signed in to it, and service-worker lives that can
 * be killed after any operation (tests/support/fake_env.js).
 */

import fixture from "../../adapters/fixture/adapter.js";
import { JOB_KEY } from "../../worker/job.js";
import { OUTBOX_KEY } from "../../worker/outbox.js";
import { create_registry } from "../../worker/registry.js";
import { create_runtime } from "../../worker/runtime.js";
import { create_life, create_world } from "./fake_env.js";
import { create_fake_server } from "./fake_server.js";

/** Two lines AppFolio would total at $104.97: 1.5 × 58.50 and 3 × 5.74. */
export const INVOICE = {
  invoice: {
    items: [
      { description: "Labor: Hang door", quantity: "1.5", rate: "58.50", expected_total_cents: 8775 },
      { description: "Material: Hinges", quantity: "3", rate: "5.74", expected_total_cents: 1722 },
    ],
  },
};

export const INVOICE_TOTAL = 10497;

export const TERMINAL = new Set(["succeeded", "needs_manual", "cancelled"]);

export function registry() {
  return create_registry([fixture]);
}

/** A world with a fake web app, signed in, and one job of `operation` waiting. */
export async function world_with_job({ operation = "submit_invoice", connection = {}, expected_total_cents = INVOICE_TOTAL } = {}) {
  const world = create_world();

  world.server = create_fake_server(world, { version: world.version });
  Object.assign(world.server.connection, connection);

  const { env } = create_life(world);
  const signed = await create_runtime(env, registry()).sign_in({
    email: world.server.person.email,
    password: world.server.person.password,
    device_name: "Test",
  });

  if (!signed.ok) throw new Error(`sign-in failed: ${signed.status}`);

  const delivery = world.server.enqueue({
    operation,
    public_id: "WO-000001",
    payload: operation === "submit_invoice" ? { work_order: { public_id: "WO-000001" }, ...INVOICE } : { work_order: { public_id: "WO-000001" } },
    expected_total_cents: operation === "submit_invoice" ? expected_total_cents : null,
  });

  return { world, delivery };
}

/**
 * One tick in a life that dies after operation `kill_after` (or never).
 * Resolves `"done"` or `"killed"` — a killed tick's own promise never settles.
 */
export async function tick(world, { kill_after = null, wrap = null } = {}) {
  const { env, life } = create_life(world, { kill_after });
  const runtime = create_runtime(wrap ? wrap(env) : env, registry());
  const outcome = await Promise.race([runtime.tick("test").then(() => "done"), life.died.then(() => "killed")]);

  return { outcome, life, runtime };
}

/**
 * Tick, a minute apart, until the delivery is finished or `max` ticks pass —
 * the alarm doing its job after whatever a test did to the last worker.
 */
export async function settle(world, delivery, max = 12) {
  for (let i = 0; i < max && !TERMINAL.has(delivery.status); i++) {
    await tick(world);
    world.clock.ms += 61000;
  }

  /* Whatever is still in the outbox goes out on the next tick. */
  await tick(world);

  return delivery.status;
}

/** Nothing left behind: no job in hand, nothing waiting to be sent. */
export function leftovers(world) {
  return {
    job: world.session.has(JOB_KEY),
    outbox: (world.local.get(OUTBOX_KEY) || []).length,
  };
}

/** A small seeded random, so a failing run can be run again exactly. */
export function seeded(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;

    return state / 2 ** 32;
  };
}
