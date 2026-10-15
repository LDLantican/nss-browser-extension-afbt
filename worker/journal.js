/**
 * What this browser's worker did lately, newest first, for the popup.
 *
 * Not the record of anything — the web app's delivery attempts are that, and
 * they are written whether or not this browser survives to read its answer.
 * This is the short local account that lets the popup say "submitted WO-000123"
 * or "gave WO-000124 back: the connection was paused" without a round trip.
 */

export const JOURNAL_KEY = "ash_worker_journal";

const KEEP = 30;

export function create_journal(env) {
  let lane = Promise.resolve();

  return {
    async list() {
      return (await env.local.get(JOURNAL_KEY)) || [];
    },

    /** `{ delivery_id, public_id, operation, mode, outcome, note }` */
    add(entry) {
      const result = lane.then(async () => {
        const current = (await env.local.get(JOURNAL_KEY)) || [];

        await env.local.set(JOURNAL_KEY, [{ at: env.now(), ...entry }, ...current].slice(0, KEEP));
      });

      lane = result.catch(() => {});

      return result;
    },
  };
}
