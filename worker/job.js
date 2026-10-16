/**
 * One claimed job, as a step machine that survives the service worker dying.
 *
 * Manifest V3 ends an idle service worker after thirty seconds and may end a
 * busy one for any reason, taking every variable with it. Legacy kept a job's
 * progress in module variables and relied on the server's lease to notice the
 * loss. Here the job is a record in `storage.session` — which survives the
 * worker but not the browser — written after every step, and a new worker
 * picks it up where the last one stopped.
 *
 * ## What may be done again, and what never may
 *
 * An adapter's plan is a list of short steps, and exactly one of them is the
 * **commit step**: the click that cannot be taken back (Submit, Save). Every
 * step before it only navigates, reads and types, so a worker that dies there
 * simply runs that step again. Around the commit step the record says how far
 * it got, and each phase is written *before* the thing it names is done:
 *
 *   commit_requested  about to ask the server's permission. Asking again is
 *                     safe: a holder that is already committing gets the same
 *                     yes (docs/worker-api.md, "commit").
 *   committed         the server said yes and nothing has been clicked.
 *   acting            the click may have happened. A worker that finds this
 *                     phase with no result **never clicks again**: it reports
 *                     `unknown_outcome`, and the server hands the job to a
 *                     verification, which looks rather than acts.
 *   acted             the click happened and what it produced is recorded.
 *
 * So a crash anywhere costs at most one verification, and never a second
 * click. That is the whole design (ADR-004), and runner_test proves it by
 * killing the worker after every single storage write, request and page
 * command of a job.
 *
 * ## Reports are written before they are sent
 *
 * A finished job writes its report — with its own `attempt_uuid` — into the
 * record first, then into the outbox, and only then forgets the job. A worker
 * that dies between those finds the report in the record and adds it again,
 * which the outbox ignores by uuid and the server would answer identically.
 *
 * ## Switches that fail safe
 *
 * The claim carries the connection's `dry_run` and `auto_submit`. Only an
 * explicit `false` for `dry_run` lets a job past its commit point, and only an
 * explicit `true` for `auto_submit` lets this browser press the button itself;
 * anything missing or unreadable means rehearse, and leave the button to a
 * person. Legacy defaulted both the other way.
 */

import {
  AdapterError,
  ADAPTER_BROKEN,
  NetworkError,
  NotSignedIn,
  PERMANENT,
  SESSION_EXPIRED,
  TabGone,
  TRANSIENT,
  UNKNOWN_OUTCOME,
  VERIFIED_ABSENT,
} from "./errors.js";

export const JOB_KEY = "ash_worker_job";
export const REHEARSED_KEY = "ash_worker_rehearsed";

/**
 * Troubleshooting only (the rollout ladder's live kill runs, roadmap phase 9):
 * how many presses to follow by stopping dead, as a killed service worker
 * would — the record left at `acting`, nothing reported. The next tick finds
 * it and reports an unknown outcome, and a verification has to recover the
 * truth from the live page. Set from Settings → Troubleshooting; absent means
 * never, which is how it ships.
 */
export const STOP_AFTER_PRESS_KEY = "ash_worker_stop_after_press";

/** How many rehearsals to remember, so the map cannot grow without end. */
const REHEARSED_KEEP = 500;

/** What a step function may finish with. */
const OUTCOMES = { DONE: "done", PAUSED: "paused" };

export { OUTCOMES };

/** A claim, as the record a job is worked from. */
export function job_from_claim(claim, adapter, now) {
  return {
    delivery_id: claim.delivery_id,
    claim_token: claim.claim_token,
    mode: claim.mode === "verify" ? "verify" : "execute",
    operation: claim.operation,
    part: claim.part ?? 1,
    attempt: claim.attempt ?? null,
    flags: claim.flags || {},
    entity: claim.entity || {},
    connection: claim.connection || {},
    link: claim.link || null,
    payload: claim.payload ?? null,
    payload_hash: claim.payload_hash ?? null,
    expected_total_cents: claim.expected_total_cents ?? null,
    adapter_version: adapter?.version ?? null,

    cursor: 0,
    data: {},
    commit_phase: null,
    tab_id: null,
    report: null,
    claimed_ms: now,
  };
}

/** The bits of a job a journal entry or a report names it by. */
export function about(job) {
  return {
    public_id: job.entity?.public_id || "",
    operation: job.operation,
    mode: job.mode,
    connection: job.connection?.slug || "",
  };
}

/**
 * Has this job got as far as asking to commit?
 *
 * `commit_requested` counts: the yes may have reached the server and been
 * lost on the way back, so the server may already hold the row as committing,
 * and only a report — never a quiet release — can be trusted to settle it.
 */
function past_commit_request(job) {
  return job.commit_phase !== null;
}

/**
 * Work a job until it is finished, given back, or can go no further this tick.
 *
 * Returns OUTCOMES.DONE when the record is gone (reported, released or
 * abandoned) and OUTCOMES.PAUSED when the job must wait for the next tick —
 * the web app is unreachable, or the worker cannot sign in — with the record
 * left exactly as it was.
 *
 * `rt` is `{ env, client, outbox, journal, registry }`.
 */
export async function run_job(rt, job) {
  if (!job?.delivery_id || !job.claim_token) {
    await rt.env.session.remove(JOB_KEY);

    return OUTCOMES.DONE;
  }

  if (job.report) return send_report(rt, job);

  const adapter = rt.registry.get(job.connection?.adapter);

  /* An extension update mid-job could leave the record naming an adapter
     version this worker no longer runs. Its plan may not even have the same
     steps, so the cursor means nothing: give it back, or say we do not know. */
  if (!adapter || adapter.version !== job.adapter_version)
    return job.commit_phase === "acting" || job.commit_phase === "acted"
      ? report_failure(rt, job, UNKNOWN_OUTCOME, "The extension was updated while this job was in hand, after its commit point.", "resume")
      : give_back(rt, job, "The extension was updated while this job was in hand.");

  let plan;

  try {
    plan = job.mode === "verify" ? adapter.verify_plan(job) : adapter.plan(job);
  } catch (error) {
    return report_failure(rt, job, job.mode === "verify" ? UNKNOWN_OUTCOME : PERMANENT, error?.message || "The adapter has no plan for this job.", "plan");
  }

  const ctx = context(rt, job);

  while (job.cursor < plan.length) {
    const step = plan[job.cursor];

    /* A lease measures silence, not length: renewed before every step. */
    const lease = await renew(rt, job, step.name);

    if (lease === "offline") return OUTCOMES.PAUSED;

    if (lease === "refused") return give_back(rt, job, "The web app no longer lets this browser work this job.");

    if (lease === "lost") {
      /* Before the commit request nothing was written and the server's reaper
         reschedules it. After, carry on and tell the truth: the report will be
         refused, and verification will look. */
      if (!past_commit_request(job)) return abandon(rt, job, "The lease on this job ran out before anything was written.");
    }

    let outcome;

    try {
      outcome = step.commit
        ? await commit_step(rt, job, ctx, step)
        : await ordinary_step(rt, job, ctx, step);
    } catch (error) {
      return failed(rt, job, error, step.name);
    }

    if (outcome !== undefined) return outcome;

    job.cursor++;
    await save(rt, job);
  }

  if (job.mode === "verify")
    return report_failure(rt, job, UNKNOWN_OUTCOME, "The verification ended without saying what it found.", "verify");

  return report(rt, job, "complete", {
    identity: job.data.identity || null,
    evidence: String(job.data.evidence || ""),
    step: plan.length > 0 ? plan[plan.length - 1].name : "",
  });
}

/** A step that only navigates, reads or types. Returns an outcome to stop. */
async function ordinary_step(rt, job, ctx, step) {
  const out = (await step.run(ctx)) || {};

  if (out.data) Object.assign(job.data, out.data);

  if (job.mode === "verify" && out.verdict === "found")
    return report(rt, job, "complete", { identity: out.identity || null, evidence: String(out.evidence || ""), step: step.name });

  if (job.mode === "verify" && out.verdict === "absent")
    return report(rt, job, "fail", { error_class: VERIFIED_ABSENT, message: String(out.evidence || "It is not there."), step: step.name });

  /* Already done on the platform — an earlier attempt that took, though the
     server never heard. Only believed before the commit request: after it, a
     find is what the capture step is for. */
  if (out.already_done && !past_commit_request(job))
    return report(rt, job, "complete", { identity: out.identity || null, evidence: String(out.evidence || "Already there."), step: step.name });

  return undefined;
}

/** The click that cannot be taken back, and the phases around it. */
async function commit_step(rt, job, ctx, step) {
  if (job.mode === "verify")
    return report_failure(rt, job, ADAPTER_BROKEN, "A verification plan contains a commit step.", step.name);

  if (job.commit_phase === "acting")
    return report_failure(
      rt,
      job,
      UNKNOWN_OUTCOME,
      "The browser stopped while this job was at its commit point, so nobody knows whether it went through. It is never repeated by itself; a verification will look.",
      step.name,
    );

  if (job.commit_phase === "acted") return undefined;

  if (job.connection?.dry_run !== false) return rehearse(rt, job, step.name);

  if (job.commit_phase !== "committed") {
    job.commit_phase = "commit_requested";
    await save(rt, job);

    let answer;

    try {
      answer = await rt.client.commit(job.delivery_id, job.claim_token, step.name);
    } catch (error) {
      if (error instanceof NetworkError || error instanceof NotSignedIn) return OUTCOMES.PAUSED;

      throw error;
    }

    if (answer.status === 409) {
      const reason = answer.body?.reason || "";

      /* The incident switches: the job must go back untouched. */
      if (reason === "connection_paused" || reason === "adapter_killed")
        return give_back(rt, job, answer.body?.error || `The web app refused the commit (${reason}).`);

      return abandon(rt, job, answer.body?.error || `The web app refused the commit (${reason || 409}).`);
    }

    if (answer.status === 403 || answer.status === 426)
      return give_back(rt, job, answer.body?.error || `The web app refused the commit (${answer.status}).`);

    /* No yes: never click on anything else. A 5xx is asked again next tick. */
    if (!answer.ok) return OUTCOMES.PAUSED;

    job.commit_phase = "committed";
    await save(rt, job);
  }

  job.commit_phase = "acting";
  await save(rt, job);

  const out = (job.connection?.auto_submit === true ? await step.act(ctx) : await step.await_person(ctx)) || {};

  if (await stop_after_press(rt)) return OUTCOMES.PAUSED;

  if (out.data) Object.assign(job.data, out.data);

  job.commit_phase = "acted";
  await save(rt, job);

  return undefined;
}

/**
 * Turn whatever a step threw into the right report, or into giving the job
 * back when nothing was written.
 */
async function failed(rt, job, error, step_name) {
  if (error instanceof NetworkError || error instanceof NotSignedIn) return OUTCOMES.PAUSED;

  if (error instanceof TabGone)
    return job.commit_phase === "acting" || job.commit_phase === "acted"
      ? report_failure(rt, job, UNKNOWN_OUTCOME, error.message, step_name)
      : give_back(rt, job, error.message);

  if (error instanceof AdapterError) {
    /* Signed out of the platform: the adapter's cached "live" is wrong now,
       and the next heartbeat should not repeat it. */
    if (error.error_class === SESSION_EXPIRED) {
      const adapter = rt.registry.get(job.connection?.adapter);

      try {
        await adapter?.session_lost?.(rt.env);
      } catch {
        /* Best effort: the server marks the session expired either way. */
      }
    }

    /* A worker may only say "definitely absent" from a verification. */
    const error_class = error.error_class === VERIFIED_ABSENT && job.mode !== "verify" ? PERMANENT : error.error_class;

    return report_failure(rt, job, error_class, error.message, step_name, error.identity);
  }

  const acted = job.commit_phase === "acting" || job.commit_phase === "acted";

  return report_failure(
    rt,
    job,
    acted || job.mode === "verify" ? UNKNOWN_OUTCOME : ADAPTER_BROKEN,
    `The adapter failed at "${step_name}": ${error?.message || String(error)}`,
    step_name,
  );
}

function report_failure(rt, job, error_class, message, step, identity = null) {
  return report(rt, job, "fail", { error_class, message: String(message || error_class), step, identity });
}

/**
 * Write the report into the record, then into the outbox, then forget the job.
 */
async function report(rt, job, kind, fields) {
  job.report = {
    uuid: rt.env.uuid(),
    kind,
    body: {
      claim_token: job.claim_token,
      ...fields,
      ...(kind === "complete" ? { sent_version: job.entity?.version ?? null, payload_hash: job.payload_hash } : {}),
    },
  };

  await save(rt, job);

  return send_report(rt, job);
}

async function send_report(rt, job) {
  const { uuid, kind, body } = job.report;

  await rt.outbox.add({ uuid, delivery_id: job.delivery_id, kind, body: { ...body, attempt_uuid: uuid }, about: about(job) });
  await forget(rt, job);

  /* Best effort: whatever is not answered now is answered on the next tick. */
  await rt.outbox.flush().catch(() => null);

  return OUTCOMES.DONE;
}

/**
 * Hand the job back before anything was written, so another attempt — here or
 * in another browser — starts clean. If the server says it is already past its
 * commit point (our yes was lost on the way back), it cannot be released, and
 * the honest report is that nobody knows; verification will find that nothing
 * was clicked.
 */
export async function give_back(rt, job, why) {
  let answer;

  try {
    answer = await rt.client.release(job.delivery_id, job.claim_token);
  } catch (error) {
    if (error instanceof NetworkError || error instanceof NotSignedIn) return OUTCOMES.PAUSED;

    throw error;
  }

  if (answer.status === 409 && answer.body?.reason === "committed")
    return report_failure(rt, job, UNKNOWN_OUTCOME, `${why} The web app had already recorded the commit; nothing was clicked.`, "release");

  if (!answer.ok && answer.status !== 409 && answer.status !== 404) return OUTCOMES.PAUSED;

  await rt.journal.add({ ...about(job), delivery_id: job.delivery_id, outcome: "given back", note: why });
  await forget(rt, job);

  return OUTCOMES.DONE;
}

/** The lease is gone and nothing was written: the server's reaper owns it now. */
async function abandon(rt, job, why) {
  await rt.journal.add({ ...about(job), delivery_id: job.delivery_id, outcome: "dropped", note: why });
  await forget(rt, job);

  return OUTCOMES.DONE;
}

/**
 * A rehearsal: every step before the commit has run — the form is filled and
 * the total checked — and the job goes back untouched. Remembered, so the
 * runtime does not rehearse the same unchanged job again every minute.
 */
async function rehearse(rt, job, step_name) {
  const rehearsed = (await rt.env.local.get(REHEARSED_KEY)) || {};
  const entries = Object.entries({ ...rehearsed, [job.delivery_id]: { hash: job.payload_hash, at: rt.env.now() } })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, REHEARSED_KEEP);

  await rt.env.local.set(REHEARSED_KEY, Object.fromEntries(entries));

  return give_back(rt, job, `Rehearsed up to "${step_name}"; the connection is in dry run, so nothing was submitted.`);
}

/** Spend one armed "stop after the press", if there is one. */
async function stop_after_press(rt) {
  const left = Number(await rt.env.local.get(STOP_AFTER_PRESS_KEY)) || 0;

  if (left <= 0) return false;

  if (left === 1) await rt.env.local.remove(STOP_AFTER_PRESS_KEY);
  else await rt.env.local.set(STOP_AFTER_PRESS_KEY, left - 1);

  return true;
}

/** Close the job's tab and remove its record. */
async function forget(rt, job) {
  if (job.tab_id !== null && job.tab_id !== undefined) await rt.env.tabs.close(job.tab_id).catch(() => null);

  await rt.env.session.remove(JOB_KEY);
}

async function save(rt, job) {
  await rt.env.session.set(JOB_KEY, job);
}

/**
 * Renew the lease before a step: `ok`, `lost` (409, not ours any more),
 * `refused` (403 or 426: this browser may no longer take or keep work) or
 * `offline`.
 */
async function renew(rt, job, step) {
  let answer;

  try {
    answer = await rt.client.touch(job.delivery_id, job.claim_token, step);
  } catch (error) {
    if (error instanceof NetworkError || error instanceof NotSignedIn) return "offline";

    throw error;
  }

  if (answer.ok) return "ok";
  if (answer.status === 409) return "lost";
  if (answer.status === 403 || answer.status === 426) return "refused";

  return "offline";
}

/** What an adapter's steps are given to work with. */
function context(rt, job) {
  return {
    job,
    data: job.data,
    now: () => rt.env.now(),
    sleep: (ms) => rt.env.sleep(ms),

    /** A page packaged in this extension, as a URL a tab can open. */
    extension_url: (path) => rt.env.extension_url(path),

    /**
     * Show `url` in this job's tab, opening one in the collapsed "ASH" group
     * if it has none. The tab survives a service worker restart, so a resumed
     * job reuses it.
     */
    async open(url) {
      if (job.tab_id !== null && (await rt.env.tabs.exists(job.tab_id))) {
        if (!(await rt.env.tabs.navigate(job.tab_id, url))) throw new TabGone();

        return job.tab_id;
      }

      const tab_id = await rt.env.tabs.open(url);

      if (tab_id === null || tab_id === undefined)
        throw new AdapterError(TRANSIENT, "Could not open a tab for this job.");

      job.tab_id = tab_id;
      await save(rt, job);

      return tab_id;
    },

    /** The address the job's tab shows now, or null — a redirect to a sign-in page shows here first. */
    async tab_url() {
      return job.tab_id === null ? null : rt.env.tabs.url(job.tab_id);
    },

    /**
     * One photograph of the note this job posts, from the web app, as
     * `{ name, mime_type, b64 }` for the page script to stage. Only the
     * holder of a post_photos claim is given the bytes.
     */
    async photo(file_id) {
      /* Unreachable is a NetworkError, which pauses the job as any other call does. */
      const answer = await rt.client.photo(job.delivery_id, job.claim_token, file_id);

      /* A refusal is one 404 whatever the cause — a lease that ran out mid-way
         is the likely one — so it is retried, never a person's problem at once. */
      if (!answer.ok) throw new AdapterError(TRANSIENT, `The web app would not hand over photograph ${file_id} (${answer.status}).`);

      return { name: answer.name, mime_type: answer.mime_type, b64: answer.b64 };
    },

    /** Ask the adapter's page script something. Throws TabGone without a tab. */
    async ask(command, args = {}, options = {}) {
      if (job.tab_id === null) throw new TabGone("This job has no tab yet.");

      return rt.env.page.send(job.tab_id, command, args, options);
    },

    /** Bring the job's tab to a person, for a commit step left to them. */
    async reveal(message) {
      if (job.tab_id !== null) await rt.env.tabs.reveal(job.tab_id, message);
    },

    /** Renew the lease from inside a long step. False once it is lost. */
    async touch(step) {
      return (await renew(rt, job, step)) === "ok";
    },
  };
}
