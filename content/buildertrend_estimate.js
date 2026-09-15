/**
 * Writing an approved work order into a Buildertrend estimate.
 *
 * ## Why this talks to Buildertrend's own API instead of driving its form
 *
 * The first version filled the item drawer the way a person does. It failed six
 * runs in a row, and never once in its own logic: Ant Design dropdowns that had
 * not finished mounting when they were clicked, a virtualised list that does not
 * exist in a tab nobody is painting, and an "Unsaved changes" modal that a
 * cancelled drawer leaves behind — which then covered the screen and broke the
 * *next* run. Each fix cost a full manual cycle and uncovered the next one.
 *
 * Selecting a job had looked equally impossible until it turned out to be a
 * single POST. The same is true here. Captured off the live page:
 *
 *   GET  /api/Proposals/<jobId>/Worksheet        the worksheet id, the builder
 *                                                id, and every cost code
 *   POST /apix/v2/LineItems/add-estimate-line-items
 *        { parentId: <worksheetId>, lineItems: [ … ] }
 *
 * `lineItems` is an array, so a whole estimate is one request rather than one
 * drawer per line. And **Buildertrend takes `builderCost` and `ownerPrice` from
 * the client**, so the figures this system already computes are the figures it
 * stores — they are not re-derived on the way in.
 *
 * ## What is given up, and what replaces it
 *
 * The drawer computed Builder cost and Client price live, so a wrong figure was
 * caught *before* anything was committed. Posting has no such moment.
 *
 * So the first line is written **alone** and verified before the rest follow. A
 * wrong figure then costs one line instead of a whole estimate, and the caller
 * reports `unconfirmed` — a person looks — rather than pretending nothing
 * happened.
 *
 * ## What is unchanged
 *
 *   - Refuse unless the page is showing the expected job.
 *   - Refuse unless the estimate is empty. Unreadable counts as not empty.
 *   - Read every figure back off the page; never trust what was sent.
 *   - Cent-exact, never a tolerance.
 *
 * ## The cent
 *
 * A line's Client price can read a cent under the AppFolio invoice, because
 * Buildertrend applies markup to the unrounded product where this application
 * applies it to an already-rounded actual. The server predicts Buildertrend's
 * answer and sends it as `expected_client_price_cents`; everything here is
 * checked against that, never against the billed figure. Measured, not assumed
 * — see Money::buildertrend_client_price_cents().
 */

(() => {
  const SELECTORS = {
    job_search: "input[data-testid='JobSearch']",
    job_row: "[data-testid^='JobListItem-']",
  };

  const WAIT_MS = 15000;
  const POLL_MS = 200;

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const app = {
    /* ---- primitives ------------------------------------------------------ */

    native_setter(element) {
      if (element instanceof HTMLTextAreaElement)
        return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set || null;
      if (element instanceof HTMLInputElement)
        return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set || null;

      return null;
    },

    set_value(element, value) {
      if (!element) return false;

      const setter = app.native_setter(element);

      if (setter) setter.call(element, String(value));
      else element.value = String(value);

      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));

      return true;
    },

    /** Ant Design opens on mousedown, so a bare click() is not enough. */
    click(element) {
      if (!element) return false;

      for (const type of ["pointerdown", "mousedown", "mouseup", "click"])
        element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));

      return true;
    },

    async wait_for(read, timeout = WAIT_MS) {
      const until = Date.now() + timeout;

      for (;;) {
        let value = null;

        try {
          value = read();
        } catch {
          value = null;
        }

        if (value) return value;
        if (Date.now() >= until) return null;

        await sleep(POLL_MS);
      }
    },

    /* ---- money ----------------------------------------------------------- */

    /** "$1,234.56" to 123456. Null when it is not money at all. */
    to_cents(text) {
      const match = String(text ?? "").match(/([\d,]+)\.(\d{2})/);
      if (match === null) return null;

      const whole = Number(match[1].replace(/,/g, ""));
      const fraction = Number(match[2]);
      if (!Number.isFinite(whole) || !Number.isFinite(fraction)) return null;

      return whole * 100 + fraction;
    },

    dollars(cents) {
      const absolute = Math.abs(Number(cents) || 0);

      return `${cents < 0 ? "-" : ""}$${Math.floor(absolute / 100).toLocaleString()}.`
        + String(absolute % 100).padStart(2, "0");
    },

    /**
     * The figure printed beside a label, in cents.
     *
     * Walks outward from the label's own node rather than taking the largest
     * money-looking string on the page — the mistake the vendor filler made
     * once, where the biggest figure was the maintenance limit.
     */
    labelled_cents(label) {
      const node = [...document.querySelectorAll("*")]
        .find((element) => element.children.length === 0 && clean(element.textContent) === label);

      if (!node) return null;

      let box = node.parentElement;

      for (let depth = 0; depth < 4 && box; depth++, box = box.parentElement) {
        const money = [...box.querySelectorAll("*")]
          .filter((element) => element.children.length === 0 && /\$[\d,]+\.\d{2}/.test(clean(element.textContent)))
          .map((element) => app.to_cents(element.textContent))
          .filter((value) => value !== null);

        if (money.length > 0) return money[0];
      }

      return null;
    },

    /* ---- what the page is ------------------------------------------------ */

    /**
     * Is the screen showing the job we mean?
     *
     * Compared without case: the header renders the job name in capitals
     * (`JOB: [TEST] (19411-1) 415 BOYCE`) and `innerText` reports text as
     * *rendered*, so an exact comparison rejects the right job. The work-order
     * number inside the title is what makes it unique.
     */
    same_job(shown, wanted) {
      const a = clean(shown).toLowerCase();
      const b = clean(wanted).toLowerCase();

      return a !== "" && a === b;
    },

    job_title() {
      const text = clean(document.body?.innerText || "");
      const match = text.match(/JOB:\s*(.+?)(?:\s+Builder cost|\s+Estimate\b|$)/i);

      return match ? clean(match[1]) : "";
    },

    /**
     * Whether the estimate already holds anything.
     *
     * Keyed on **seeing the empty state**, so an unreadable or half-rendered
     * page answers "not empty" and refuses. The same fail-closed shape as the
     * vendor filler's already_invoiced().
     */
    is_empty() {
      const text = clean(document.body?.innerText || "");
      if (!/Add an estimate/i.test(text)) return false;

      return app.labelled_cents("Total price") === 0;
    },

    /**
     * Whether this script can be worked with yet.
     *
     * "Ready" now means *this script is running on a loaded Buildertrend page*,
     * because that is all the rest of the run needs — every step is an
     * authenticated fetch from this origin, and none of them touch the DOM.
     *
     * The job-search box is still accepted as an early yes, since it appears
     * before `readyState` settles on this SPA. But it is no longer the only
     * yes: making an API-only run wait for a particular element to render is
     * re-introducing exactly the dependency this leg was rewritten to shed.
     */
    state() {
      if (document.querySelector(SELECTORS.job_search) !== null) return "ready";

      return document.readyState === "complete" ? "ready" : "loading";
    },

    /* ---- Buildertrend's own calls ---------------------------------------- */

    /**
     * Everything about this job's estimate that the write needs.
     *
     * One authenticated read, and it means nothing has to be configured: the
     * worksheet id is per job, the builder id comes back with it, and the cost
     * codes arrive as a list so `8000 - General Handyman` is matched by its
     * title rather than carried as a magic number that would silently point at
     * the wrong code in another account.
     */
    async worksheet(job_id) {
      const job = Number(job_id);
      if (!Number.isFinite(job) || job <= 0) return { ok: false, error: "No Buildertrend job id was given." };

      try {
        const response = await fetch(`/api/Proposals/${job}/Worksheet`, {
          credentials: "include",
          headers: { PortalType: "1" },
        });

        if (!response.ok)
          return { ok: false, error: `Buildertrend would not open the estimate (${response.status}).` };

        const body = await response.json();
        const data = body?.data || {};

        const lines = app.read_lines(data);

        return {
          ok: true,
          worksheet_id: data.worksheetId ?? null,
          builder_id: data.builderId ?? null,
          job_id: data.jobId ?? null,
          /* The job's own name, so "is this the right job" can be answered
             without the page having painted. Secondary to the id — see
             read_lines() — and blank on an account where it is not populated,
             which is why its absence is not a refusal. */
          job_title: clean(data.takeoffProjectName || ""),
          lines,
          line_count: lines.length,
          builder_total_cents: lines.reduce((sum, line) => sum + line.builder_cost_cents, 0),
          total_cents: lines.reduce((sum, line) => sum + line.client_price_cents, 0),
          /* Both kinds of lock refuse: a locked estimate is somebody saying it
             is finished, and writing into it would be the machine overruling a
             person. */
          locked: data.worksheetLocked === true || data.isManuallyLocked === true,
          cost_codes: Array.isArray(data.costCodes)
            ? data.costCodes.map((code) => ({
                id: code.id,
                title: clean(code.title || code.name || code.costCodeTitle || ""),
                category_id: code.costCategoryId ?? null,
              }))
            : [],
        };
      } catch (error) {
        return { ok: false, error: `The estimate could not be read: ${String(error?.message || error)}` };
      }
    },

    /**
     * What Buildertrend actually stored, out of the worksheet it just served.
     *
     * This is the read-back, and it replaces reloading the estimate screen and
     * scraping the figure printed beside "Total price". That scrape is what
     * turned the first real write into an `unconfirmed`: the line was written
     * correctly and `/app/Estimate` came back showing only its job picker, with
     * no estimate body and no money on the page at all, so the label was never
     * found and a good write could not be told from a bad one.
     *
     * Reading it here instead is not merely more reliable, it is a better
     * answer. The page prints one rounded total; this returns **every line**,
     * with the two figures that matter per line — so the first-line check is
     * against that line rather than against a total that happens to equal it,
     * and a wrong figure names the line it is wrong on.
     *
     * Lines arrive grouped (`formatData` is the cost-code grouping the screen
     * draws), and the grouping is not this extension's business — flatten it.
     * Money arrives as dollars, and `Math.round` is safe on it for the same
     * reason the server's ceilings exist: no estimate line reaches the scale
     * where a float loses a cent.
     */
    read_lines(data) {
      const groups = Array.isArray(data?.formatData) ? data.formatData : [];

      return groups.flatMap((group) => (Array.isArray(group?.lineItems) ? group.lineItems : [])).map((line) => ({
        id: line.id ?? null,
        title: clean(line.itemTitle || ""),
        cost_code: clean(line.costCodeTitle || ""),
        cost_type: Array.isArray(line.costTypes) ? line.costTypes[0] ?? null : null,
        quantity: Number(line.quantity),
        unit_cost: Number(line.unitCost),
        markup: Number(line.markupPercent),
        builder_cost_cents: Math.round(Number(line.builderCost) * 100),
        client_price_cents: Math.round(Number(line.ownerPrice) * 100),
      }));
    },

    /** Buildertrend's Cost type numbers, read off two captured saves. */
    cost_type_id(kind) {
      const wanted = clean(kind).toLowerCase();

      if (wanted === "labor") return 1;
      if (wanted === "material") return 2;

      return null;
    },

    /**
     * One estimate line, in the shape Buildertrend's own form sends.
     *
     * Every figure is the server's — `builder_cost` is what this application
     * holds as the actual, and `client_price` is what it predicts Buildertrend
     * will compute. Nothing is worked out here, because two places computing
     * money is two places that can disagree.
     */
    line_item(item, worksheet, order) {
      const wanted_code = clean(item.cost_code);
      const code = worksheet.cost_codes.find((entry) => entry.title === wanted_code);

      if (!code) return { error: `Buildertrend has no cost code called "${wanted_code}".` };

      const cost_type = app.cost_type_id(item.cost_type);

      if (cost_type === null) return { error: `Buildertrend has no cost type for "${item.cost_type}".` };

      const quantity = Number(item.quantity);
      const unit_cost = Number(item.unit_cost);
      const markup = Number(item.markup);
      const builder_cost = Number(item.expected_builder_cost_cents) / 100;
      const client_price = Number(item.expected_client_price_cents) / 100;

      if (![quantity, unit_cost, markup, builder_cost, client_price].every(Number.isFinite))
        return { error: `The figures for "${item.title}" could not be read as numbers.` };

      const markup_amount = Number((client_price - builder_cost).toFixed(2));

      return {
        item: {
          id: 0,
          parentId: -1,
          costCode: code.id,
          costCategoryId: code.category_id,
          costTypes: [cost_type],
          title: String(item.title || "").slice(0, 255),
          description: String(item.title || "").slice(0, 255),
          internalNotes: "",
          unitType: "",
          quantity,
          unitCost: unit_cost,
          markupType: 1,
          markupPercent: markup,
          markupAmount: markup_amount,
          markupPerUnit: quantity > 0 ? Number((markup_amount / quantity).toFixed(4)) : 0,
          margin: client_price > 0 ? Number(((markup_amount / client_price) * 100).toFixed(2)) : 0,
          builderCost: builder_cost,
          ownerPrice: client_price,
          lineItemDisplayOrder: order,
          markedAs: -1,
          taxGroupId: -1,
          pageTypeEnum: 10,
          includeInCatalog: false,
          assemblyId: null,
          costCodeItemId: null,
          purchaseOrderLineItemId: null,
        },
      };
    },

    async write_lines(worksheet_id, line_items) {
      if (!worksheet_id) return { ok: false, error: "No worksheet to write to." };
      if (!Array.isArray(line_items) || line_items.length === 0) return { ok: true, written: 0 };

      try {
        const response = await fetch("/apix/v2/LineItems/add-estimate-line-items", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", PortalType: "1" },
          body: JSON.stringify({ parentId: worksheet_id, lineItems: line_items }),
        });

        return response.ok
          ? { ok: true, written: line_items.length }
          : { ok: false, error: `Buildertrend refused the estimate lines (${response.status}).` };
      } catch (error) {
        return { ok: false, error: `The estimate lines could not be sent: ${String(error?.message || error)}` };
      }
    },

    /**
     * Select a job by telling Buildertrend directly.
     *
     * The picker is virtualised, so selecting through it needs the tab in front
     * — which is the thing this extension should not be doing to somebody who
     * is working. Clicking a row is one POST, and the job id is already held as
     * `work_orders.buildertrend_url`.
     *
     * Safe to depend on because it writes nothing: it changes which job the
     * session is looking at, and the caller still refuses unless the page then
     * shows the expected job.
     */
    async select_by_api(job_id, builder_id) {
      const job = Number(job_id);
      const builder = Number(builder_id);

      if (!Number.isFinite(job) || job <= 0) return "No Buildertrend job id was given.";
      if (!Number.isFinite(builder) || builder <= 0) return "No Buildertrend builder id is known.";

      const selection = { jobId: job, builderId: builder };

      try {
        const response = await fetch("/api/jobpicker/SetJobPickerData", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", PortalType: "1" },
          body: JSON.stringify({
            selectedJobId: selection,
            selectedJobIds: [{ ...selection, jobStatus: 1 }],
            /* False, or the filter is left behind in somebody's picker. */
            persistFilters: false,
            filtersData: {
              keywordFilter: "",
              otherFilter: "1",
              leadStatusFilter: "",
              jobGroupFilter: [],
              projectManagerFilter: [],
              selectedBuilderFilter: builder,
            },
            useJobSession: false,
          }),
        });

        return response.ok ? null : `Buildertrend refused the job selection (${response.status}).`;
      } catch (error) {
        return `The job selection could not be sent: ${String(error?.message || error)}`;
      }
    },

    /** The picker, kept as the fallback for the day the call above changes. */
    async select_by_picker(title, number) {
      const wanted = clean(title);
      if (wanted === "") return "No job title was given to select.";
      if (app.same_job(app.job_title(), wanted)) return null;

      const search = await app.wait_for(() => document.querySelector(SELECTORS.job_search));
      if (search === null) return "Buildertrend's job list did not load.";

      app.set_value(search, String(number || wanted));

      const row = await app.wait_for(() => {
        const rows = [...document.querySelectorAll(SELECTORS.job_row)]
          .filter((element) =>
            /^[1-9]\d*$/.test((element.getAttribute("data-testid") || "").replace("JobListItem-", "")))
          .filter((element) => clean(element.textContent) === wanted);

        /* Exactly one, or none: two jobs sharing a title cannot be told apart,
           and picking either is a guess about which job gets the money. */
        return rows.length === 1 ? rows[0] : null;
      });

      if (row === null) {
        const seen = [...document.querySelectorAll(SELECTORS.job_row)]
          .map((element) => clean(element.textContent))
          .filter((text) => text !== "")
          .slice(0, 3);

        return seen.length === 0
          ? `Buildertrend's job list rendered no rows while searching for "${wanted}", `
            + "which usually means its tab was not in front."
          : `Buildertrend's job list did not show "${wanted}". It showed: ${seen.join(" | ")}.`;
      }

      app.click(row);

      const landed = await app.wait_for(() => (app.same_job(app.job_title(), wanted) ? true : null));

      return landed === null ? `Buildertrend did not switch to "${wanted}".` : null;
    },
  };

  /**
   * Write the estimate, first line first.
   *
   * `stage` says how far it got, because the caller has to tell "nothing
   * happened" from "some of it did" — the difference between a clean retry and
   * a person having to look at Buildertrend.
   */
  async function write(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    if (items.length === 0) return { ok: false, stage: "none", error: "That job had no estimate lines." };

    const wanted = clean(job.job_title);

    /* Re-asked here immediately before writing, and asked of Buildertrend
       rather than of the page.
     *
     * The background already gated this run on the same read — that is not
     * duplication worth removing, it is the gap between "was it safe a moment
     * ago" and "is it safe now", and this is the side that actually sends. It
     * used to compare the job name against the rendered header and read
     * emptiness off the printed total, which is a check that cannot tell an
     * empty estimate from an unpainted page. */
    const worksheet = await app.worksheet(job.buildertrend_job_id);
    if (worksheet.ok !== true) return { ok: false, stage: "none", error: worksheet.error };

    if (Number(worksheet.job_id) !== Number(job.buildertrend_job_id))
      return { ok: false, stage: "none", error: "Buildertrend answered about a different job than the one asked for." };

    if (wanted !== "" && worksheet.job_title !== "" && !app.same_job(worksheet.job_title, wanted))
      return {
        ok: false,
        stage: "none",
        error: `Buildertrend calls that job "${worksheet.job_title}" and this work order expects `
          + `"${wanted}". Nothing was written.`,
      };

    /* The only idempotency available: Buildertrend cannot be asked "have I
       already estimated this". Anything already there is left for a person. */
    if (worksheet.line_count !== 0)
      return {
        ok: false,
        stage: "none",
        blocked: true,
        error: `That job's estimate already has ${worksheet.line_count} line(s) in it, so nothing was added.`,
      };

    if (worksheet.locked)
      return { ok: false, stage: "none", blocked: true, error: "That estimate is locked in Buildertrend." };

    if (!worksheet.worksheet_id)
      return { ok: false, stage: "none", error: "Buildertrend did not say which worksheet to write to." };

    /* Built before anything is sent, so a cost code or cost type this account
       does not have is a refusal rather than half an estimate. */
    const built = [];

    for (const [index, item] of items.entries()) {
      const line = app.line_item({ ...item, cost_code: job.cost_code }, worksheet, index + 1);

      if (line.error) return { ok: false, stage: "none", error: line.error };

      built.push(line.item);
    }

    if (job.dry_run === true)
      return {
        ok: true,
        stage: "rehearsed",
        rehearsed: true,
        worksheet_id: worksheet.worksheet_id,
        would_send: built.length,
        first: `${built[0].title} — ${app.dollars(Math.round(built[0].ownerPrice * 100))}`,
      };

    /* The first line alone, so a wrong figure costs one line rather than a
       whole estimate. This is what replaces the drawer's before-you-save
       check, which posting does not have. */
    const first = await app.write_lines(worksheet.worksheet_id, [built[0]]);

    if (first.ok !== true) return { ok: false, stage: "none", error: first.error };

    return {
      ok: true,
      stage: "first_written",
      worksheet_id: worksheet.worksheet_id,
      rest: built.slice(1),
      /* Both halves of the first line's claim, because the read-back checks
         both: what ASH was charged and what the client is charged are two
         different assertions, and a markup gone wrong can leave one right. */
      expected_first_builder_cents: Math.round(built[0].builderCost * 100),
      expected_first_cents: Math.round(built[0].ownerPrice * 100),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const type = message?.type;

    if (type === "ESTIMATE_PAGE_STATUS") {
      respond({ state: app.state() });

      return true;
    }

    if (type === "ESTIMATE_INSPECT") {
      respond({
        ok: true,
        url: location.href,
        job_title: app.job_title(),
        is_empty: app.is_empty(),
        total_cents: app.labelled_cents("Total price"),
        builder_cost_cents: app.labelled_cents("Builder cost"),
      });

      return true;
    }

    if (type === "ESTIMATE_SELECT_JOB") {
      const payload = message.payload || {};

      const chosen = payload.use_picker === true
        ? app.select_by_picker(payload.title, payload.number)
        : app.select_by_api(payload.job_id, payload.builder_id);

      chosen
        .then((error) =>
          respond(error === null
            ? { ok: true, method: payload.use_picker === true ? "picker" : "api", job_title: app.job_title() }
            : { ok: false, error }))
        .catch((error) => respond({ ok: false, error: String(error?.message || error) }));

      return true;
    }

    if (type === "ESTIMATE_WRITE") {
      write(message.payload || {})
        .then(respond)
        .catch((error) => respond({ ok: false, stage: "unknown", error: String(error?.message || error) }));

      return true;
    }

    /* The rest of an estimate, once the first line has been checked. */
    if (type === "ESTIMATE_WRITE_REST") {
      const payload = message.payload || {};

      app.write_lines(payload.worksheet_id, payload.items || [])
        .then(respond)
        .catch((error) => respond({ ok: false, error: String(error?.message || error) }));

      return true;
    }

    /* The builder id, so nothing has to be configured for job selection. */
    if (type === "ESTIMATE_WORKSHEET") {
      app.worksheet(message.payload?.job_id)
        .then(respond)
        .catch((error) => respond({ ok: false, error: String(error?.message || error) }));

      return true;
    }

    /* Anything else is not ours. Said explicitly, because a listener that falls
       off the end closes the port and makes sendMessage resolve `undefined`
       rather than throw — which is how the landing lookup failed silently for
       six runs. */
    return false;
  });

  /**
   * Say, on the page itself, that this script is running.
   *
   * Whether a content script was injected at all is otherwise invisible from
   * everywhere except the script — the background sees only "no answer", which
   * reads identically to a page that is slow, broken, or showing the wrong
   * thing.
   */
  document.documentElement.dataset.nssEstimate = "ready";
})();
