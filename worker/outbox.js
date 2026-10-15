/**
 * Results on their way to the web app, kept until it has them.
 *
 * Legacy dropped a result report whose request failed, and the job it described
 * then sat claimed until its lease ran out — a real invoice becoming an unknown
 * one for a person to chase. Here a report is written to `storage.local` before
 * it is sent and removed only once the web app has answered it, so a lost
 * network, a lapsed access token or a dead service worker only delays it.
 *
 * That is safe because the server makes it safe: `complete` and `fail` are
 * idempotent by `attempt_uuid`, which is made once per report and kept with it,
 * so a resend gets exactly the answer the first send got. Resent until a 2xx or
 * a 409; a 409 is an answer too — `not_held` means the reaper already took the
 * lease back and verification will find the truth, and `uuid_reused` cannot
 * happen to a uuid made here.
 *
 * Kept: no answer at all, a 401 the token exchange could not fix, a 429, a 5xx.
 * Dropped with a note: a 400, 404 or 422, which would be refused the same way
 * forever (a body the server cannot read, a delivery that is not there, a
 * `verified_absent` outside a verification).
 */

import { NetworkError, NotSignedIn } from "./errors.js";

export const OUTBOX_KEY = "ash_worker_outbox";

const SETTLED = new Set([400, 404, 409, 422]);

export function create_outbox(env, client, journal) {
  let lane = Promise.resolve();

  function serialized(work) {
    const result = lane.then(work);

    lane = result.catch(() => {});

    return result;
  }

  async function entries() {
    return (await env.local.get(OUTBOX_KEY)) || [];
  }

  /** Remove one entry by uuid. */
  async function drop(uuid) {
    const current = await entries();

    await env.local.set(
      OUTBOX_KEY,
      current.filter((entry) => entry.uuid !== uuid),
    );
  }

  return {
    entries,

    /**
     * `{ uuid, delivery_id, kind: "complete"|"fail", body, about }` — written
     * once per uuid, so adding the same report twice (a resumed job re-adding
     * what it wrote before it died) changes nothing.
     */
    add(entry) {
      return serialized(async () => {
        const current = await entries();

        if (current.some((held) => held.uuid === entry.uuid)) return;

        await env.local.set(OUTBOX_KEY, [...current, { ...entry, queued_ms: env.now(), tries: 0 }]);
      });
    },

    /**
     * Send everything held, oldest first. Stops at the first request that got
     * no answer, since the next would get none either.
     *
     * Returns what each answered report was told, by uuid.
     */
    flush() {
      return serialized(async () => {
        const answered = {};

        for (const entry of await entries()) {
          let answer;

          try {
            answer = entry.kind === "complete"
              ? await client.complete(entry.delivery_id, entry.body)
              : await client.fail(entry.delivery_id, entry.body);
          } catch (error) {
            if (error instanceof NetworkError || error instanceof NotSignedIn) break;

            throw error;
          }

          if (answer.ok || SETTLED.has(answer.status)) {
            await drop(entry.uuid);

            answered[entry.uuid] = answer;

            await journal.add({
              ...(entry.about || {}),
              delivery_id: entry.delivery_id,
              outcome: answer.ok
                ? String(answer.body?.status || entry.kind)
                : `refused (${answer.status}${answer.body?.reason ? `, ${answer.body.reason}` : ""})`,
              note: String(answer.body?.note || (answer.ok ? "" : answer.body?.error || "")),
            });

            continue;
          }

          /* Kept for the next flush. Counted, so a report stuck for a day is
             visible rather than silently retried forever. */
          const current = await entries();

          await env.local.set(
            OUTBOX_KEY,
            current.map((held) => (held.uuid === entry.uuid ? { ...held, tries: held.tries + 1, last_status: answer.status } : held)),
          );
        }

        return answered;
      });
    },
  };
}
