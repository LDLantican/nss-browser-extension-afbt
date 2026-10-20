/**
 * The popup: is this browser working the queue, and does anything need me?
 *
 * Written for whoever is doing the day's work, not for whoever is debugging it.
 * So it shows who is signed in and the delivery worker's own account of itself
 * (ui/worker_panel.js) — and nothing else. The page check and the stop switch
 * are in Settings > Troubleshooting, where nobody meets them by accident.
 *
 * It is deliberately **not** where work is started. Choosing which work orders
 * to import happens on the AppFolio page, and billing approved work happens by
 * itself every minute.
 *
 * The popup is also assumed to be closed most of the time. It is destroyed the
 * moment focus returns to the page, so it renders from state it asks for on
 * open rather than subscribing to events it will not be alive to receive.
 */

import { render_worker, wire_worker } from "./worker_panel.js";

const els = {
  alert: document.getElementById("alert"),
  setup: document.getElementById("setup"),
  setup_note: document.getElementById("setup-note"),
  setup_go: document.getElementById("setup-go"),
  main: document.getElementById("main"),
  who: document.getElementById("who"),
  foot: document.getElementById("foot"),
  open_settings: document.getElementById("open-settings"),
};

const worker_els = {
  panel: document.getElementById("worker"),
  processing: document.getElementById("worker-processing"),
  status: document.getElementById("worker-status"),
  connections: document.getElementById("worker-connections"),
};

async function ask(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, payload })) ?? {};
  } catch (error) {
    return { ok: false, error: error?.message || "The extension is not responding." };
  }
}

function say(text, kind = "warn") {
  els.alert.hidden = !text;
  els.alert.className = `notice notice--${kind}`;
  els.alert.textContent = text || "";
}

async function render() {
  const [state, worker] = await Promise.all([ask("STATE"), ask("WORKER_STATE")]);

  if (state.ok === false || worker.ok === false) {
    say(state.error || worker.error || "Something went wrong reading the extension.", "error");

    return;
  }

  const configured = String(state.settings?.app_url || "").trim() !== "";
  const signed_in = worker.signed_in === true;

  /* Nothing else is worth rendering if the web app cannot be called. Both
     causes have the same remedy and it is one button. */
  if (!configured || !signed_in) {
    els.setup.hidden = false;
    els.main.hidden = true;
    els.foot.hidden = true;
    els.setup_note.textContent = !configured
      ? "Add the ASH web app's address in Settings, then sign in."
      : worker.status?.state === "retired"
        ? "This browser's sign-in was ended on the web app. Sign in again from Settings."
        : "Sign in from Settings to import work orders and work the delivery queue.";

    return;
  }

  els.setup.hidden = true;
  els.main.hidden = false;
  els.foot.hidden = false;

  const name = worker.user?.name || worker.user?.email || "";
  els.who.textContent = [name && `Signed in as ${name}`, worker.device_name].filter(Boolean).join(" · ");
  els.who.hidden = els.who.textContent === "";

  render_worker(worker, worker_els);
}

els.open_settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.setup_go.addEventListener("click", () => chrome.runtime.openOptionsPage());
wire_worker(ask, worker_els, render);

render();
