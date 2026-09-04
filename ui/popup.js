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
  render_bt(state);

  const stamp = state.session.checked_at
    ? new Date(state.session.checked_at).toLocaleString()
    : "";
  els.foot_note.textContent = stamp === "" ? "" : `Last checked ${stamp}`;

  /* A heartbeat on open, so a token revoked from /account is noticed here
     rather than at the moment a manager tries to sync twenty rows. */
  const beat = await ask("HEARTBEAT");

  if (beat.status === "signed_out") {
    say(beat.error || "This device is no longer signed in.", "error");
    render();
  } else if (beat.status === "unreachable") {
    say(`Cannot reach the web app right now. ${beat.error || ""}`.trim(), "warn");
  } else {
    say("");
  }
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

function render_bt(state) {
  if (state.settings?.buildertrend_enabled === false) {
    els.bt_panel.hidden = true;

    return;
  }

  els.bt_panel.hidden = false;

  const queue = Object.values(state.bt_queue || {});

  els.bt_tally.textContent =
    queue.length === 0
      ? "Nothing queued. Tick “also queue for Buildertrend” when you sync."
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

        if (result?.ok === false && result.error) say(result.error, "error");

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

  els.bt_actions.innerHTML = "";

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
