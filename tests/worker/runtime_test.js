/**
 * The runtime's other rules, against the fake web app: the safe defaults, the
 * incident switches at the commit point, a person's button, the heartbeat.
 */

import { SITE_KEY, submit_invoice } from "../../adapters/fixture/site/ledger.js";
import { STATUS_KEY } from "../../worker/runtime.js";
import { INVOICE, INVOICE_TOTAL, leftovers, settle, tick, world_with_job } from "../support/scenario.js";

const order = (world) => world.site.orders["WO-000001"] || { submits: 0, accepts: 0, invoices: [] };

export default {
  async "a browser just signed in claims on its first tick"(t) {
    const { world, delivery } = await world_with_job();

    /* The first heartbeat cannot report a session for a connection it has not
       heard of yet; the runtime beats again at once rather than idling a
       minute. */
    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(world.server.requests.filter((r) => r.path === "/api/worker/heartbeat").length, 2);
  },

  async "a connection that says nothing about dry_run rehearses"(t) {
    const { world, delivery } = await world_with_job({ connection: { dry_run: undefined } });

    await tick(world);

    t.equal(order(world).submits, 0, "a connection with no dry_run submitted");
    t.equal(delivery.status, "retry_scheduled");
    t.equal(delivery.attempt_count, 0, "a rehearsal spent an attempt");
    t.equal(delivery.committed_at, null, "a rehearsal committed");
  },

  async "a rehearsed job is not rehearsed again until its figures change"(t) {
    const { world, delivery } = await world_with_job({ connection: { dry_run: true } });

    await tick(world);
    world.clock.ms += 61000;

    const second = await tick(world);

    t.equal(second.life.trace.includes("tabs.open"), false, "the same job was opened again");
    t.equal(order(world).submits, 0);
    t.equal(delivery.status, "retry_scheduled");
  },

  async "a connection that does not say auto_submit leaves the button to a person"(t) {
    const { world, delivery } = await world_with_job({ connection: { auto_submit: undefined } });

    /* The person: when the tab is put in front of them, they press Submit. */
    const person = (env) => ({
      ...env,
      tabs: {
        ...env.tabs,
        async reveal(tab_id) {
          await env.tabs.reveal(tab_id);
          submit_invoice(world.site, "WO-000001", world.tabs.get(tab_id).form);
        },
      },
    });

    const run = await tick(world, { wrap: person });

    t.equal(run.life.trace.includes("page.send:submit"), false, "the worker pressed Submit itself");
    t.equal(order(world).submits, 1);
    t.equal(delivery.status, "succeeded");
  },

  async "a person who never presses is an unknown outcome, and a verification finds nothing"(t) {
    const { world, delivery } = await world_with_job({ connection: { auto_submit: false } });

    await tick(world);
    await settle(world, delivery);

    t.equal(order(world).submits, 0);
    t.equal(delivery.status, "needs_manual");
    t.equal(delivery.last_error, "verified_absent");
  },

  async "a total that disagrees with the server's is never submitted"(t) {
    const { world, delivery } = await world_with_job({ expected_total_cents: INVOICE_TOTAL + 1 });

    await tick(world);

    t.equal(order(world).submits, 0);
    t.equal(delivery.status, "needs_manual");
    t.equal(delivery.last_error, "permanent");
    t.equal(delivery.committed_at, null);
  },

  async "a connection paused while the job was filled gives it back untouched"(t) {
    const { world, delivery } = await world_with_job();
    const handle = world.server.handle;

    world.server.handle = (method, path, headers, text) => {
      if (path.endsWith("/commit")) world.server.connection.paused = true;

      return handle(method, path, headers, text);
    };

    await tick(world);

    t.equal(order(world).submits, 0);
    t.equal(delivery.status, "retry_scheduled");
    t.equal(delivery.attempt_count, 0, "giving it back spent an attempt");
    t.deep(leftovers(world), { job: false, outbox: 0 });
  },

  async "an invoice an earlier attempt left is completed, not submitted again"(t) {
    const { world, delivery } = await world_with_job();

    submit_invoice(world.site, "WO-000001", INVOICE.invoice.items);

    const run = await tick(world);

    t.equal(run.life.trace.includes("page.send:submit"), false);
    t.equal(order(world).submits, 1);
    t.equal(delivery.status, "succeeded");
    t.equal(delivery.committed_at, null, "it committed to find what was already there");
  },

  async "a browser signed out of the platform claims nothing"(t) {
    const { world, delivery } = await world_with_job();

    world.local.set(SITE_KEY, { signed_in: false });
    await tick(world);

    t.equal(delivery.status, "pending");
    t.equal(world.local.get(STATUS_KEY).connections[0].reason, "session_not_live");
  },

  async "switching processing off stops claiming, and tells the web app"(t) {
    const { world, delivery } = await world_with_job();

    world.local.set("ash_worker_processing", false);
    await tick(world);

    t.equal(delivery.status, "pending");
    t.equal([...world.server.workers.values()][0].processing, false);
  },

  async "a build the web app refuses claims nothing and says so"(t) {
    const { world, delivery } = await world_with_job();

    world.server.version = "something-else";
    await tick(world);

    t.equal(delivery.status, "pending");
    t.equal(world.local.get(STATUS_KEY).state, "outdated");
  },

  async "a job whose tab a person closed before the commit is given back"(t) {
    const { world, delivery } = await world_with_job();
    const closer = (env) => ({
      ...env,
      page: {
        async send(tab_id, command, args, options) {
          if (command === "fill_invoice") world.tabs.delete(tab_id);

          return env.page.send(tab_id, command, args, options);
        },
      },
    });

    await tick(world, { wrap: closer });

    t.equal(order(world).submits, 0);
    t.equal(delivery.status, "retry_scheduled");
    t.equal(delivery.attempt_count, 0);
  },
};
