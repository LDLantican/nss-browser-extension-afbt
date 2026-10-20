/**
 * The property-manager adapter's kill loop against the real web app (roadmap
 * phase 12).
 *
 * Started by the web app's tests/integration/pm_extension_test.php, which has
 * started a `php -S` server on its test database and seeded an operator and a
 * property-manager connection running `appfolio_pm` on a host of its own:
 *
 *   node tests/e2e_pm.mjs --base=http://127.0.0.1:PORT --version=test-harness
 *     --email=... --password=... --connection=ID
 *     --php=/path/to/php --fixture=/path/to/tests/integration/fixtures/extension.php
 *     --root=/path/to/the/web/app [--runs=10] [--photos=12]
 *
 * Each run is one approved inspection — an exterior added on site, two items
 * flagged, photographs with real bytes on the kitchen sink — and the chain
 * approving it queues: create, fill_areas, a post_photos per ten photographs,
 * mark_done, worked by the extension's own runtime and appfolio_pm adapter over
 * HTTP, against the pretend AppFolio (adapters/appfolio_pm/site/books.js).
 * Only Chrome and AppFolio are pretend.
 *
 * The undisturbed chain is traced first; the runs kill it just before and just
 * after the first of each kind of press — where a duplicate would come from —
 * then at seeded random points, then a few with the browser closed. Every run
 * must end with every delivery succeeded, AppFolio holding exactly one
 * inspection carrying the number, its areas ASH's with the exterior added
 * once, the photographs uploaded once per part, Done pressed at most once,
 * and the web app's link `linked` to AppFolio's id.
 *
 * Prints one JSON summary line and exits 0 when every run held.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { add_unit, find_area, find_item } from "../adapters/appfolio_pm/site/books.js";
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
const PRESSES = ["page.send:start", "page.send:add_area", "page.send:set_item", "page.send:save_item", "page.send:mark_done"];
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

/** An approved inspection on the web app, and its street as a unit AppFolio can find. */
async function new_job(app) {
  const job = await app.ask({ do: "pm_job", photos: PHOTOS });

  if (job.error) throw new Error(`pm_job: ${job.error}`);

  add_unit(world.pm, { name: `Unit ${job.public_id}`, street: job.street });

  return job;
}

function moving(chain) {
  return chain.deliveries.some((d) => MOVING.has(d.status));
}

async function settle(app, inspection_id) {
  let chain = await app.ask({ do: "pm_chain", inspection_id });

  for (let i = 0; i < 60 && moving(chain); i++) {
    if (chain.deliveries.some((d) => ["claimed", "committing"].includes(d.status)) && !world.session.has(JOB_KEY))
      await app.ask({ do: "chain_expire", inspection_id });

    await app.ask({ do: "chain_due", inspection_id });
    await tick();
    world.clock.ms += 61000;
    chain = await app.ask({ do: "pm_chain", inspection_id });
  }

  if (world.session.has(JOB_KEY) || (world.local.get(OUTBOX_KEY) || []).length > 0) {
    await tick();
    chain = await app.ask({ do: "pm_chain", inspection_id });
  }

  return chain;
}

function judge(chain, job, label, problems) {
  const made = Object.values(world.pm.inspections).filter((i) => i.name.includes(job.public_id));
  const found = made[0] || null;
  const parts = chain.deliveries.filter((d) => d.operation === "post_photos").length;
  const wrong = (why) =>
    problems.push(`${label}: ${why} (${JSON.stringify({ made: made.length, chain: chain.deliveries.map((d) => `${d.operation}#${d.part}:${d.status}:${d.last_error}`) })})`);

  if (made.length !== 1) wrong(`${made.length} inspections in AppFolio carry ${job.public_id}`);
  if (world.session.has(JOB_KEY)) wrong("a job was left in hand");
  if ((world.local.get(OUTBOX_KEY) || []).length > 0) wrong("reports were left unsent");
  if (!chain.deliveries.every((d) => d.status === "succeeded")) wrong("not every delivery succeeded");

  if (found) {
    if (found.areas.filter((a) => a.name === "Exterior").length !== 1) wrong("the exterior is not there exactly once");
    if (find_item(find_area(found, "Exterior"), "Siding")?.result !== "follow_up") wrong("the siding is not flagged");
    if (find_item(find_area(found, "Kitchen"), "Sink")?.result !== "follow_up") wrong("the sink is not flagged");
    if (find_item(find_area(found, "Kitchen"), "Sink")?.photos !== PHOTOS) wrong(`the sink shows ${find_item(find_area(found, "Kitchen"), "Sink")?.photos} photographs`);
    if (found.uploads !== parts) wrong(`photographs uploaded ${found.uploads} times for ${parts} parts`);
    if (found.done_presses > 1) wrong(`Mark Inspection Done pressed ${found.done_presses} times`);
    if (found.status !== "DONE") wrong("not done in AppFolio");
    if (chain.link?.link_status !== "linked" || chain.link?.external_id !== found.id) wrong(`the link is ${JSON.stringify(chain.link)}`);
  }

  return chain.deliveries.some((d) => d.verifications > 0) ? "succeeded after verification" : "succeeded";
}

const app = web_app();
const problems = [];
let crashed = false;
const tally = {};
let runs = 0;
let points = [];

try {
  const { env } = create_life(world);
  const signed = await create_runtime(env, registry()).sign_in({ email: args.email, password: args.password, device_name: "e2e-pm" });

  if (!signed.ok) throw new Error(`register answered ${signed.status}: ${JSON.stringify(signed.body)}`);

  await tick();

  /* The undisturbed chain, traced: where its presses fall. */
  const warm = await new_job(app);
  const baseline = await tick();
  const warmed = await settle(app, warm.inspection_id);
  const warm_end = judge(warmed, warm, "undisturbed", problems);

  if (problems.length > 0) throw new Error(`an undisturbed chain ended ${warm_end}: ${problems.join("; ")}`);

  const total = baseline.life.ops;
  const presses = PRESSES.flatMap((name) => {
    const at = baseline.life.trace.indexOf(name);

    return at >= 0 ? [at + 1] : [];
  });

  if (presses.length < PRESSES.length)
    throw new Error(`the undisturbed chain pressed ${presses.length} kinds of thing: ${baseline.life.trace.filter((n) => n.startsWith("page.send")).join(", ")}`);

  points = [...new Set(presses.flatMap((k) => [k - 1, k]))].sort((a, b) => a - b);

  const random = seeded(12);

  while (points.length < RUNS) points.push(1 + Math.floor(random() * total));

  const run = async (kill_after, close_browser, label) => {
    const job = await new_job(app);
    const { outcome } = await tick({ kill_after });

    if (outcome === "killed" && close_browser) world.close_browser();

    const ended = judge(await settle(app, job.inspection_id), job, label, problems);

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
