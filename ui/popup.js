/**
 * The popup: what has happened, and what still needs a person.
 *
 * It is deliberately **not** where work is started. Choosing which work orders
 * to sync happens on the Appfolio page, where the manager can see them; this
 * shows the ledger afterwards and gives her the two things a ledger needs —
 * a retry, and enough of the reason to know whether retrying is the answer.
 *
 * The popup is also assumed to be closed most of the time. It is destroyed the
 * moment focus returns to the page, which in v1 meant every outcome message was
 * delivered to nothing; notifications and the toolbar badge are how a result
 * gets seen now, and this is what you open when you want the detail.
 *
 * So it renders from state it asks for on open, rather than subscribing to
 * events it will not be alive to receive.
 */

const els = {
  alert: document.getElementById("alert"),
  setup: document.getElementById("setup"),
  setup_note: document.getElementById("setup-note"),
  setup_go: document.getElementById("setup-go"),
  main: document.getElementById("main"),
  who: document.getElementById("who"),
  sync_tally: document.getElementById("sync-tally"),
  jobs: document.getElementById("jobs"),
  sync_actions: document.getElementById("sync-actions"),
  bt_panel: document.getElementById("bt-panel"),
  bt_tally: document.getElementById("bt-tally"),
  bt_jobs: document.getElementById("bt-jobs"),
  bt_actions: document.getElementById("bt-actions"),
  bt_pending: document.getElementById("bt-pending"),
  bt_probe: document.getElementById("bt-probe"),
  delivery_tally: document.getElementById("delivery-tally"),
  delivery_actions: document.getElementById("delivery-actions"),
  delivery_probe: document.getElementById("delivery-probe"),
  foot_note: document.getElementById("foot-note"),
  open_settings: document.getElementById("open-settings"),
};

/** Human wording for each ledger state, and whether it needs a person. */
const STATES = {
  queued: { label: "Queued", needs_person: false },
  sending: { label: "Sending", needs_person: false },
  retry: { label: "Will retry", needs_person: false },
  synced: { label: "Synced", needs_person: false },
  conflict: { label: "Address differs", needs_person: true },
  rejected: { label: "Rejected", needs_person: true },
  blocked: { label: "Blocked", needs_person: true },
};

async function ask(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, payload })) ?? {};
  } catch (error) {
    return { ok: false, error: error?.message || "The extension is not responding." };
  }
}

function say(text, kind = "warn") {
  if (!text) {
    els.alert.hidden = true;

    return;
  }

  els.alert.hidden = false;
  els.alert.textContent = text;
  els.alert.className = `notice notice--${kind}`;
}

function button(label, className, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", handler);

  return element;
}

async function render() {
  const state = await ask("STATE");

  if (state.ok === false) {
    say(state.error || "Could not read the extension's state.", "error");

    return;
  }

  const configured = String(state.settings?.app_url || "").trim() !== "";
  const signed_in = state.session?.signed_in === true;

  /* Nothing else is worth rendering if the queue cannot be sent. Both causes
     have the same remedy and it is one button. */
  if (!configured || !signed_in) {
    els.setup.hidden = false;
    els.main.hidden = true;
    els.setup_note.textContent = configured
      ? "Sign in to the ASH web app to sync work orders and see their status."
      : "Add the address of the ASH web app, then sign in.";

    els.foot_note.textContent = "";

    return;
  }

  els.setup.hidden = true;
  els.main.hidden = false;

  els.who.textContent = state.session.user?.name
    ? `${state.session.user.name} · ${state.session.device_name || "this browser"}`
    : state.session.device_name || "";

  render_sync(state);
  await render_delivery();
  render_bt(state);

  const stamp = state.session.checked_at
    ? new Date(state.session.checked_at).toLocaleString()
    : "";
  els.foot_note.textContent = stamp === "" ? "" : `Last checked ${stamp}`;

  if (refreshed) return;

  refreshed = true;

  /* A heartbeat on open, so a token revoked from /account is noticed here
     rather than at the moment a manager tries to sync twenty rows. */
  const beat = await ask("HEARTBEAT");

  if (beat.status === "signed_out") {
    say(beat.error || "This device is no longer signed in.", "error");
    render();

    return;
  }

  if (beat.status === "unreachable") {
    say(`Cannot reach the web app right now. ${beat.error || ""}`.trim(), "warn");
  } else {
    say("");
  }

  /* What was just drawn is the extension's memory. This checks it against the
     web app and draws again, so a work order removed there stops showing here.
     Local first, because it is instant and the lookup is a round trip. */
  const fresh = await ask("REFRESH");
  const removed = fresh.removed || {};
  const cleared = (removed.synced || 0) + (removed.pending || 0);

  await render();

  if (cleared > 0)
    say(
      `${cleared} work order${cleared === 1 ? "" : "s"} no longer in the web app ${cleared === 1 ? "was" : "were"} cleared.`,
      "ok",
    );
}

/**
 * Set once the open-time checks have run.
 *
 * render() is called again after every action, and those re-renders only need
 * to redraw — the heartbeat and the refresh belong to opening the popup.
 */
let refreshed = false;

/**
 * " against test work orders", or nothing at all.
 *
 * Only said for `sample`, which is the exception to the rule the AppFolio bar
 * follows — there the mode is stated permanently, because the question it
 * answers is "is what I am about to send real?" and it is asked before every
 * action. Here it is a report of something already done, and appending "against
 * real work orders" to every ordinary delivery notice would be noise on the
 * line a manager reads a hundred times a day.
 */
function scope_note(summary) {
  return summary?.scope === "sample" ? " against test work orders" : "";
}

/**
 * The page probe's answer, as something a person can read or screenshot.
 *
 * Plain text on purpose. Its whole reason for existing is to be sent to whoever
 * can compare it against what the content script looks for, and a tidy list of
 * found/missing lines survives a screenshot or a chat message intact.
 *
 * Only the hooks that *should* be on this page are checked, because every page
 * holds about a quarter of the selector map and a reader cannot tell an expected
 * zero from a broken selector. 
 */
function describe_probe(report) {
  const lines = [];
  const money = (cents) =>
    cents === null || cents === undefined ? "none" : `$${(cents / 100).toFixed(2)}`;

  lines.push(`page    : ${report.page || "?"}${report.state === "signed_out" ? "  (SIGNED OUT)" : ""}`);

  /* First, and unmissable. Every reading under it is taken from the DOM as it
     stands, and on a half-rendered page that means "" and null and 0 — which
     is exactly how a blank page used to read as a healthy one. */
  if (report.loading) lines.push(`loading : YES — readings below are unreliable`);
  if (report.list_state) lines.push(`list    : ${report.list_state}`);
  if (report.number) lines.push(`number  : ${report.number}`);
  if (report.status) lines.push(`status  : ${report.status}`);
  lines.push(`limit   : ${money(report.maintenance_limit_cents)}`);
  lines.push(`invoiced: ${report.already_invoiced ? "YES" : "no"}`);

  const expected = report.expected || [];
  const found = report.found || {};

  if (expected.length > 0) {
    lines.push("");
    lines.push("hooks this page should have");

    for (const key of expected)
      lines.push(
        `  ${found[key] > 0 ? "found  " : "MISSING"}  ${key.replace(/_/g, " ")}  (${found[key] ?? 0})`,
      );

    if ((report.missing || []).length === 0) {
      lines.push("");
      lines.push("all present.");
    }
  }

  /* The tab walk, which is the whole point of running this on the list page.
     Two things to read it for: `no status badges` against a tab that has rows
     means js-summary-status has moved, and that is the single selector the
     delivery gate classifies on; and a state of `loading` means that tab never
     finished, which is the reading the first version of this printed as a
     confident `0 rows`. */
  if (report.list) {
    lines.push("");
    lines.push(`tabs (started on ${report.list.started_on || "?"})`);

    for (const tab of report.list.tabs || []) {
      const badges = Object.entries(tab.statuses || {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => `${label} ${count}`)
        .join(", ");

      const state = (tab.state || (tab.confirmed ? "loaded" : "loading")).padEnd(8);

      lines.push(`  ${state}  ${tab.label}  ${tab.rows} rows`);

      if (tab.state === "loaded") lines.push(`      ${badges || "NO STATUS BADGES FOUND"}`);
      else if (tab.state === "filtered") lines.push("      a status filter is excluding every row");
      else if (tab.state === "loading") lines.push("      never finished loading; nothing was read");
    }
  }

  if (report.hint) {
    lines.push("");
    lines.push(report.hint);
  }

  return lines.join(String.fromCharCode(10));
}

/** What a rehearsal saw, per job. */
function describe_reports(reports) {
  if (reports.length === 0) return "Nothing was waiting to be rehearsed.";

  return reports
    .map((entry) => {
      const head = `${entry.number}: ${entry.ok ? "OK" : "STOPPED"}`;

      if (entry.ok)
        return `${head}\n  expected  ${entry.expected}\n  page said ${entry.read_back}`;

      return `${head}\n  ${entry.error || "no reason given"}`;
    })
    .join("\n\n");
}

/**
 * Delivering approved work back to the Appfolio vendor portal.
 *
 * Deliberately stateless, unlike the two panels either side of it. Those render
 * from a ledger this extension keeps; the delivery queue lives in the web app,
 * and asking for it on every popup open would be a network round trip to
 * display a number nobody is waiting on — delivery runs on a one-minute alarm
 * whether or not anybody is looking.
 *
 * So this panel is a button and an explanation. The button exists for the
 * manager who has just approved something and does not want to wait a minute,
 * and for anybody testing that the whole path works.
 */
async function render_delivery() {
  els.delivery_tally.textContent =
    "Approved work is delivered to Appfolio automatically, about once a minute.";

  els.delivery_actions.innerHTML = "";

  /* The page check below is an instrument, not an errand, so it is only offered
     where it can actually run. Same test as the service worker's own guard, so
     the button is present in exactly the cases the handler accepts. `tabs` is
     already in the manifest, which is what makes `url` readable here. */
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const on_portal = String(tab?.url || "").startsWith("https://vendor.appfolio.com");

  els.delivery_actions.appendChild(
    button("Deliver now", "btn btn--quiet", async (event) => {
      const pressed = event.currentTarget;

      pressed.disabled = true;
      pressed.textContent = "Delivering.";

      const result = await ask("DELIVER_NOW");

      pressed.disabled = false;
      pressed.textContent = "Deliver now";

      if (result.ok === false) {
        /* Three different sign-ins can fail here and they have three different
           fixes, so none of them may be worded as another. The portal one now
           also puts its tab in front of her, so "the tab just opened" is a
           place she can actually look. */
        const reasons = {
          vendor_signed_out:
            "Nobody is signed in to the AppFolio vendor portal. Sign in on the tab just opened, then try again.",
          signed_out:
            "This device is no longer signed in to the web app. Open Settings and sign in again.",
          not_permitted: "This account is not allowed to deliver invoices.",

          /* Its own wording because it is not a sign-in problem and the three
             above are. Nothing is wrong with this device; the web app did not
             say which work orders it may bill, and guessing between a test job
             and a real client's invoice is not something a retry should do
             quietly. */
          scope_unknown:
            "The web app did not say which work orders it may deliver, so nothing was sent.",
        };

        say(reasons[result.error] || result.error || "Delivery could not run.", "error");

        return;
      }

      const summary = result.summary || {};

      /* Ahead of `paused`, because it is the more specific answer and the more
         actionable one: there is a filled invoice on a tab with her name on it.
         Without this the run reads as "Nothing was waiting to be delivered",
         which is both wrong and the opposite of what she should do next. */
      if (summary.awaiting_submit === true) {
        say(summary.reason || "An invoice is filled in and waiting to be submitted.", "warn");

        return;
      }

      if (summary.paused === true) {
        say(summary.reason || "Delivery is paused because too much has failed recently.", "warn");

        return;
      }

      /* A rehearsal's whole output is what it found, so it goes in the probe
         block rather than being compressed into the one-line notice. */
      if (summary.dry_run === true) {
        els.delivery_probe.hidden = false;
        els.delivery_probe.textContent = describe_reports(result.reports || []);

        say(
          summary.rehearsed
            ? `Rehearsed${scope_note(summary)} without writing anything. Nothing was submitted.`
            : "Rehearsal stopped early - see below.",
          summary.rehearsed ? "ok" : "warn",
        );

        return;
      }

      /* `held back` matches config/work_orders.php's label for the same state.
         It was missing here, which meant a run that refused five jobs and
         delivered none said "Nothing was waiting to be delivered." — and the
         tab gate above makes a refusal the ordinary outcome for an
         already-invoiced job, so it would have become the common lie. */
      const parts = [
        summary.delivered ? `${summary.delivered} delivered` : "",
        summary.unconfirmed ? `${summary.unconfirmed} need checking` : "",
        summary.blocked ? `${summary.blocked} held back` : "",
        summary.failed ? `${summary.failed} failed` : "",

        /* Step E is deliberately not fatal, so these jobs are billed and
           correct — they are just still sitting on In Progress in AppFolio,
           which is somebody's tidying rather than anybody's money. Reported
           here because this is the only place it can be: a delivered row's
           last_error is nulled, so the server has nowhere to keep it. */
        summary.left_open ? `${summary.left_open} still In Progress` : "",

        /* A note keeps whatever photographs it could take, so these jobs are
           billed and their notes are posted — just short. Worth saying out
           loud: a note is the client's proof of work, and the one that goes out
           with fewer photographs than the job has looks exactly like one that
           went out complete. */
        summary.photos_missing ? `${summary.photos_missing} photos not attached` : "",
      ].filter(Boolean);

      say(
        parts.length === 0
          ? `Nothing was waiting to be delivered${scope_note(summary)}.`
          : parts.join(" \u00b7 ") + scope_note(summary) + ".",
        summary.unconfirmed || summary.failed || summary.blocked ? "warn" : "ok",
      );
    }),
  );

  /* A diagnostic rather than an action — it reads a vendor page and writes
     nothing on it — so it takes `.link` and sits after the real button, the way
     Clear synced sits after Retry all that failed.

     It takes a present-tense label like Deliver now does: on the list page it
     clicks through all three tabs and back, each bounded by the content
     script's own ten-second budget, so a disabled button with its original text
     on it looks dead for up to forty seconds. */
  if (on_portal)
    els.delivery_actions.appendChild(
      button("Check this page", "link", async (event) => {
        const pressed = event.currentTarget;

        pressed.disabled = true;
        pressed.textContent = "Checking.";

        const result = await ask("PROBE_PAGE");

        pressed.disabled = false;
        pressed.textContent = "Check this page";

        if (result.ok === false) {
          els.delivery_probe.hidden = true;
          say(result.error || "Could not read that page.", "warn");

          return;
        }

        say("");
        els.delivery_probe.hidden = false;
        els.delivery_probe.textContent = describe_probe(result.report || {});
      }),
    );
}

function render_sync(state) {
  const counts = state.counts || {};
  const jobs = Object.values(state.jobs || {});

  els.sync_tally.textContent =
    jobs.length === 0
      ? "Nothing waiting. Tick work orders on the Appfolio list to sync them."
      : [
          counts.synced ? `${counts.synced} synced` : "",
          counts.pending ? `${counts.pending} in progress` : "",
          counts.attention ? `${counts.attention} need a look` : "",
        ]
          .filter(Boolean)
          .join(" · ");

  /* Rows needing a person first, then in-progress, then the finished ones. The
     list is read top-down and the top is where the work is. */
  const order = ["conflict", "rejected", "blocked", "retry", "sending", "queued", "synced"];

  jobs.sort(
    (a, b) =>
      order.indexOf(a.state) - order.indexOf(b.state) ||
      String(b.updated_at).localeCompare(String(a.updated_at)),
  );

  els.jobs.innerHTML = "";

  for (const job of jobs) els.jobs.appendChild(job_row(job, state));

  els.sync_actions.innerHTML = "";

  if (counts.attention > 0)
    els.sync_actions.appendChild(
      button("Retry all that failed", "btn btn--quiet", async () => {
        const numbers = jobs
          .filter((job) => STATES[job.state]?.needs_person)
          .map((job) => job.number);

        await ask("RETRY", { numbers });
        render();
      }),
    );

  if (counts.synced > 0)
    els.sync_actions.appendChild(
      button("Clear synced", "link", async () => {
        await ask("CLEAR_FINISHED");
        render();
      }),
    );
}

function job_row(job, state) {
  const item = document.createElement("li");
  item.className = "job";

  const head = document.createElement("div");
  head.className = "job__head";

  const number = document.createElement("span");
  number.className = "job__number";
  number.textContent = job.number;
  head.appendChild(number);

  const pill = document.createElement("span");
  pill.className = `pill pill--${job.state}`;
  pill.textContent = STATES[job.state]?.label || job.state;
  head.appendChild(pill);

  item.appendChild(head);

  const where = document.createElement("p");
  where.className = "job__where";
  where.textContent = [job.payload?.street, job.payload?.city]
    .filter(Boolean)
    .join(", ");
  item.appendChild(where);

  if (job.error) {
    const why = document.createElement("p");
    why.className = "job__why";
    why.textContent = job.error;
    item.appendChild(why);
  }

  const actions = document.createElement("p");
  actions.className = "job__actions";

  /* A conflict is the one state where the useful action is not a retry: the
     same request has the same answer, and what is needed is a person looking
     at both addresses. So the link goes to the record rather than the queue. */
  if (job.state === "conflict" && job.existing?.id) {
    const base = String(state.settings?.app_url || "").replace(/\/+$/, "");

    const open = document.createElement("a");
    open.className = "link";
    open.href = `${base}/work-orders/${job.existing.id}`;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = `Open ${job.existing.number} in the web app`;
    actions.appendChild(open);
  } else if (STATES[job.state]?.needs_person) {
    actions.appendChild(
      button("Retry", "link", async () => {
        await ask("RETRY", { numbers: [job.number] });
        render();
      }),
    );
  } else if (job.state === "synced" && job.work_order_id) {
    const base = String(state.settings?.app_url || "").replace(/\/+$/, "");

    const open = document.createElement("a");
    open.className = "link";
    open.href = `${base}/work-orders/${job.work_order_id}`;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = job.server?.status_label
      ? `Open · ${job.server.status_label}`
      : "Open in the web app";
    actions.appendChild(open);
  }

  if (actions.childElementCount > 0) item.appendChild(actions);

  return item;
}

/**
 * What the last Buildertrend run did, as something a person can read or paste.
 *
 * Same plain-text shape as describe_probe(), and for the same reason — it
 * exists to be sent to whoever can compare it against what the scripts look
 * for, and a flat list survives a screenshot or a chat message intact.
 *
 * It leads with the step that failed and the page's own words for it. Three
 * separate faults in this leg were diagnosed by inference from the web
 * server's access log because the extension knew exactly what went wrong and
 * told nobody; every line here is something it already computed.
 */
function describe_bt_run(run) {
  if (!run) return "";

  const lines = [];
  const when = new Date(run.finished_at || run.started_at || Date.now());
  const seconds = Math.round(((run.finished_at || 0) - (run.started_at || 0)) / 1000);

  lines.push(`run     : ${when.toLocaleString()}  (${seconds}s)`);

  const summary = run.summary || {};

  lines.push(
    `result  : ${summary.created || 0} linked · ${summary.unidentified || 0} unidentified · `
    + `${summary.failed || 0} failed · ${summary.skipped || 0} not attempted`,
  );

  if (summary.stopped && summary.reason) lines.push(`stopped : ${summary.reason}`);

  for (const job of run.jobs || []) {
    lines.push("");
    lines.push(`${job.number}`);
    lines.push(`  created : ${job.created ? "yes" : "NO"}`);

    if (job.url) lines.push(`  url     : ${job.url}`);
    if (job.error) lines.push(`  problem : ${job.error}`);

    const detail = job.detail || {};

    /* The two that separate "the page never ran" from "the page ran and said
       no" — which need opposite fixes and used to read identically. */
    if (detail.stage) {
      lines.push(
        `  lookup  : stage=${detail.stage} answered=${detail.answered ? "yes" : "NO"}`
        + ` attempts=${detail.attempts ?? "?"} reloaded=${detail.reloaded ? "yes" : "no"}`,
      );
    }

    if (detail.searched !== undefined) lines.push(`  searched: "${detail.searched}"`);
    if (detail.wanted !== undefined) lines.push(`  wanted  : "${detail.wanted}"`);

    if (detail.row_count !== undefined) {
      lines.push(`  rows    : ${detail.row_count}`);

      /* The evidence for the commonest failure: the title is matched exactly,
         so seeing what the rows actually said settles it at a glance. */
      for (const row of detail.sample || []) lines.push(`    ${row.id}  "${row.title}"`);
    }

    if (job.link) {
      lines.push(
        `  link    : ${job.link.ok ? "recorded" : "REFUSED"} `
        + `status=${job.link.status || 0}${job.link.error ? ` — ${job.link.error}` : ""}`,
      );
    } else if (job.created && !job.url) {
      lines.push(`  link    : not attempted — no id to record`);
    }
  }

  return lines.join("\n");
}

const NEWLINE = String.fromCharCode(10);

/**
 * What the last estimate run did, in the same pasteable plain text as the
 * delivery probe and the job-creation record.
 */
function describe_estimate_run(run) {
  const lines = [];
  const summary = run.summary || {};

  lines.push(`estimates : ${new Date(run.at || Date.now()).toLocaleString()}`);
  lines.push(
    `result    : ${summary.delivered || 0} written · ${summary.rehearsed || 0} rehearsed · `
    + `${summary.blocked || 0} blocked · ${summary.unconfirmed || 0} unconfirmed · ${summary.failed || 0} failed`,
  );

  if (run.error) lines.push(`problem   : ${run.error}`);
  if (summary.reason) lines.push(`reason    : ${summary.reason}`);

  for (const report of run.reports || []) {
    lines.push("");
    lines.push(`${report.number}  ${report.ok ? "ok" : "NOT DONE"}`);
    if (report.expected) lines.push(`  expected: ${report.expected}`);
    /* A rehearsal's whole product. It sends nothing, so the payload it *would*
       have sent is the only thing there is to check — printing the total and
       not the lines is a rehearsal that reports almost nothing. */
    if (report.note) lines.push(`  would do: ${report.note}`);
    if (report.error) lines.push(`  problem : ${report.error}`);
  }

  return lines.join(NEWLINE);
}

function render_bt(state) {
  if (state.settings?.buildertrend_enabled === false) {
    els.bt_panel.hidden = true;

    return;
  }

  els.bt_panel.hidden = false;

  const queue = Object.values(state.bt_queue || {});

  els.bt_tally.textContent =
    queue.length === 0
      ? "Nothing waiting. Syncing from Appfolio creates the Buildertrend jobs too."
      : `${queue.length} waiting to be entered.`;

  els.bt_jobs.innerHTML = "";

  for (const work_order of queue) {
    const item = document.createElement("li");
    item.className = "job";

    const head = document.createElement("div");
    head.className = "job__head";

    const number = document.createElement("span");
    number.className = "job__number";
    number.textContent = work_order.number;
    head.appendChild(number);

    head.appendChild(
      button("Fill in Buildertrend", "btn btn--quiet job__go", async (event) => {
        const element = event.currentTarget;
        element.disabled = true;
        element.textContent = "Opening…";

        const result = await ask("FILL_JOB", { number: work_order.number });

        /* A refusal is not a fill, and it used to be shown as one: the error
           appeared at the top of the panel while the button underneath said
           "Running in its tab…", so the two halves of the popup contradicted
           each other and the manager was left waiting for a job that was never
           going to appear. Seen for real when the web app was unreachable —
           `fill_job` refuses before it opens any tab, so there was no tab and
           nothing running.

           The button goes back to offering the thing it failed to do, which is
           also what makes the refusal actionable: fix the cause, press again. */
        if (result?.ok === false) {
          if (result.error) say(result.error, "error");

          element.disabled = false;
          element.textContent = "Fill in Buildertrend";

          return;
        }

        /* No re-render here. The fill runs in its own tab and takes tens of
           seconds, and this popup will be shut long before it finishes — the
           notification and the badge are what report it. */
        element.textContent = "Running in its tab…";
      }),
    );

    head.appendChild(
      button("Remove", "link link--danger", async () => {
        await ask("UNQUEUE_FROM_BT", { numbers: [work_order.number] });
        render();
      }),
    );

    item.appendChild(head);

    const where = document.createElement("p");
    where.className = "job__where";
    where.textContent = [work_order.street, work_order.city]
      .filter(Boolean)
      .join(", ");
    item.appendChild(where);

    els.bt_jobs.appendChild(item);
  }

  /* Jobs Buildertrend already holds that the web app cannot point at.
   *
   * Listed separately from the queue because they are the opposite situation:
   * the queue is work not done, this is work done and unrecorded. Putting them
   * in one list would invite pressing Fill on a job that already exists, which
   * is how a duplicate gets made. */
  const pending = Object.entries(state.bt_pending_links || {});

  els.bt_pending.innerHTML = "";

  for (const [number, entry] of pending) {
    const item = document.createElement("li");
    item.className = "job";

    const head = document.createElement("div");
    head.className = "job__head";

    const label = document.createElement("span");
    label.className = "job__number";
    label.textContent = number;
    head.appendChild(label);

    head.appendChild(
      button("Link now", "btn btn--quiet job__go", async (event) => {
        const element = event.currentTarget;
        element.disabled = true;
        element.textContent = entry?.url ? "Recording…" : "Looking…";

        const result = await ask("LINK_NOW", { number });

        if (result?.ok === false && result.error) say(result.error, "error");
        else say(`${number} is linked to Buildertrend.`, "ok");

        render();
      }),
    );

    item.appendChild(head);

    const why = document.createElement("p");
    why.className = "job__where";
    why.textContent = entry?.url
      ? "In Buildertrend. The web app has not accepted the link yet."
      : "In Buildertrend. Its job could not be identified, so the link is unknown.";
    item.appendChild(why);

    els.bt_pending.appendChild(item);
  }

  if (pending.length > 0)
    els.bt_tally.textContent += ` ${pending.length} waiting to be linked to the web app.`;

  /* Only shown when it has something to say about a failure. On a clean run it
     would be noise, and the panel is read most when something went wrong. */
  const run = state.bt_last_run;
  const worth_showing =
    run && ((run.summary?.unidentified || 0) > 0 || (run.summary?.failed || 0) > 0 || pending.length > 0);

  /* The estimate run's own account, kept because the banner that used to carry
     it is cleared by the popup's heartbeat on the next open — so the first
     rehearsal reported its result to nobody.

     A run that touched no job and hit no error has nothing to account for, and
     shown forever it reads as a report about work that is not there. */
  const estimate_run = state.bt_last_estimate_run;
  const estimate_worth_showing =
    estimate_run && ((estimate_run.reports || []).length > 0 || estimate_run.error || estimate_run.summary?.reason);
  const estimate_text = estimate_worth_showing ? describe_estimate_run(estimate_run) : "";

  const text = [worth_showing ? describe_bt_run(run) : "", estimate_text].filter(Boolean).join(NEWLINE + NEWLINE);

  els.bt_probe.hidden = text === "";
  els.bt_probe.textContent = text;

  els.bt_actions.innerHTML = "";

  /* Asked for rather than scheduled. The job is selected by API and the lines
     are posted by API, so the tab stays hidden for the whole run and nothing
     takes anybody's focus — the picker fallback that used to bring one forward
     is gone. It is still a button rather than an alarm because an estimate is a
     real write into somebody else's system, and a person choosing the moment is
     worth more than a minute's latency. */
  els.bt_actions.appendChild(
    button("Write Buildertrend estimates", "btn btn--quiet", async (event) => {
      const element = event.currentTarget;
      element.disabled = true;
      element.textContent = "Writing…";

      const result = await ask("DELIVER_ESTIMATES");
      const summary = result?.summary || {};

      if (result?.ok === false) say(summary.reason || result.error || "The estimates could not be written.", "error");
      else if ((summary.delivered || 0) > 0) say(`${summary.delivered} written to Buildertrend.`, "ok");
      else if ((summary.rehearsed || 0) > 0) say(`${summary.rehearsed} rehearsed. Nothing was written.`, "ok");
      else say("Nothing was waiting for an estimate.", "ok");

      render();
    }),
  );

  if (queue.length > 0)
    els.bt_actions.appendChild(
      /* Clears the Buildertrend queue only. v1's "Clear All" called
         storage.local.clear(), which emptied the whole storage area — and now
         that the area holds a sign-in token, that would have signed the manager
         out as a side effect of tidying a list. */
      button("Clear the Buildertrend queue", "link link--danger", async () => {
        await ask("CLEAR_BT_QUEUE");
        render();
      }),
    );
}

els.open_settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.setup_go.addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
