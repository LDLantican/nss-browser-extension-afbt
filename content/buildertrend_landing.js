/**
 * Finding the job Buildertrend just saved, on the page it lands on.
 *
 * ## Why this page at all
 *
 * Saving a new job does not take you to the job. Buildertrend redirects to
 * `/app/Landing`, and the id appears nowhere in the URL at any point of the
 * journey.
 *
 * That matters because the whole reason the extension creates the job is so an
 * estimate can be attached to it later, and an estimate needs to know *which*
 * job. The id has to be read from somewhere, and Landing is where it becomes
 * knowable.
 *
 * ## Why it searches rather than reads the selection
 *
 * This file used to read the *selected* job, on the assumption that saving one
 * selects it. **It does not.** Measured against a live page: after saving
 * `(19410-1)`, Landing still showed `(19409-1)` as the selected job in
 * `landingPageUserJob`, `jobName` and the picker header. Reading the selection
 * would have recorded the previous job's id against the new work order — two
 * work orders pointing at one Buildertrend job, which is exactly the kind of
 * wrong a billing link must never be.
 *
 * The title check caught it and refused, so nothing was recorded. That was the
 * right outcome from a wrong premise, and the premise is what changed here.
 *
 * The job picker is the fix. It is a docked sidebar on Landing — not a popup,
 * nothing to open — and it carries the id where the selection never did: each
 * row is `[data-testid='JobListItem-<id>']` with the job's title as its text.
 * The list is virtualised over ~900 jobs, so it is filtered by the work-order
 * number first and only then matched, which is why the search box is driven at
 * all.
 *
 * ## Why it still refuses rather than guesses
 *
 * The match is on the **exact** title, and two jobs sharing one refuses both.
 * Being unable to identify a job that really was saved is recoverable — the
 * work order visibly has no link and the manager is told to look — while
 * recording the wrong id is a silent, permanent mispointing that the estimate
 * leg would then bill against. It is the same rule the client row id follows on
 * the new-job form: trusting whichever row comes back first is worse than
 * requiring a match.
 *
 * ## It needs the tab to be visible, and that is not a detail
 *
 * The picker is virtualised over ~900 jobs, and Chrome does not paint a hidden
 * tab — so in a background tab the rows are not offscreen, they are **absent
 * from the DOM**. Measured: the identical query returns one row while the tab
 * is foregrounded and zero while it is not. Nothing here can work around that,
 * so the background brings the tab forward before each attempt; see
 * `read_saved_job()` in background/buildertrend.js.
 *
 * ## The search box is left as it was found
 *
 * This runs in the manager's own tab, on a page they are looking at. A filter
 * left in the picker is this extension's debris in somebody else's UI, so the
 * box is cleared on the way out whether the lookup succeeded or not.
 */

(() => {
  /**
   * Stamped on every reply, because "no answer" and "the wrong script answered"
   * look identical to the caller and are not the same problem.
   *
   * Buildertrend's move from the new-job page to Landing is a same-document
   * navigation, so Chrome neither injects this script nor tears down the
   * add-job one — which stays alive and *does* receive LANDING_FIND_JOB. Its
   * listener does not recognise the type, falls off the end without calling
   * sendResponse, and Chrome closes the port: `sendMessage` then resolves with
   * `undefined` rather than throwing. The caller's recovery keyed off a throw,
   * so it never fired, and twelve attempts reported nothing at all.
   *
   * A marker makes the distinction checkable instead of inferable.
   */
  const LANDING_REPLY = "buildertrend_landing";

  const SEARCH = "input[data-testid='JobSearch']";
  const ROW = "[data-testid^='JobListItem-']";

  /* Long enough for a virtualised list over ~900 jobs to filter and paint, and
     short enough that the caller's own retry loop still gets several goes
     inside its budget. */
  const LOOKUP_BUDGET_MS = 12000;
  const POLL_MS = 250;

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Type into the search box the way React can see.
   *
   * The picker's search is a genuine `<input>`, so the value tracker applies
   * here exactly as it does on the new-job form: assigning `.value` leaves
   * React's last-known value untouched and the `input` event is discarded as a
   * no-op. Unlike the job-type field on that form, this one is not a `<div>`
   * wearing an input's name — so the setter is safe to call, and needed.
   */
  function type_into(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Poll until `read` answers with something truthy, or the budget runs out. */
  async function wait_for(read, budget) {
    const until = Date.now() + budget;

    for (;;) {
      const value = read();

      if (value) return value;
      if (Date.now() >= until) return null;

      await sleep(POLL_MS);
    }
  }

  /**
   * The picker's rows, as `{ id, title }`.
   *
   * `JobListItem-0` is the list's own "View N Jobs" header rather than a job,
   * which is why the id has to be a real number and not merely present.
   */
  function rows() {
    return [...document.querySelectorAll(ROW)]
      .map((element) => ({
        id: (element.getAttribute("data-testid") || "").replace("JobListItem-", ""),
        title: clean(element.textContent),
      }))
      .filter((row) => /^[1-9]\d*$/.test(row.id));
  }

  /**
   * What the page actually had, for a failure to carry back with it.
   *
   * A refusal that says only "it was not there" is what made this leg
   * undebuggable: the caller could not tell an empty list from a list whose
   * rows read differently from the title being matched. Since the match is an
   * exact comparison against the row's whole collapsed text, the rows
   * themselves are the evidence, so a few of them travel with the error.
   *
   * Capped at five and truncated, because this is read in a popup and pasted
   * into a chat, not scrolled.
   */
  function seen(query, wanted) {
    const present = rows();

    return {
      searched: query,
      wanted,
      row_count: present.length,
      sample: present.slice(0, 5).map((row) => ({ id: row.id, title: row.title.slice(0, 80) })),
    };
  }

  async function find_job(title, query) {
    const wanted = clean(title);

    if (wanted === "")
      return { from: LANDING_REPLY, ok: false, error: "No job title was given to look for.", detail: { wanted, searched: query } };

    /* Landing paints its picker after the redirect settles, so the box is
       waited for rather than assumed. */
    const search = await wait_for(() => document.querySelector(SEARCH), LOOKUP_BUDGET_MS);

    if (search === null)
      return {
        from: LANDING_REPLY,
        ok: false,
        error: "Buildertrend's job list did not load, so nothing was recorded.",
        detail: { ...seen(query, wanted), search_box: false },
      };

    type_into(search, query);

    const matches = await wait_for(() => {
      const found = rows().filter((row) => row.title === wanted);

      return found.length > 0 ? found : null;
    }, LOOKUP_BUDGET_MS);

    /* Read before the box is cleared: clearing re-renders the list, and the
       rows worth reporting are the ones the match was actually run against. */
    const evidence = { ...seen(query, wanted), search_box: true };

    type_into(search, "");

    if (matches === null)
      return {
        from: LANDING_REPLY,
        ok: false,
        error: `Buildertrend's job list did not show "${wanted}", so nothing was recorded.`,
        detail: evidence,
      };

    const ids = new Set(matches.map((match) => match.id));

    if (ids.size > 1)
      return {
        from: LANDING_REPLY,
        ok: false,
        error:
          `Buildertrend has more than one job called "${wanted}", so none of them was recorded. `
          + "Check which one is the new job before running it again.",
        detail: evidence,
      };

    const id = [...ids][0];

    return { from: LANDING_REPLY, ok: true, id, url: `${location.origin}/app/JobPage/${id}/1` };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "LANDING_FIND_JOB") return false;

    const title = message.payload?.title || "";

    /* The number is the narrow, unique half of the title and the only part
       worth filtering ~900 jobs by. Falling back to the whole title keeps this
       working if a work order somehow arrives without one. */
    const query = clean(message.payload?.number) || clean(title);

    find_job(title, query)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ from: LANDING_REPLY, ok: false, error: String(error?.message || error) }));

    return true;
  });
})();
