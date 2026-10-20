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
 * ## Which connection (3.3.0)
 *
 * **The page decides, not this browser.** Every request carries the host of
 * the AppFolio page it came from — read off the sender's tab by the service
 * worker, not taken from the page's word — and the company name that page
 * shows. The web app imports through the pm connection whose host it is, and
 * refuses a page signed in to a different company than that connection's.
 * Until 3.3.0 this picked the first pm connection the heartbeat had named,
 * which was right only while there was one property manager.
 *
 * ## Test or live
 *
 * The connection's own scope says which work orders it takes, `test` or
 * `live` (the owner's decision for phase 8). The lookup hands it back with the
 * test marker, so the page can refuse a row before reading its neighbours. The
 * server checks again whatever the page decided.
 */

import { NetworkError, NotSignedIn } from "./errors.js";

/** The server's own ceilings (integration.imports in the web app); larger batches are split. */
export const MAX_RECORDS = 100;
export const LOOKUP_MAX = 500;

/** The fields the server reads off a record. Anything else the page parsed stays here. */
const FIELDS = ["number", "native_id", "url", "street", "unit", "city", "state", "zip", "description"];

/**
 * @param {{ client: object }} parts
 */
export function create_imports({ client }) {
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

  /** Which page this is: its host and the company it shows. Without a host there is nothing to import through. */
  function where(page) {
    const host = String(page?.host || "").trim().toLowerCase();
    const company = String(page?.company || "").replace(/\s+/g, " ").trim();

    return host === "" ? null : { host, company };
  }

  function no_page() {
    return { ok: false, reason: "unknown_host", error: "This page's address could not be read, so nothing can be imported from it." };
  }

  return {
    /**
     * What the web app holds for these numbers: the job each was imported as.
     * Plus the connection's mode and the test marker, for the page to refuse
     * rows by.
     *
     * @param {{host: string, company: string}} page
     */
    async lookup(numbers, page) {
      return guarded(async () => {
        const target = where(page);
        if (target === null) return no_page();

        const list = [...new Set((numbers || []).map((n) => String(n ?? "").trim()).filter((n) => n !== ""))].slice(0, LOOKUP_MAX);
        const answer = await client.import_lookup(target, list);
        if (!answer.ok) return refused(answer);

        return {
          ok: true,
          connection: answer.body.connection,
          scope: scope_of(answer.body),
          work_orders: answer.body.work_orders || {},
        };
      });
    },

    /**
     * Send records, a hundred at a time, and say what became of each, in the
     * order they were given. A batch the server refused whole stops the rest,
     * with the records it did not reach reported as not sent.
     *
     * @param {{host: string, company: string}} page
     */
    async send(records, page) {
      return guarded(async () => {
        const target = where(page);
        if (target === null) return no_page();

        const list = (records || []).map(trim_record);
        const results = [];
        let failure = null;

        for (let start = 0; start < list.length; start += MAX_RECORDS) {
          const batch = list.slice(start, start + MAX_RECORDS);
          const answer = await client.import_records(target, batch);

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
