/**
 * The delivery worker: what one tick of the alarm does (plan section I).
 *
 * Every minute, in this order:
 *
 *   1. close any tab a dead job left in the "ASH" group;
 *   2. send whatever results are still in the outbox;
 *   3. heartbeat — the processing switch, the adapter versions, and for each
 *      connection this browser has an adapter for, whether it is signed in
 *      there — and keep the answer for the popup;
 *   4. finish the job in hand, if a service worker died holding one;
 *   5. while processing is on and some connection says this browser may claim,
 *      claim and work jobs one at a time until the queue answers 204 or the
 *      tick's budget is spent.
 *
 * One tick at a time: a second call while one runs gets the running one's
 * promise. That flag is module state and dies with the service worker, which is
 * harmless — the worker is never ended while a tick's own requests are open,
 * and a new worker finds the job in hand in storage, not in a variable.
 *
 * Everything outside this browser's memory comes through `env` (see
 * worker/chrome_env.js for Chrome's), which is what lets the tests run the
 * same code against a fake chrome and a real web app, and kill it anywhere.
 */

import { create_client } from "./client.js";
import { NetworkError, NotSignedIn } from "./errors.js";
import { give_back, job_from_claim, JOB_KEY, OUTCOMES, REHEARSED_KEY, run_job } from "./job.js";
import { create_journal } from "./journal.js";
import { create_outbox, OUTBOX_KEY } from "./outbox.js";

export const STATUS_KEY = "ash_worker_status";
export const PROCESSING_KEY = "ash_worker_processing";
export const CONNECTIONS_KEY = "ash_worker_connections";

const DEFAULTS = {
  /* A tick is bounded, so one alarm never runs into the next for long. */
  max_jobs_per_tick: 25,
  budget_ms: 240000,
};

export function create_runtime(env, registry, options = {}) {
  const limits = { ...DEFAULTS, ...options };
  const journal = create_journal(env);
  const client = create_client(env);
  const outbox = create_outbox(env, client, journal);
  const rt = { env, client, outbox, journal, registry };

  let running = null;

  /** "Process ASH jobs" — on unless somebody switched it off in this browser. */
  async function processing() {
    return (await env.local.get(PROCESSING_KEY)) !== false;
  }

  /**
   * Each adapter's view of its connections' sessions in this browser. The
   * adapter is told whether this browser is processing and what the web app
   * last said about the connection, so one that has to open a tab to find out
   * (appfolio_vendor) does so only when the answer could make a difference.
   */
  async function sessions(connections) {
    const reports = [];
    const on = await processing();

    for (const connection of connections) {
      const adapter = registry.get(connection.adapter);
      if (!adapter) continue;

      let seen = null;

      try {
        seen = await adapter.session(env, connection, { processing: on });
      } catch {
        seen = null;
      }

      const state = ["live", "expired"].includes(seen?.state) ? seen.state : "unknown";
      const report = { connection: connection.slug, state };

      if (seen?.account_hint) report.account_hint = String(seen.account_hint);

      reports.push(report);
    }

    return reports;
  }

  /**
   * The heartbeat. A connection this browser could work but has not reported a
   * session for yet — the first beat after signing in, or one created since —
   * is reported straight away in a second beat, rather than leaving the browser
   * ineligible for a minute it did not need to be.
   */
  async function beat() {
    const known = (await env.local.get(CONNECTIONS_KEY)) || [];
    const send = async (connections) =>
      client.heartbeat({
        processing_enabled: await processing(),
        extension_version: env.version,
        adapter_versions: registry.versions(),
        sessions: await sessions(connections),
      });

    let answer = await send(known);

    if (!answer.ok) return answer;

    const reported = new Set(known.map((connection) => connection.slug));
    const fresh = (answer.body?.connections || []).filter(
      (connection) => registry.get(connection.adapter) && !reported.has(connection.slug),
    );

    await env.local.set(
      CONNECTIONS_KEY,
      (answer.body?.connections || []).map(({ slug, adapter, enabled, reason }) => ({ slug, adapter, enabled, reason: reason ?? null })),
    );

    if (fresh.length > 0) answer = await send(answer.body.connections);

    return answer;
  }

  async function save_status(status) {
    await env.local.set(STATUS_KEY, { ...status, finished_at: env.now() });
  }

  async function work(trigger) {
    const started = env.now();
    const status = {
      at: started,
      trigger,
      state: "idle",
      error: "",
      processing: await processing(),
      connections: [],
      killed_adapters: [],
      jobs: 0,
    };

    try {
      const held = await env.session.get(JOB_KEY);

      await env.tabs.close_strays(held?.tab_id ?? null);

      if ((await client.identity()) === null) {
        status.state = "signed_out";

        return;
      }

      await outbox.flush();

      const answer = await beat();

      if (!answer.ok) {
        status.state = answer.status === 404 ? "unavailable" : "error";
        status.error = answer.status === 404
          ? "The web app's worker API is switched off."
          : answer.body?.error || `The heartbeat was refused (${answer.status}).`;

        return;
      }

      status.processing = answer.body?.processing_enabled !== false;
      status.killed_adapters = answer.body?.killed_adapters || [];
      status.connections = (answer.body?.connections || [])
        .filter((connection) => registry.get(connection.adapter))
        .map((connection) => ({
          slug: connection.slug,
          name: connection.name,
          claimable: connection.claimable === true,
          reason: connection.reason || null,
          scope: connection.scope,
          dry_run: connection.dry_run !== false,
          auto_submit: connection.auto_submit === true,
        }));

      /* A job in hand first: it holds a lease that another browser is waiting
         behind, and possibly a commit nobody has reported. */
      if (held) {
        status.jobs++;

        if ((await run_job(rt, held)) === OUTCOMES.PAUSED) {
          status.state = "paused";

          return;
        }
      }

      if (!status.processing || !status.connections.some((connection) => connection.claimable)) return;

      while (status.jobs < limits.max_jobs_per_tick && env.now() - started < limits.budget_ms) {
        const claimed = await client.claim();

        if (claimed.status === 204) break;

        if (!claimed.ok) {
          status.state = claimed.status === 426 ? "outdated" : "error";
          status.error = claimed.body?.error || `The web app refused the claim (${claimed.status}).`;
          break;
        }

        const job = job_from_claim(claimed.body, registry.get(claimed.body?.connection?.adapter), env.now());

        /* Written before anything else is done with it: from here a dead
           worker leaves a record the next one finishes, not a claim nobody
           remembers until its lease runs out. */
        await env.session.set(JOB_KEY, job);
        status.jobs++;

        if (await already_rehearsed(job)) {
          await give_back(rt, job, "Already rehearsed with these figures; waiting for the connection to leave dry run.");

          /* Everything due has been rehearsed once round: stop for this tick
             rather than claiming the same jobs over again. */
          break;
        }

        if ((await run_job(rt, job)) === OUTCOMES.PAUSED) {
          status.state = "paused";
          break;
        }
      }
    } catch (error) {
      if (error instanceof NotSignedIn) {
        status.state = error.reason === "retired" ? "retired" : error.reason === "unavailable" ? "unavailable" : "signed_out";
        status.error = error.message;
      } else if (error instanceof NetworkError) {
        status.state = "offline";
        status.error = error.message;
      } else {
        status.state = "error";
        status.error = error?.message || String(error);
      }
    } finally {
      await save_status(status).catch(() => null);
    }
  }

  async function already_rehearsed(job) {
    if (job.mode !== "execute" || job.connection?.dry_run === false) return false;

    const rehearsed = (await env.local.get(REHEARSED_KEY)) || {};

    return rehearsed[job.delivery_id]?.hash === job.payload_hash;
  }

  return {
    rt,

    tick(trigger = "alarm") {
      if (running !== null) return running;

      running = work(trigger).finally(() => {
        running = null;
      });

      return running;
    },

    is_running: () => running !== null,

    /**
     * A heartbeat and nothing else. It learns the web app's connections without
     * claiming anything, for the import, which needs the pm connection's name
     * and must not wait behind a job. Null when this browser is not signed in.
     */
    async heartbeat() {
      if ((await client.identity()) === null) return null;

      return beat();
    },

    async sign_in({ email, password, device_name }) {
      const answer = await client.register({ email, password, device_name });

      if (answer.ok) {
        await env.local.remove(CONNECTIONS_KEY);
        await env.local.remove(STATUS_KEY);
      }

      return answer;
    },

    /**
     * Forget this browser's worker. Local only: the worker API has no way for a
     * device to retire itself, so the person retires it from /account if it
     * should stop existing on the server too. A job in hand is dropped; its
     * lease runs out and the server's reaper reschedules it, or verifies it.
     */
    async sign_out() {
      const held = await env.session.get(JOB_KEY);

      if (held?.tab_id !== null && held?.tab_id !== undefined) await env.tabs.close(held.tab_id).catch(() => null);

      await env.session.remove(JOB_KEY);
      await env.local.remove(OUTBOX_KEY);
      await env.local.remove(CONNECTIONS_KEY);
      await env.local.remove(STATUS_KEY);
      await client.forget();
    },

    async set_processing(on) {
      await env.local.set(PROCESSING_KEY, on === true);
    },

    /** Everything the popup shows, from storage alone. */
    async state() {
      const [who, status, job, waiting, recent, on] = await Promise.all([
        client.identity(),
        env.local.get(STATUS_KEY),
        env.session.get(JOB_KEY),
        outbox.entries(),
        journal.list(),
        processing(),
      ]);

      return {
        signed_in: who !== null,
        user: who?.user || null,
        device_name: who?.device_name || "",
        worker_id: who?.worker_id ?? null,
        processing: on,
        status: status || null,
        running: running !== null,
        job: job ? { ...about_job(job) } : null,
        outbox: waiting.length,
        recent: recent.slice(0, 10),
      };
    },
  };
}

function about_job(job) {
  return {
    delivery_id: job.delivery_id,
    public_id: job.entity?.public_id || "",
    operation: job.operation,
    mode: job.mode,
    phase: job.commit_phase || "preparing",
  };
}
