/**
 * What a silent page's failure says (worker/silence.js, 4.1.9): the wait the
 * command was in, whether the page was hidden, how late its timers ran, its
 * long tasks and freezes — or that even the status check went unanswered.
 * The browser half, a real page answering the check, is chrome_env_test.js.
 */

import { BUSY, explain_silence } from "../../worker/silence.js";

const DIAG = {
  visibility: "hidden",
  active: [
    { command: "state", for_ms: 900, stage: "waiting for the inspection page to render", stage_for_ms: 900 },
    { command: "attach_photos", for_ms: 29400, stage: "waiting for Refrigerator's form to open", stage_for_ms: 28950 },
  ],
  worst_timer_lag_ms: 14230,
  long_tasks: { count: 3, total_ms: 2140 },
  freezes: 0,
  resumes: 0,
  ticks: 112,
};

export default {
  "a silent command is told by the wait it was in, the page's visibility and its late timers"(t) {
    t.equal(
      explain_silence(DIAG, "attach_photos"),
      `: it was at "waiting for Refrigerator's form to open" for 29 s; the page was hidden; its timers ran up to 14.2 s late; long tasks held it for 2.1 s of the last minute`,
    );
  },

  "a page that could not answer even the status check is a held main thread"(t) {
    t.ok(/main thread is busy/.test(explain_silence(BUSY, "sheet")));
  },

  "Chrome's own word on the tab is added: frozen or not, in front or behind, its group open or collapsed"(t) {
    const frozen = { frozen: true, discarded: false, status: "complete", active: false, group_collapsed: true };

    t.equal(
      explain_silence(BUSY, "find_in_list", frozen),
      ", and did not answer a status check either: its main thread is busy, or Chrome has frozen it (Chrome reports the tab frozen, it was a background tab, in a collapsed group)",
    );
    t.equal(
      explain_silence(DIAG, "attach_photos", { frozen: false, discarded: false, status: "loading", active: false, group_collapsed: false }).split("; ").at(-1),
      "Chrome reports the tab not frozen, it was still loading, it was a background tab, in an open group",
    );
    /* An older Chrome has no frozen flag: nothing is claimed either way. */
    t.equal(explain_silence(null, "sheet", { frozen: null, discarded: false, status: "complete", active: true, group_collapsed: null }), ": it was the tab in front");
  },

  "a page with no status check, and one whose timers ran on time, add only what is known"(t) {
    t.equal(explain_silence(null, "sheet"), "");
    t.equal(
      explain_silence({ visibility: "visible", active: [], worst_timer_lag_ms: 40, long_tasks: { count: 0, total_ms: 0 }, freezes: 2 }, "sheet"),
      ": it had finished every command, so the answer was lost on the way; the page was visible; its timers were on time; Chrome froze it 2 times",
    );
  },
};
