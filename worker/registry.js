/**
 * The adapters this build carries, by id (ADR-008).
 *
 * An adapter is one platform-and-role pair — `appfolio_vendor`, say — and the
 * server names which one works a connection (`platform_connections.adapter`).
 * This build reports every adapter it carries, with its version, in each
 * heartbeat; the server offers a connection's jobs only to a browser that runs
 * that adapter at a version nobody has killed.
 *
 * The list is static on purpose. An adapter is code, and code arrives with an
 * extension update, never from the network — the same line the web app draws
 * between a platform (vocabulary, by migration) and a connection (data).
 *
 * Every adapter exports:
 *
 *   id, version                 the pair the kill switch names
 *   identity                    what it can capture or search by (plan C)
 *   operations                  per operation: entity, commit_step, and the
 *                               idempotent / verifiable / negative_verify_trusted
 *                               flags, mirrored on the server
 *   session(env, connection, { processing })
 *                               { state: live|expired|unknown, account_hint }
 *   session_lost(env)           optional: a job found it signed out
 *   plan(job)                   the execute steps, exactly one with commit: true
 *   verify_plan(job)            the steps of a verification, reads only
 *   parse_url(url)              the identity a URL names, or null
 *
 * A step is `{ name, run(ctx) }`, or for the commit step
 * `{ name, commit: true, act(ctx), await_person(ctx) }`. worker/job.js says
 * what each may return.
 */

import appfolio_vendor from "../adapters/appfolio_vendor/adapter.js";
import fixture from "../adapters/fixture/adapter.js";

/** What this build ships: the vendor portal (phase 9), and the stand-in that proves the runtime. */
export const ADAPTERS = [appfolio_vendor, fixture];

export function create_registry(adapters = ADAPTERS) {
  const by_id = new Map(adapters.map((adapter) => [adapter.id, adapter]));

  return {
    get: (id) => (id ? by_id.get(id) || null : null),
    list: () => [...by_id.values()],
    versions: () => Object.fromEntries([...by_id.values()].map((adapter) => [adapter.id, adapter.version])),
  };
}
