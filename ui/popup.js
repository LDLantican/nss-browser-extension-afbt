/**
 * The popup: is everything all right, and does anything need me?
 *
 * Written for whoever is doing the day's work, not for whoever is debugging it.
 * So it shows one status line, the jobs a person has to do something about, and
 * a folded list of what went through — and nothing else. The page checks, the
 * run reports and the separate invoice and estimate buttons are all in Settings
 * > Troubleshooting, where there is room to read a report and nobody meets one
 * by accident.
 *
 * It is deliberately **not** where work is started. Choosing which work orders
 * to sync happens on the Appfolio page, and sending approved work happens by
 * itself every minute; Send now only skips the wait.
 *
 * The popup is also assumed to be closed most of the time. It is destroyed the
 * moment focus returns to the page, so notifications and the toolbar badge are
 * how a result gets seen, and it renders from state it asks for on open rather
 * than subscribing to events it will not be alive to receive.
 */

import { REASONS, scope_note } from "./describe.js";

const els = {
  alert: document.getElementById("alert"),
  setup: document.getElementById("setup"),
  setup_note: document.getElementById("setup-note"),
  setup_go: document.getElementById("setup-go"),
  main: document.getElementById("main"),
  who: document.getElementById("who"),
  status: document.getElementById("status"),
  attention: document.getElementById("attention"),
  attention_list: document.getElementById("attention-list"),
  attention_actions: document.getElementById("attention-actions"),
  recent: document.getElementById("recent"),
  recent_summary: document.getElementById("recent-summary"),
  recent_list: document.getElementById("recent-list"),
  recent_clear: document.getElementById("recent-clear"),
  foot: document.getElementById("foot"),
  auto_note: document.getElementById("auto-note"),
  send_now: document.getElementById("send-now"),
  open_settings: document.getElementById("open-settings"),
  tab_errors: document.getElementById("tab-errors"),
  tab_errors_view: document.getElementById("tab-errors-view"),
};

/** Plain wording for each ledger state, and whether it needs a person. */
const STATES = {
  queued: { label: "Waiting", needs_person: false },
  sending: { label: "Sending", needs_person: false },
  retry: { label: "Trying again", needs_person: false },
  synced: { label: "Sent", needs_person: false },
  conflict: { label: "Address doesn't match", needs_person: true },
  rejected: { label: "Not accepted", needs_person: true },
  blocked: { label: "Needs a look", needs_person: true },
};

/** Rows needing a person first; the list is read top-down. */
const ORDER = ["conflict", "rejected", "blocked"];

/**
 * The two queues going *out*, as the popup words them.
 *
 * The status line used to count only work coming in, so a vendor portal signed
 * out over a weekend — every approved invoice queued, nothing claimed, nothing
 * on /deliveries — read as "All caught up".
 */
const OUTGOING = {
  invoices: {
    site: "appfolio",
    title: "AppFolio invoices",
    noun: ["approved invoice", "approved invoices"],
    signed_out: "vendor_signed_out",
    portal: "the AppFolio vendor portal",
  },
  estimates: {
    site: "buildertrend",
    title: "Buildertrend estimates",
    noun: ["approved estimate", "approved estimates"],
    signed_out: "buildertrend_signed_out",
    portal: "Buildertrend",
  },
};

/**
 * How old a queue's record may be before the popup stops vouching for it.
 *
 * The timer writes one every minute. Older than this means no run has finished
 * lately — the browser has just started, or a long drain is still going — and
 * neither a stale problem nor a stale all-clear is worth showing.
 */
const OUTGOING_STALE_MS = 10 * 60 * 1000;

/** Refusals that are not this popup's to raise: the setup panel and Settings own them. */
const OUTGOING_IGNORED = new Set(["signed_out", "not_permitted"]);

/** Refusals worth raising even when the run never learned how much was waiting. */
const OUTGOING_BLOCKING = new Set(["extension_outdated", "scope_unknown"]);

async function ask(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, payload })) ?? {};
  } catch (error) {
    return { ok: false, error: error?.message || "The extension is not responding." };
  }
}

function say(text, kind = "warn", link = null) {
  if (!text) {
    els.alert.hidden = true;

    return;
  }

  els.alert.hidden = false;
  els.alert.className = `notice notice--${kind}`;
  els.alert.textContent = text;

  if (link) {
    els.alert.append(" ");
    els.alert.appendChild(anchor(link.href, link.label));
  }
}

function button(label, className, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", handler);

  return element;
}

function anchor(href, label) {
  const element = document.createElement("a");
  element.className = "link";
  element.href = href;
  element.target = "_blank";
  element.rel = "noreferrer";
  element.textContent = label;

  return element;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function app_base(state) {
  return String(state.settings?.app_url || "").trim().replace(/\/+$/, "");
}

/** Last state rendered, so Send now can link to the web app without asking again. */
let last_state = null;

async function render() {
  const state = await ask("STATE");

  if (state.ok === false) {
    say(state.error || "Something went wrong reading the extension.", "error");

    return;
  }

  last_state = state;

  const configured = app_base(state) !== "";
  const signed_in = state.session?.signed_in === true;

  /* Nothing else is worth rendering if the queue cannot be sent. Both causes
     have the same remedy and it is one button. */
  if (!configured || !signed_in) {
    els.setup.hidden = false;
    els.main.hidden = true;
    els.foot.hidden = true;
    els.setup_note.textContent = configured
      ? "Sign in to the ASH web app to start sending work orders."
      : "Add the ASH web app's address in Settings, then sign in.";

    return;
  }

  els.setup.hidden = true;
  els.main.hidden = false;
  els.foot.hidden = false;

  const name = state.session.user?.name || state.session.user?.email || "";
  els.who.textContent = name === "" ? "" : `Signed in as ${name}`;
  els.who.hidden = name === "";

  const bt_on = state.settings?.buildertrend_enabled !== false;

  els.auto_note.textContent = bt_on
    ? "Approved work is sent to AppFolio and Buildertrend automatically every minute."
    : "Approved work is sent to AppFolio automatically every minute.";

  els.tab_errors.hidden = (Number(state.tab_errors_unseen) || 0) === 0;

  const jobs = Object.values(state.jobs || {});
  const failed = jobs
    .filter((job) => STATES[job.state]?.needs_person)
    .sort((a, b) =>
      ORDER.indexOf(a.state) - ORDER.indexOf(b.state)
      || String(b.updated_at).localeCompare(String(a.updated_at)));

  const bt_queue = bt_on ? Object.values(state.bt_queue || {}) : [];
  const bt_pending = bt_on ? Object.entries(state.bt_pending_links || {}) : [];

  const outgoing = read_outgoing(state, bt_on);

  render_status(
    outgoing.problems.length + failed.length + bt_queue.length + bt_pending.length,
    state.counts?.pending || 0,
    outgoing.unchecked,
  );
  render_attention(state, outgoing.problems, failed, bt_queue, bt_pending);
  render_recent(state, jobs.filter((job) => job.state === "synced"), bt_on);

  if (refreshed) return;

  refreshed = true;

  /* A heartbeat on open, so a token revoked from /account is noticed here
     rather than at the moment a manager tries to sync twenty rows. */
  const beat = await ask("HEARTBEAT");

  if (beat.status === "signed_out") {
    say("This browser is no longer signed in to the web app. Open Settings to sign in again.", "error");
    render();

    return;
  }

  if (beat.status === "unreachable") say("Can't reach the web app right now. Try again in a minute.", "warn");
  else say("");

  /* What was just drawn is the extension's memory. This checks it against the
     web app and draws again, so a work order removed there stops showing here. */
  const fresh = await ask("REFRESH");
  const removed = fresh.removed || {};
  const cleared = (removed.synced || 0) + (removed.pending || 0);

  await render();

  if (cleared > 0)
    say(`${plural(cleared, "work order was", "work orders were")} removed from the web app, so ${cleared === 1 ? "it was" : "they were"} cleared from this list.`, "ok");
}

/**
 * Set once the open-time checks have run.
 *
 * render() is called again after every action, and those re-renders only need
 * to redraw — the heartbeat and the refresh belong to opening the popup.
 */
let refreshed = false;

/**
 * What the outgoing queues need from a person, from their last recorded run.
 *
 * `unchecked` is true while a queue that runs by itself has no recent record,
 * so the line says it is checking rather than claiming all is well.
 */
function read_outgoing(state, bt_on) {
  const records = state.delivery || {};
  const now = Date.now();
  const problems = [];
  let unchecked = false;

  for (const [kind, words] of Object.entries(OUTGOING)) {
    if (kind === "estimates" && !bt_on) continue;

    const automatic = kind === "invoices" || state.settings?.bt_auto_estimates !== false;
    const record = records[kind];
    const fresh = record && now - (Number(record.at) || 0) <= OUTGOING_STALE_MS;

    if (!fresh) {
      if (automatic) unchecked = true;

      continue;
    }

    const problem = outgoing_problem(words, record);
    if (problem) problems.push(problem);
  }

  return { problems, unchecked };
}

function outgoing_problem(words, record) {
  const waiting = Number(record.waiting) || 0;
  const [one, many] = words.noun;

  /* The count when the run read one; a refusal before the read says only that
     there is work, which is still the thing worth knowing. */
  const waiting_text = waiting > 0
    ? `${plural(waiting, one, many)} ${waiting === 1 ? "is" : "are"} waiting.`
    : `${many[0].toUpperCase()}${many.slice(1)} are waiting.`;

  if (record.error === words.signed_out)
    return {
      title: words.title,
      label: "Signed out",
      text: `${waiting_text} Sign in to ${words.portal} and they will go out within a minute.`,
      action: { label: "Sign in", site: words.site },
    };

  if (record.paused)
    return {
      title: words.title,
      label: "Paused",
      text: record.reason || "Sending is paused because several recent tries failed.",
      action: { label: "Open Deliveries", deliveries: true },
    };

  if (record.awaiting_submit)
    return {
      title: words.title,
      label: "Waiting for you",
      text: "An invoice is filled in and waiting for you to press Submit Invoice in AppFolio.",
    };

  if (record.ok || OUTGOING_IGNORED.has(record.error)) return null;

  /* A refusal that left known work queued, or one that stops every run until
     somebody acts. A failed read with nothing known to be waiting is left to
     the heartbeat's "can't reach the web app". */
  if (waiting === 0 && !OUTGOING_BLOCKING.has(record.error)) return null;

  return {
    title: words.title,
    label: "Not sent",
    text: `${waiting > 0 ? `${waiting_text} ` : ""}${record.reason || REASONS[record.error] || record.error}`,
    action: { label: "Try again", send: true },
  };
}

/** One line: attention first, then work in flight, then all clear. */
function render_status(attention, in_progress, unchecked = false) {
  if (attention > 0) {
    els.status.className = "status status--warn";
    els.status.textContent = `${plural(attention, "thing needs", "things need")} your attention`;
  } else if (in_progress > 0) {
    els.status.className = "status status--busy";
    els.status.textContent = `Sending ${plural(in_progress, "work order", "work orders")} to the web app…`;
  } else if (unchecked) {
    els.status.className = "status status--busy";
    els.status.textContent = "Checking for approved work…";
  } else {
    els.status.className = "status status--ok";
    els.status.textContent = "All caught up";
  }
}

function render_attention(state, outgoing, failed, bt_queue, bt_pending) {
  els.attention.hidden = outgoing.length + failed.length + bt_queue.length + bt_pending.length === 0;
  els.attention_list.innerHTML = "";

  for (const problem of outgoing) els.attention_list.appendChild(outgoing_row(problem, state));

  for (const job of failed) els.attention_list.appendChild(failed_row(job, state));
  for (const [number, entry] of bt_pending) els.attention_list.appendChild(pending_link_row(number, entry));
  const in_flight = new Set((state.bt_in_flight || []).map(String));

  for (const work_order of bt_queue)
    els.attention_list.appendChild(bt_queue_row(work_order, in_flight.has(String(work_order.number))));

  els.attention_actions.innerHTML = "";

  /* Conflicts are left out: the same request gets the same answer, and what
     they need is a person comparing two addresses. */
  const retryable = failed.filter((job) => job.state !== "conflict");

  if (retryable.length > 1)
    els.attention_actions.appendChild(
      button("Try them all again", "btn btn--quiet", async () => {
        await ask("RETRY", { numbers: retryable.map((job) => job.number) });
        render();
      }),
    );
}

function render_recent(state, synced, bt_on) {
  els.recent.hidden = synced.length === 0;
  els.recent_summary.textContent = `Recently sent (${synced.length})`;
  els.recent_list.innerHTML = "";

  synced.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  for (const job of synced) {
    const { item, head } = row(job.number, job.server?.status_label || "", "synced");

    if (job.work_order_id)
      head.appendChild(anchor(`${app_base(state)}/work-orders/${job.work_order_id}`, "Open"));

    const chips = outside_chips(job.server?.outside, bt_on);

    if (chips.length > 0) {
      const holder = document.createElement("div");
      holder.className = "job__chips";

      for (const chip of chips) {
        const pill = document.createElement("span");
        pill.className = `pill pill--${chip.tone}`;
        pill.textContent = chip.label;
        pill.title = chip.title;
        holder.appendChild(pill);
      }

      item.appendChild(holder);
    }

    els.recent_list.appendChild(item);
  }
}

/**
 * Where one job stands outside the web app: its BuilderTrend job, its AppFolio
 * invoice, its BuilderTrend estimate.
 *
 * Read from the lookup's `outside` block, which the web app computes and the
 * REFRESH on open keeps current. Nothing here is remembered or inferred: an
 * older web app that sends no block gets no chips, because a chip that might be
 * stale is worse than none. Display only — nothing that drains a queue reads it.
 *
 * The words carry the state as well as the colour, so the row reads the same
 * to somebody who cannot tell amber from green.
 */
function outside_chips(outside, bt_on) {
  if (!outside || typeof outside !== "object") return [];

  const chips = [];

  const delivery = (noun, state) => {
    const words = {
      delivered: ["synced", `${noun} sent`, `The ${noun.toLowerCase()} is in.`],
      pending: ["queued", `${noun} queued`, `The ${noun.toLowerCase()} is waiting to go out.`],
      claimed: ["queued", `${noun} sending`, `The ${noun.toLowerCase()} is being written now.`],
      submitting: ["queued", `${noun} sending`, `The ${noun.toLowerCase()} is being written now.`],
      failed: ["blocked", `${noun} failed`, "It will be tried again. Deliveries in the web app says why."],
      blocked: ["blocked", `${noun} held`, "Held back for a person. Deliveries in the web app says why."],
      unconfirmed: ["rejected", `${noun} unsure`, "It may already be there. Check before retrying, on Deliveries."],
    }[state];

    return words ? { tone: words[0], label: words[1], title: words[2] } : null;
  };

  if (bt_on && outside.buildertrend_job)
    chips.push(
      outside.buildertrend_job.state === "done"
        ? { tone: "synced", label: "BT job", title: "The job exists in BuilderTrend." }
        : { tone: "none", label: "No BT job", title: "Not in BuilderTrend yet." },
    );

  const invoice = outside.appfolio_invoice;
  const invoice_chip = invoice ? delivery("Invoice", invoice.state) : null;

  if (invoice_chip) {
    /* Invoiced, and Work Done did not land. Not a money problem, so amber rather
       than red, and never shown for `null` — that is a delivery nobody reported
       on, not one known to be open. */
    if (invoice.state === "delivered" && invoice.work_done === false)
      chips.push({
        tone: "blocked",
        label: "Invoice · open",
        title: "Invoiced, but Work Done was not pressed in AppFolio. Deliveries in the web app lists it.",
      });
    else chips.push(invoice_chip);
  }

  if (bt_on && outside.buildertrend_estimate) {
    const estimate_chip = delivery("Estimate", outside.buildertrend_estimate.state);
    if (estimate_chip) chips.push(estimate_chip);
  }

  return chips;
}

/** A row's skeleton: number, a pill, and room for a line or two under it. */
function row(number, label, tone) {
  const item = document.createElement("li");
  item.className = "job";

  const head = document.createElement("div");
  head.className = "job__head";

  const title = document.createElement("span");
  title.className = "job__number";
  title.textContent = number;
  head.appendChild(title);

  if (label) {
    const pill = document.createElement("span");
    pill.className = `pill pill--${tone}`;
    pill.textContent = label;
    head.appendChild(pill);
  }

  item.appendChild(head);

  return { item, head };
}

function line(item, className, text) {
  if (!text) return;

  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  item.appendChild(element);
}

function failed_row(job, state) {
  const { item, head } = row(job.number, STATES[job.state]?.label || job.state, job.state);

  /* A conflict is the one state where the useful action is not a retry: the
     same request has the same answer, and what is needed is a person looking
     at both addresses. So the link goes to the record rather than the queue. */
  if (job.state === "conflict" && job.existing?.id) {
    head.appendChild(anchor(`${app_base(state)}/work-orders/${job.existing.id}`, "Open in web app"));
  } else {
    head.appendChild(
      button("Try again", "btn btn--quiet job__go", async () => {
        await ask("RETRY", { numbers: [job.number] });
        render();
      }),
    );
  }

  line(item, "job__where", [job.payload?.street, job.payload?.city].filter(Boolean).join(", "));
  line(item, "job__why", job.error);

  return item;
}

/** A whole outgoing queue that is stuck, as one row with its one fix. */
function outgoing_row(problem, state) {
  const { item, head } = row(problem.title, problem.label, "conflict");
  const action = problem.action;

  if (action?.site)
    head.appendChild(
      button(action.label, "btn btn--quiet job__go", async () => {
        const result = await ask("OPEN_SIGN_IN", { site: action.site });

        if (result?.ok === false && result.error) say(result.error, "error");
      }),
    );
  else if (action?.deliveries)
    head.appendChild(anchor(`${app_base(state)}/deliveries`, action.label));
  else if (action?.send)
    head.appendChild(button(action.label, "btn btn--quiet job__go", () => send_now()));

  line(item, "job__why", problem.text);

  return item;
}

/**
 * Jobs Buildertrend already holds that the web app cannot point at.
 *
 * Kept visibly apart from the queue by their wording because they are the
 * opposite situation: the queue is work not done, this is work done and
 * unrecorded. Pressing Add on a job that already exists is how a duplicate
 * gets made, and Link now never opens the add-job page.
 */
function pending_link_row(number, entry) {
  const { item, head } = row(number, "Not linked yet", "conflict");

  head.appendChild(
    button("Link now", "btn btn--quiet job__go", async (event) => {
      const element = event.currentTarget;
      element.disabled = true;
      element.textContent = "Linking…";

      const result = await ask("LINK_NOW", { number });

      if (result?.ok === false && result.error) say(result.error, "error");
      else say(`${number} is linked to Buildertrend.`, "ok");

      render();
    }),
  );

  line(item, "job__where", entry?.url
    ? "It's in Buildertrend, but the web app hasn't saved the link yet."
    : "It's in Buildertrend, but we couldn't tell which job it is.");

  return item;
}

function bt_queue_row(work_order, adding = false) {
  const { item, head } = row(work_order.number, "Not in Buildertrend", "queued");

  /* A run already holds this row. The popup closes when the run's tab takes
     focus, so reopening it used to offer Add again mid-run — and pressing it
     made a second real job. */
  if (adding) {
    const element = button("Adding to Buildertrend…", "btn btn--quiet job__go", () => {});
    element.disabled = true;
    head.appendChild(element);

    line(item, "job__where", [work_order.street, work_order.city].filter(Boolean).join(", "));

    return item;
  }

  head.appendChild(
    button("Add to Buildertrend", "btn btn--quiet job__go", async (event) => {
      const element = event.currentTarget;
      element.disabled = true;
      element.textContent = "Opening…";

      const result = await ask("FILL_JOB", { number: work_order.number });

      if (result?.busy) {
        say("Buildertrend is already adding jobs. Press Add again when that run finishes.", "warn");
        element.textContent = "Already adding…";

        return;
      }

      /* A refusal is not a fill. The button goes back to offering the thing it
         failed to do, which is what makes the refusal actionable: fix the
         cause, press again. */
      if (result?.ok === false) {
        if (result.error) say(result.error, "error");

        element.disabled = false;
        element.textContent = "Add to Buildertrend";

        return;
      }

      /* No re-render here. The fill runs in its own tab and takes tens of
         seconds, and this popup will be shut long before it finishes — the
         notification and the badge are what report it. */
      element.textContent = "Adding in its own tab…";
    }),
  );

  head.appendChild(
    button("Remove", "link link--danger", async () => {
      await ask("UNQUEUE_FROM_BT", { numbers: [work_order.number] });
      render();
    }),
  );

  line(item, "job__where", [work_order.street, work_order.city].filter(Boolean).join(", "));

  return item;
}

/**
 * Send now, said in one sentence.
 *
 * Settings > Troubleshooting has the same two runs separately with every count
 * they keep. This picks the one thing worth saying, in order of what a person
 * should do about it: a refusal they can fix, an invoice waiting for their
 * press, something to look at on /deliveries, and only then what went well.
 */
function describe_send(result, state) {
  const running = (run) => run?.skipped === "already running";

  if (result.busy || running(result.invoices) || running(result.estimates)) return { text: "Already sending. Check back in a minute.", kind: "ok" };

  const invoices = result.invoices || {};
  const estimates = result.estimates || {};
  const invoice_summary = invoices.summary || {};
  const estimate_summary = estimates.summary || {};
  const deliveries = { href: `${app_base(state)}/deliveries`, label: "Open Deliveries" };

  for (const run of [invoices, estimates]) {
    if (run.ok !== false || run.quiet) continue;

    return {
      text: REASONS[run.error] || run.summary?.reason || run.error || "Sending didn't work. Try again in a minute.",
      kind: "error",
    };
  }

  if (invoice_summary.awaiting_submit)
    return { text: "An invoice is filled in and waiting for you to press Submit Invoice in AppFolio.", kind: "warn" };

  if (invoice_summary.paused || estimate_summary.paused)
    return { text: "Sending is paused because several recent tries failed.", kind: "warn", link: deliveries };

  const trouble = ["unconfirmed", "blocked", "failed"].reduce(
    (total, key) => total + (invoice_summary[key] || 0) + (estimate_summary[key] || 0), 0);

  if (trouble > 0)
    return { text: `${plural(trouble, "job needs", "jobs need")} a look.`, kind: "warn", link: deliveries };

  if (invoice_summary.dry_run || (estimate_summary.rehearsed || 0) > 0)
    return {
      text: `Practice run finished${scope_note(invoice_summary)}. Nothing was submitted. Details are in Settings.`,
      kind: "ok",
    };

  const parts = [
    invoice_summary.delivered ? `${plural(invoice_summary.delivered, "invoice", "invoices")} sent to AppFolio` : "",
    estimate_summary.delivered ? `${plural(estimate_summary.delivered, "estimate", "estimates")} written to Buildertrend` : "",
  ].filter(Boolean);

  if (parts.length === 0) return { text: "Nothing is waiting to be sent.", kind: "ok" };

  return { text: `${parts.join(" · ")}${scope_note(invoice_summary)}.`, kind: "ok" };
}

async function send_now() {
  els.send_now.disabled = true;
  els.send_now.textContent = "Sending…";

  const result = await ask("SEND_NOW");

  els.send_now.disabled = false;
  els.send_now.textContent = "Send now";

  if (result.ok === false) {
    say(result.error || "Sending didn't work. Try again in a minute.", "error");

    return;
  }

  const { text, kind, link } = describe_send(result, last_state || {});

  say(text, kind, link);

  /* The run just rewrote where the queues stand, so the status line and the
     rows under it are redrawn from that rather than from before the press. */
  render();
}

els.send_now.addEventListener("click", send_now);

els.recent_clear.addEventListener("click", async () => {
  await ask("CLEAR_FINISHED");
  render();
});

els.open_settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.setup_go.addEventListener("click", () => chrome.runtime.openOptionsPage());

/* Straight to the Troubleshooting card rather than the top of Settings. */
els.tab_errors_view.addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/options.html#troubleshooting") }));

render();
