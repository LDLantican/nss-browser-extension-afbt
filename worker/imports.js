/**
 * Importing work orders from a property manager's AppFolio into the web app
 * (roadmap phase 8; the web app's docs/worker-api.md, "Importing").
 *
 * The person ticks rows on Camelot's AppFolio work-order list. The content
 * script reads them there, because only a content script can read AppFolio
 * with the person's own session. They come here, and go to
 * `/api/worker/imports` with this browser's worker credentials. The answer
 * says, per record, what the web app did, and the content script paints it on
 * the row.
 *
 * Not a delivery and not the step machine: nothing is clicked in AppFolio and
 * nothing waits on a lease. A person is present, presses Import and watches the
 * rows change, so a failed request is told to them and pressed again.
 * Re-importing is safe by design: the server finds a number it already holds
 * and refreshes it instead of creating a second job.
 *
 * ## Which connection
 *
 * The web app names its connections. The pm one is whichever runs the
 * `appfolio_pm` adapter, and it is learned from the heartbeat's answer, which
 * the runtime keeps in storage. A browser that has not had a heartbeat answer
 * yet (just signed in, or the list was cleared) runs one tick first, which
 * heartbeats. With several pm connections the first is used. There is one,
 * Camelot's, and a second AppFolio account would need the page's host matched
 * to its connection, which no connection records yet.
 *
 * ## Test or live
 *
 * The connection's own scope says which work orders it takes, `test` or
 * `live` (the owner's decision for phase 8). The lookup hands it back with the
 * test marker, so the page can refuse a row before reading its neighbours. The
 * server checks again whatever the page decided.
 */

import { NetworkError, NotSignedIn } from "./errors.js";
import { CONNECTIONS_KEY } from "./runtime.js";

export const PM_ADAPTER = "appfolio_pm";

/** The server's own ceilings (integration.imports in the web app); larger batches are split. */
export const MAX_RECORDS = 100;
export const LOOKUP_MAX = 500;

/** The fields the server reads off a record. Anything else the page parsed stays here. */
const FIELDS = ["number", "native_id", "url", "street", "unit", "city", "state", "zip", "description"];

/**
 * @param {{ env: object, client: object, refresh?: () => Promise<unknown> }} parts
 *   `refresh` runs a heartbeat, for when no pm connection is known yet.
 */
export function create_imports({ env, client, refresh = null }) {
  async function known() {
    const connections = (await env.local.get(CONNECTIONS_KEY)) || [];

    return connections.find((connection) => connection?.adapter === PM_ADAPTER) || null;
  }

  async function connection() {
    let found = await known();

    if (found === null && refresh !== null) {
      await refresh();
      found = await known();
    }

    return found;
  }

  const signed_out = () => ({ ok: false, reason: "signed_out", error: "Sign in from the extension's Settings to import work orders." });

  /**
   * Run a call, turning the two things that are not HTTP answers into
   * page-sized ones. A browser with no worker identity is told to sign in
   * before anything else, rather than that no connection could be found.
   */
  async function guarded(work) {
    try {
      if ((await client.identity()) === null) return signed_out();

      return await work();
    } catch (error) {
      if (error instanceof NotSignedIn) return signed_out();
      if (error instanceof NetworkError)
        return { ok: false, reason: "unreachable", error: error.message || "The web app could not be reached." };

      throw error;
    }
  }

  /** A refusal of the whole request, in words a person can act on. */
  function refused(answer) {
    const reason = answer.body?.reason
      || { 401: "signed_out", 403: "forbidden", 404: "unavailable", 413: "too_many", 426: "outdated" }[answer.status]
      || "refused";
    const error = answer.status === 404
      ? "The web app's worker API is switched off."
      : answer.body?.error || `The web app refused that (${answer.status}).`;

    return { ok: false, reason, error, status: answer.status };
  }

  function no_connection() {
    return {
      ok: false,
      reason: "no_connection",
      error: "The web app has no AppFolio property-manager connection for this browser to import through.",
    };
  }

  return {
    /**
     * What the web app holds for these numbers: the job each was imported as,
     * or that legacy still has it open. Plus the connection's mode and the test
     * marker, for the page to refuse rows by.
     */
    async lookup(numbers) {
      return guarded(async () => {
        const target = await connection();
        if (target === null) return no_connection();

        const list = [...new Set((numbers || []).map((n) => String(n ?? "").trim()).filter((n) => n !== ""))].slice(0, LOOKUP_MAX);
        const answer = await client.import_lookup(target.slug, list);
        if (!answer.ok) return refused(answer);

        return {
          ok: true,
          connection: answer.body.connection,
          scope: scope_of(answer.body),
          work_orders: answer.body.work_orders || {},
          legacy: answer.body.legacy || {},
        };
      });
    },

    /**
     * Send records, a hundred at a time, and say what became of each, in the
     * order they were given. A batch the server refused whole stops the rest,
     * with the records it did not reach reported as not sent.
     */
    async send(records) {
      return guarded(async () => {
        const target = await connection();
        if (target === null) return no_connection();

        const list = (records || []).map(trim_record);
        const results = [];
        let failure = null;

        for (let start = 0; start < list.length; start += MAX_RECORDS) {
          const batch = list.slice(start, start + MAX_RECORDS);
          const answer = await client.import_records(target.slug, batch);

          if (!answer.ok) {
            failure = refused(answer);
            break;
          }

          for (const result of answer.body?.results || [])
            results.push({ ...result, index: start + Number(result.index) });
        }

        const counts = {};
        for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;

        return failure === null
          ? { ok: true, results, counts }
          : { ...failure, results, counts, unsent: list.length - results.length };
      });
    },
  };
}

/**
 * The connection's scope in the shape the page's scope check already reads:
 * `sample` for a test connection, `live` for a live one, and null for anything
 * else, which refuses everything.
 */
export function scope_of(body) {
  const mode = body?.scope === "test" ? "sample" : body?.scope === "live" ? "live" : null;

  return mode === null ? null : { mode, marker: String(body?.marker || "") };
}

function trim_record(record) {
  const out = {};

  for (const field of FIELDS) {
    const value = record?.[field];
    out[field] = value === null || value === undefined ? "" : String(value);
  }

  return out;
}
