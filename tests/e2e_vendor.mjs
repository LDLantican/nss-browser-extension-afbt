/**
 * The vendor adapter's kill loop against the real web app (roadmap phase 9).
 *
 * Started by the web app's tests/integration/vendor_extension_test.php, which
 * has started a `php -S` server on its test database and seeded an operator
 * and a connection running `appfolio_vendor`:
 *
 *   node tests/e2e_vendor.mjs --base=http://127.0.0.1:PORT --version=test-harness
 *     --email=... --password=... --connection=ID
 *     --php=/path/to/php --fixture=/path/to/tests/integration/fixtures/extension.php
 *     --root=/path/to/the/web/app [--runs=10] [--photos=12]
 *
 * Each run is one approved job with real photographs on disk and the chain
 * Approve queues — accept, a note per ten photographs, the invoice, Work Done
 * — worked by the extension's own runtime and appfolio_vendor adapter over
 * HTTP, against the pretend vendor portal (adapters/appfolio_vendor/site/
 * portal.js). Only Chrome and AppFolio are pretend.
 *
 * A whole chain is several hundred operations, and this web app pays a disk
 * flush per commit, so it is not killed after every one of them as the
 * fixture loop is (tests/e2e.mjs): the undisturbed chain is traced first, and
 * the runs kill it just before and just after each of the five presses —
 * where a duplicate would come from — then at seeded random points, then a
 * few with the browser closed. Every run must end with the portal holding
 * one acceptance, one note per part with nothing said twice, at most one
 * invoice and one Work Done, and the vendor link `linked` with the portal's
 * id; or the invoice with a person after a verification found nothing.
 *
 * Prints one JSON summary line and exits 0 when every run held.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dispatch } from "../adapters/appfolio_vendor/site/portal.js";
import { create_life, create_world } from "./support/fake_env.js";
import { registry, seeded } from "./support/scenario.js";
import { create_runtime } from "../worker/runtime.js";
import { JOB_KEY } from "../worker/job.js";
import { OUTBOX_KEY } from "../worker/outbox.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");

    return [key, rest.join("=")];
  }),
);

const RUNS = Number(args.runs || 10);
const PHOTOS = Number(args.photos || 12);
const CLOSED_BROWSER_RUNS = 2;
const PRESSES = ["page.send:accept", "page.send:save_note", "page.send:submit_invoice", "page.send:work_done"];
const MOVING = new Set(["pending", "claimed", "committing", "retry_scheduled", "outcome_unknown"]);

function web_app() {
  const child = spawn(args.php, ["-d", "variables_order=EGPCS", args.fixture, "serve", args.connection], {
    cwd: args.root,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = [];

  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.(JSON.parse(line)));

  return {
    ask: (command) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        child.stdin.write(`${JSON.stringify(command)}\n`);
      }),
    close: () => child.stdin.end(),
  };
}

const world = create_world({ base: args.base, version: args.version, fetch: (url, init) => fetch(url, init) });

async function tick({ kill_after = null } = {}) {
  const { env, life } = create_life(world, { kill_after });
  const runtime = create_runtime(env, registry());
  const outcome = await Promise.race([runtime.tick("e2e").then(() => "done"), life.died.then(() => "killed")]);

  return { outcome, life };
}

/** A job on the web app, and the same work order dispatched on the pretend portal. */
async function new_job(app) {
  const job = await app.ask({ do: "vendor_job", photos: PHOTOS });

  if (job.error) throw new Error(`vendor_job: ${job.error}`);

  const order = dispatch(world.vendor, { number: job.number, status: "Accept/Reject", description: job.marker });

  return { job, order };
}

/** Still going: anything waiting or held, unless it waits behind a step a person now has. */
function moving(chain) {
  const stuck = chain.deliveries.some((d) => d.status === "needs_manual");

  return chain.deliveries.some((d) => (stuck ? d.status !== "pending" && MOVING.has(d.status) : MOVING.has(d.status)));
}

async function settle(app, job_id) {
  let chain = await app.ask({ do: "chain", job_id });

  for (let i = 0; i < 40 && moving(chain); i++) {
    if (chain.deliveries.some((d) => ["claimed", "committing"].includes(d.status)) && !world.session.has(JOB_KEY))
      await app.ask({ do: "chain_expire", job_id });

    await app.ask({ do: "chain_due", job_id });
    await tick();
    world.clock.ms += 61000;
    chain = await app.ask({ do: "chain", job_id });
  }

  if (world.session.has(JOB_KEY) || (world.local.get(OUTBOX_KEY) || []).length > 0) {
    await tick();
    chain = await app.ask({ do: "chain", job_id });
  }

  return chain;
}

function judge(chain, order, label, problems) {
  const counts = { accepts: order.accepts, notes: order.note_saves, submits: order.submits, work_dones: order.work_dones };
  const wrong = (why) => problems.push(`${label}: ${why} (${JSON.stringify({ counts, chain: chain.deliveries.map((d) => `${d.operation}#${d.part}:${d.status}`) })})`);
  const bodies = order.notes.map((note) => note.body);
  const parts = chain.deliveries.filter((d) => d.operation === "post_photos").length;
  const status = Object.fromEntries(chain.deliveries.map((d) => [`${d.operation}#${d.part}`, d]));

  if (order.accepts > 1) wrong(`accepted ${order.accepts} times`);
  if (new Set(bodies).size !== bodies.length) wrong(`a note was posted twice: ${bodies.join(" / ")}`);
  if (order.submits > 1) wrong(`the invoice was submitted ${order.submits} times`);
  if (order.work_dones > 1) wrong(`Work Done was pressed ${order.work_dones} times`);
  if (world.session.has(JOB_KEY)) wrong("a job was left in hand");
  if ((world.local.get(OUTBOX_KEY) || []).length > 0) wrong("reports were left unsent");
  if (chain.link?.link_status !== "linked" || chain.link?.external_id !== order.id) wrong(`the vendor link is ${JSON.stringify(chain.link)}`);

  if (chain.deliveries.every((d) => d.status === "succeeded")) {
    if (order.accepts !== 1 || bodies.length !== parts || order.submits !== 1 || order.work_dones !== 1) wrong("succeeded without the portal holding everything");
    if (chain.invoice_links !== 1) wrong(`${chain.invoice_links} invoice links recorded`);

    return chain.deliveries.some((d) => d.verifications > 0) ? "succeeded after verification" : "succeeded";
  }

  const invoice = status["submit_invoice#1"];

  if (invoice?.status !== "needs_manual") {
    wrong("ended with something other than the invoice waiting for a person");

    return "wrong";
  }

  if (order.submits !== 0) wrong("handed to a person although the portal holds the invoice");
  if (invoice.last_error !== "verified_absent" || invoice.verifications === 0) wrong("handed to a person without a verification");
  if (order.work_dones !== 0) wrong("Work Done was pressed on a job whose invoice is with a person");

  return "invoice verified absent, for a person";
}

const app = web_app();
const problems = [];
let crashed = false;
const tally = {};
let runs = 0;
let points = [];

try {
  const { env } = create_life(world);
  const signed = await create_runtime(env, registry()).sign_in({ email: args.email, password: args.password, device_name: "e2e-vendor" });

  if (!signed.ok) throw new Error(`register answered ${signed.status}: ${JSON.stringify(signed.body)}`);

  await tick();

  /* The undisturbed chain, traced: where its presses fall. */
  const warm = await new_job(app);
  const baseline = await tick();
  const warmed = await settle(app, warm.job.job_id);
  const warm_end = judge(warmed, warm.order, "undisturbed", problems);

  if (warm_end !== "succeeded") throw new Error(`an undisturbed chain ended ${warm_end}: ${problems.join("; ")}`);

  const total = baseline.life.ops;
  const presses = baseline.life.trace.flatMap((name, i) => (PRESSES.includes(name) ? [i + 1] : []));

  if (presses.length < 4) throw new Error(`the undisturbed chain pressed ${presses.length} times: ${baseline.life.trace.filter((n) => n.startsWith("page.send")).join(", ")}`);

  /* Just after each press, and just before it — after "acting" is written. */
  points = [...new Set(presses.flatMap((k) => [k - 1, k]))].sort((a, b) => a - b);

  const random = seeded(9);

  while (points.length < RUNS) points.push(1 + Math.floor(random() * total));

  const run = async (kill_after, close_browser, label) => {
    const { job, order } = await new_job(app);
    const { outcome } = await tick({ kill_after });

    if (outcome === "killed" && close_browser) world.close_browser();

    const ended = judge(await settle(app, job.job_id), order, label, problems);

    tally[ended] = (tally[ended] || 0) + 1;
    runs++;
  };

  for (const k of points) await run(k, false, `killed after operation ${k}`);

  for (let i = 0; i < CLOSED_BROWSER_RUNS; i++) await run(presses[i % presses.length], true, `browser closed after press ${i + 1}`);

  console.log(JSON.stringify({ ok: problems.length === 0, runs, operations_per_chain: total, presses, tally, problems: problems.slice(0, 20) }));
} catch (error) {
  crashed = true;
  console.log(JSON.stringify({ ok: false, runs, tally, problems: [...problems, String(error?.stack || error)] }));
} finally {
  app.close();
}

process.exit(!crashed && problems.length === 0 && runs > 0 ? 0 : 1);
