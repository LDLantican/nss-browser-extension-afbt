/**
 * The popup's account of the delivery worker: the "Process ASH jobs" switch,
 * and for each connection this browser could work, whether it may and if not,
 * what would fix it — the heartbeat's own answer, put into words.
 *
 * Rendered from WORKER_STATE, which reads storage only and which the popup
 * asks for once and hands in; the switch is the one thing here that talks to
 * the web app, through a heartbeat sent at once.
 */

/** The heartbeat's reasons (the web app's docs/worker-api.md), as a person reads them. */
const REASONS = {
  worker_revoked: "This browser's sign-in was ended on the web app. Sign in again in Settings.",
  heartbeat_stale: "Waiting for this browser's next check-in.",
  processing_off: "Processing is switched off in this browser.",
  not_permitted: "Your account may not deliver work.",
  connection_disabled: "Switched off on the web app.",
  connection_paused: "Paused on the web app.",
  not_operator: "Your account is not set up to work this one.",
  session_not_live: "Sign in to it in this browser.",
  session_stale: "Checking whether this browser is signed in to it.",
  adapter_not_reported: "This version of the extension cannot work it.",
  adapter_killed: "This version of the extension has been switched off for it. Update the extension.",
  adapter_outdated: "This version of the extension is too old for it. Update the extension.",
};

const STATES = {
  signed_out: "Not signed in. Sign in from Settings.",
  retired: "This browser's sign-in was ended on the web app. Sign in again from Settings.",
  unavailable: "The web app's delivery queue is not available.",
  offline: "Can't reach the web app right now.",
  outdated: "The web app needs a different version of this extension.",
  paused: "Waiting to finish a job; it carries on at the next minute.",
};

export function render_worker(state, els) {
  if (!state || state.ok === false) {
    els.panel.hidden = true;

    return;
  }

  els.panel.hidden = false;
  els.processing.checked = state.processing !== false;
  els.processing.disabled = state.signed_in !== true;

  const status = state.status || {};
  const lines = [];

  if (!state.signed_in) lines.push(STATES.signed_out);
  else if (STATES[status.state]) lines.push(status.error && status.state !== "signed_out" ? `${STATES[status.state]} ${status.error}` : STATES[status.state]);
  else if (status.state === "error") lines.push(status.error || "Something went wrong on the last check.");

  if (state.job) lines.push(`Working on ${state.job.public_id || `delivery ${state.job.delivery_id}`} (${state.job.operation.replace(/_/g, " ")}).`);
  if (state.outbox > 0) lines.push(`${state.outbox} result${state.outbox === 1 ? "" : "s"} waiting to reach the web app.`);

  els.status.textContent = lines.join(" ");
  els.status.hidden = lines.length === 0;

  els.connections.replaceChildren(
    ...(state.signed_in ? status.connections || [] : []).map((connection) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const note = document.createElement("span");

      name.textContent = connection.name || connection.slug;
      note.textContent = connection.claimable
        ? ` — ready${connection.dry_run ? ", rehearsing only" : ""}${connection.auto_submit ? "" : ", a person presses the last button"}.`
        : ` — ${REASONS[connection.reason] || connection.reason || "not available"}`;

      item.append(name, note);

      return item;
    }),
  );

  els.connections.hidden = els.connections.childElementCount === 0;
}

export function wire_worker(ask, els, rerender) {
  els.processing.addEventListener("change", async () => {
    els.processing.disabled = true;
    await ask("WORKER_SET_PROCESSING", { on: els.processing.checked });
    await rerender();
  });
}
