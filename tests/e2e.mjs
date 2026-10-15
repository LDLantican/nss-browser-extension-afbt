/**
 * The kill loop against the real web app (roadmap phase 7's acceptance).
 *
 * Started by the web app's tests/integration/extension_test.php, which has
 * already started a `php -S` server on its test database and seeded an
 * operator and a fixture connection:
 *
 *   node tests/e2e.mjs --base=http://127.0.0.1:PORT --version=test-harness
 *     --email=... --password=... --connection=ID
 *     --php=/path/to/php --fixture=/path/to/tests/integration/fixtures/extension.php
 *     --root=/path/to/the/web/app [--runs=100]
 *
 * The runtime here is the extension's own — worker/runtime.js and the fixture
 * adapter — calling the real worker API over HTTP. Only Chrome is pretend
 * (tests/support/fake_env.js): storage, tabs and the fixture page.
 *
 * One job per run. The undisturbed job's operations are counted first; then
 * the worker is killed after operation k, for every k (and round again until
 * there are at least --runs runs), and the alarm left to finish the job. A
 * further ten runs close the browser instead. A worker that died holding a
 * claim it never wrote down is recovered the only way it can be — its lease
 * runs out, and the row waits out a backoff — both of which the web app's
 * fixture brings forward rather than making each run wait minutes.
 *
 * Prints one JSON summary line and exits 0 when every run held.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { create_life, create_world } from "./support/fake_env.js";
import { registry } from "./support/scenario.js";
import { create_runtime } from "../worker/runtime.js";
import { JOB_KEY } from "../worker/job.js";
import { OUTBOX_KEY } from "../worker/outbox.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");

    return [key, rest.join("=")];
  }),
);

const RUNS = Number(args.runs || 100);
const CLOSED_BROWSER_RUNS = 10;
const TERMINAL = new Set(["succeeded", "needs_manual", "cancelled"]);

/** The web app's fixture, one JSON line per command. */
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

  return { outcome, life, runtime };
}

async function settle(app, delivery_id) {
  let state = await app.ask({ do: "state", delivery_id });

  for (let i = 0; i < 15 && !TERMINAL.has(state.status); i++) {
    /* Held on the server, unknown here: the browser that claimed it is gone.
       Its lease would run out in two minutes; the fixture makes it now. */
    if (["claimed", "committing"].includes(state.status) && !world.session.has(JOB_KEY))
      await app.ask({ do: "expire", delivery_id });

    /* Waiting out a backoff (up to 30 s after an expired lease) is the
       server's business, not the runtime's; the fixture makes it due now. */
    if (["retry_scheduled", "outcome_unknown"].includes(state.status)) await app.ask({ do: "due", delivery_id });

    await tick();
    world.clock.ms += 61000;
    state = await app.ask({ do: "state", delivery_id });
  }

  /* One more tick only if something is still waiting to be sent. */
  if (world.session.has(JOB_KEY) || (world.local.get(OUTBOX_KEY) || []).length > 0) {
    await tick();
    state = await app.ask({ do: "state", delivery_id });
  }

  return state;
}

function judge(state, public_id, label, problems) {
  const submits = world.site.orders[public_id]?.submits ?? 0;
  const wrong = (why) => problems.push(`${label}: ${why} (${JSON.stringify({ ...state, submits })})`);

  if (submits > 1) wrong(`the invoice was submitted ${submits} times`);
  if (world.session.has(JOB_KEY)) wrong("a job was left in hand");
  if ((world.local.get(OUTBOX_KEY) || []).length > 0) wrong("reports were left unsent");

  if (state.status === "succeeded") {
    if (submits !== 1) wrong("succeeded without an invoice on the platform");
    if (state.invoice_links !== 1) wrong(`${state.invoice_links} invoice links recorded`);

    return state.verifications > 0 ? "succeeded after verification" : "succeeded";
  }

  if (state.status !== "needs_manual") wrong(`ended ${state.status}`);
  else if (submits !== 0) wrong("handed to a person although the platform holds the invoice");
  else if (state.last_error !== "verified_absent" || state.verifications === 0) wrong("handed to a person without a verification");

  return "verified absent, for a person";
}

const app = web_app();
const problems = [];
let crashed = false;
const tally = {};
let runs = 0;

try {
  const { env } = create_life(world);
  const signed = await create_runtime(env, registry()).sign_in({ email: args.email, password: args.password, device_name: "e2e" });

  if (!signed.ok) throw new Error(`register answered ${signed.status}: ${JSON.stringify(signed.body)}`);

  /* The first tick after signing in beats twice; count a settled one. */
  await tick();

  const warm = await app.ask({ do: "job" });
  const baseline = await tick();
  const warmed = await app.ask({ do: "state", delivery_id: warm.delivery_id });

  if (warmed.status !== "succeeded") throw new Error(`an undisturbed job ended ${JSON.stringify(warmed)}`);

  const total = baseline.life.ops;

  const run = async (kill_after, close_browser, label) => {
    const { delivery_id, public_id } = await app.ask({ do: "job" });
    const { outcome } = await tick({ kill_after });

    if (outcome === "killed" && close_browser) world.close_browser();

    const ended = judge(await settle(app, delivery_id), public_id, label, problems);

    tally[ended] = (tally[ended] || 0) + 1;
    runs++;
  };

  for (let i = 0; runs < Math.max(RUNS, total); i++) {
    const k = 1 + (i % total);

    await run(k, false, `killed after operation ${k}`);
  }

  for (let i = 0; i < CLOSED_BROWSER_RUNS; i++) {
    const k = 1 + Math.floor(((i + 0.5) * total) / CLOSED_BROWSER_RUNS);

    await run(k, true, `browser closed after operation ${k}`);
  }

  console.log(JSON.stringify({ ok: problems.length === 0, runs, operations_per_job: total, tally, problems: problems.slice(0, 20) }));
} catch (error) {
  crashed = true;
  console.log(JSON.stringify({ ok: false, runs, tally, problems: [...problems, String(error?.stack || error)] }));
} finally {
  app.close();
}

process.exit(!crashed && problems.length === 0 && runs > 0 ? 0 : 1);
