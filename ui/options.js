/**
 * Settings: the address, the sign-in, and the Buildertrend facts.
 *
 * The one genuinely interesting thing here is the permission request.
 *
 * A manager types the web app's address, so it cannot be a static host
 * permission in the manifest — the manifest is written before anybody knows
 * what the address is. It is therefore an *optional* host permission, granted
 * at runtime; and chrome.permissions.request only works from a user gesture,
 * which is why it is called straight out of the save button's own handler and
 * cannot be moved into the service worker or behind an await of anything slow.
 *
 * The rest is an ordinary form, with one rule: it never stores a password. The
 * password is sent once to be exchanged for a token, and what this browser
 * keeps is the token — revocable from the web app's account page without
 * anybody having to change a password.
 *
 * It is also where Troubleshooting lives: everything the popup deliberately
 * leaves out — the separate invoice and estimate runs with every count they
 * keep, the vendor-page check, the last Buildertrend run reports, and the
 * tab-error reports.
 */

import {
  REASONS,
  delivery_details,
  describe_bt_run,
  describe_estimate_run,
  describe_probe,
  describe_reports,
  scope_note,
  NEWLINE,
} from "./describe.js";

const els = {
  alert: document.getElementById("alert"),

  app_form: document.getElementById("app-form"),
  app_url: document.getElementById("app-url"),
  app_save: document.getElementById("app-save"),
  permission_note: document.getElementById("permission-note"),

  signed_in: document.getElementById("signed-in"),
  who: document.getElementById("who"),
  device: document.getElementById("device"),
  expires: document.getElementById("expires"),
  account_link_holder: document.getElementById("account-link-holder"),
  sign_out: document.getElementById("sign-out"),
  recheck: document.getElementById("recheck"),

  sign_in_form: document.getElementById("sign-in-form"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  device_name: document.getElementById("device-name"),
  sign_in: document.getElementById("sign-in"),

  bt_enabled: document.getElementById("bt-enabled"),
  bt_auto_estimates: document.getElementById("bt-auto-estimates"),
  bt_fields: document.getElementById("bt-fields"),
  job_type: document.getElementById("job-type"),
  job_group: document.getElementById("job-group"),
  bt_client_name: document.getElementById("bt-client-name"),
  bt_client_row_id: document.getElementById("bt-client-row-id"),
  bt_cost_code: document.getElementById("bt-cost-code"),
  bt_save: document.getElementById("bt-save"),

  deliver_now: document.getElementById("deliver-now"),
  estimates_now: document.getElementById("estimates-now"),
  run_output: document.getElementById("run-output"),
  probe: document.getElementById("probe"),
  probe_copy: document.getElementById("probe-copy"),
  probe_output: document.getElementById("probe-output"),
  bt_troubleshooting: document.getElementById("bt-troubleshooting"),
  bt_runs: document.getElementById("bt-runs"),
  bt_runs_empty: document.getElementById("bt-runs-empty"),
  bt_runs_copy: document.getElementById("bt-runs-copy"),
  bt_queue_note: document.getElementById("bt-queue-note"),
  bt_queue_clear: document.getElementById("bt-queue-clear"),

  tab_errors_list: document.getElementById("tab-errors-list"),
  tab_errors_empty: document.getElementById("tab-errors-empty"),
  tab_errors_copy: document.getElementById("tab-errors-copy"),
  tab_errors_download: document.getElementById("tab-errors-download"),
  tab_errors_clear: document.getElementById("tab-errors-clear"),
};

async function ask(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, payload })) ?? {};
  } catch (error) {
    return { ok: false, error: error?.message || "The extension is not responding." };
  }
}

function say(text, kind = "ok") {
  if (!text) {
    els.alert.hidden = true;

    return;
  }

  els.alert.hidden = false;
  els.alert.textContent = text;
  els.alert.className = `notice notice--${kind}`;
}

function trim_trailing_slashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function render() {
  const state = await ask("STATE");

  if (state.ok === false) {
    say(state.error || "Could not read the extension's settings.", "error");

    return;
  }

  const settings = state.settings || {};

  els.app_url.value = settings.app_url || "";

  els.bt_enabled.checked = settings.buildertrend_enabled !== false;
  els.bt_auto_estimates.checked = settings.bt_auto_estimates !== false;
  els.job_type.value = settings.job_type || "";
  els.job_group.value = settings.job_group || "";
  els.bt_client_name.value = settings.bt_client_name || "";
  els.bt_client_row_id.value = settings.bt_client_row_id || "";
  els.bt_cost_code.value = settings.bt_cost_code || "";
  toggle_bt_fields();
  render_troubleshooting(state);

  const signed_in = state.session?.signed_in === true;

  els.signed_in.hidden = !signed_in;
  els.sign_in_form.hidden = signed_in;

  if (signed_in) {
    els.who.textContent = state.session.user
      ? `${state.session.user.name} (${state.session.user.email})`
      : "—";
    els.device.textContent = state.session.device_name || "—";
    els.expires.textContent = state.session.expires_at || "Does not expire";

    /* Built rather than written into the HTML, because the account page's
       address depends on the configured web app. */
    els.account_link_holder.innerHTML = "";
    const base = trim_trailing_slashes(settings.app_url);

    if (base === "") {
      els.account_link_holder.textContent = "your account page";
    } else {
      const link = document.createElement("a");
      link.href = `${base}/account`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "your account page";
      els.account_link_holder.appendChild(link);
    }
  } else {
    els.device_name.value =
      els.device_name.value || state.suggested_device_name || "";
  }

  await render_permission();
}

/**
 * Whether the browser will let us call the configured address.
 *
 * Worth showing, because a missing permission fails as "could not reach the web
 * app" — indistinguishable from the server being down — and the remedy is a
 * click here rather than anything to do with the server.
 */
async function render_permission() {
  const check = await ask("CHECK_ORIGIN_PERMISSION");

  if (!check.pattern) {
    els.permission_note.textContent = "";

    return;
  }

  els.permission_note.textContent = check.granted
    ? "Permitted to talk to this address."
    : "Not yet permitted — save the address again to allow it.";
}

function toggle_bt_fields() {
  els.bt_fields.hidden = !els.bt_enabled.checked;
}

els.bt_enabled.addEventListener("change", toggle_bt_fields);

els.app_form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = trim_trailing_slashes(els.app_url.value);

  if (url === "") {
    say("Enter the web app's address.", "error");

    return;
  }

  let origin;

  try {
    origin = `${new URL(url).origin}/*`;
  } catch {
    say("That does not look like a web address. Include http:// or https://.", "error");

    return;
  }

  /* Requested here, first, and not after an await of anything else: this is
     inside the click's own task, which is what makes it a user gesture. An
     await before it — even a storage read — spends the gesture and the request
     is refused without a prompt. */
  let granted = false;

  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    say(error?.message || "The browser refused the permission request.", "error");

    return;
  }

  if (!granted) {
    say(
      "Without permission for that address the extension cannot reach the web app. Save again to be asked once more.",
      "warn",
    );

    return;
  }

  els.app_save.disabled = true;

  const saved = await ask("SAVE_SETTINGS", { patch: { app_url: url } });

  els.app_save.disabled = false;

  if (saved.ok === false) {
    say(saved.error || "Could not save the address.", "error");

    return;
  }

  /* Said plainly, because the alternative is a manager who changed an address
     and appears to have been signed out for no reason. Both effects are
     deliberate and neither is recoverable by retrying, so they are reported
     rather than left to be discovered. */
  if (saved.moved) {
    const parts = ["Address saved. This is a different web app, so this device was signed out"];

    if (saved.cleared > 0)
      parts.push(
        `and ${saved.cleared} row${saved.cleared === 1 ? "" : "s"} were cleared from the sync list — they described work orders in ${saved.previous_url}`,
      );

    say(`${parts.join(" ")}. Sign in below to carry on.`, "warn");
  } else {
    say("Address saved.", "ok");
  }

  render();
});

els.sign_in_form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = els.email.value.trim();
  const password = els.password.value;

  if (email === "" || password === "") {
    say("Enter your email and password.", "error");

    return;
  }

  els.sign_in.disabled = true;
  els.sign_in.textContent = "Signing in…";

  const result = await ask("SIGN_IN", {
    email,
    password,
    device_name: els.device_name.value.trim(),
  });

  els.sign_in.disabled = false;
  els.sign_in.textContent = "Sign in";

  /* Cleared whichever way it went. On success it is spent, and on failure a
     password left sitting in a form field is a password on screen. */
  els.password.value = "";

  if (result.ok !== true) {
    say(result.error || "That sign-in was refused.", "error");

    return;
  }

  say("Signed in. You can close this page.", "ok");
  render();
});

els.sign_out.addEventListener("click", async () => {
  els.sign_out.disabled = true;

  await ask("SIGN_OUT");

  els.sign_out.disabled = false;

  say("Signed out on this device.", "ok");
  render();
});

els.recheck.addEventListener("click", async () => {
  const beat = await ask("HEARTBEAT");

  if (beat.status === "signed_in") say("Still signed in.", "ok");
  else if (beat.status === "signed_out")
    say(beat.error || "This device is no longer signed in.", "error");
  else say(beat.error || "Could not reach the web app.", "warn");

  render();
});

els.bt_save.addEventListener("click", async () => {
  const saved = await ask("SAVE_SETTINGS", {
    patch: {
      buildertrend_enabled: els.bt_enabled.checked,
      bt_auto_estimates: els.bt_auto_estimates.checked,
      job_type: els.job_type.value.trim(),
      job_group: els.job_group.value.trim(),
      bt_client_name: els.bt_client_name.value.trim(),
      bt_client_row_id: els.bt_client_row_id.value.trim(),
      bt_cost_code: els.bt_cost_code.value.trim(),
    },
  });

  if (saved.ok === false) {
    say(saved.error || "Could not save those settings.", "error");

    return;
  }

  say("Buildertrend settings saved.", "ok");
});

/* ---- troubleshooting: run now --------------------------------------------- */

/**
 * Puts a button in its working state for the length of `work`, then back.
 *
 * Present-tense labels, because both runs and the page check can take the
 * better part of a minute, and a disabled button with its original text on it
 * looks dead for that long.
 */
async function busy(element, label, work) {
  const idle = element.textContent;

  element.disabled = true;
  element.textContent = label;

  try {
    return await work();
  } finally {
    element.disabled = false;
    element.textContent = idle;
  }
}

function show_output(element, text) {
  element.hidden = text === "";
  element.textContent = text;
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    say(`${what} copied.`, "ok");
  } catch {
    say("Could not copy to the clipboard.", "error");
  }
}

els.deliver_now.addEventListener("click", () =>
  busy(els.deliver_now, "Delivering…", async () => {
    const result = await ask("DELIVER_NOW");
    const summary = result.summary || {};

    show_output(els.run_output, "");

    if (result.skipped === "already running") {
      say("A delivery run is already going. Try again when it finishes.", "warn");

      return;
    }

    if (result.ok === false) {
      say(REASONS[result.error] || summary.reason || result.error || "Delivery could not run.", "error");

      return;
    }

    /* Ahead of `paused`, because there is a filled invoice on a tab waiting for
       somebody, and "nothing was waiting" would be the opposite of the truth. */
    if (summary.awaiting_submit === true) {
      say(summary.reason || "An invoice is filled in and waiting to be submitted.", "warn");

      return;
    }

    if (summary.paused === true) {
      say(summary.reason || "Delivery is paused because too much has failed recently.", "warn");

      return;
    }

    /* A rehearsal's whole output is what it found, so it goes in the block
       rather than being compressed into the one-line notice. */
    if (summary.dry_run === true) {
      show_output(els.run_output, describe_reports(result.reports || []));
      say(`Rehearsed${scope_note(summary)} without writing anything. Nothing was submitted.`, "ok");

      return;
    }

    const parts = delivery_details(summary);

    say(
      parts.length === 0
        ? `Nothing was waiting to be delivered${scope_note(summary)}.`
        : parts.join(" · ") + scope_note(summary) + ".",
      summary.unconfirmed || summary.failed || summary.blocked ? "warn" : "ok",
    );
  }));

els.estimates_now.addEventListener("click", () =>
  busy(els.estimates_now, "Writing…", async () => {
    const result = await ask("DELIVER_ESTIMATES");
    const summary = result.summary || {};

    if (result.skipped === "already running")
      say("An estimate run is already going. Try again when it finishes.", "warn");
    else if (result.ok === false)
      say(summary.reason || REASONS[result.error] || result.error || "The estimates could not be written.", "error");
    else if ((summary.delivered || 0) > 0) say(`${summary.delivered} written to Buildertrend.`, "ok");
    else if ((summary.rehearsed || 0) > 0) say(`${summary.rehearsed} rehearsed. Nothing was written.`, "ok");
    else say("Nothing was waiting for an estimate.", "ok");

    /* The run keeps its own account in storage, so the report below is
       redrawn from there rather than from this answer. */
    render_troubleshooting(await ask("STATE"));
  }));

/* ---- troubleshooting: the vendor-page check -------------------------------- */

els.probe.addEventListener("click", () =>
  busy(els.probe, "Checking…", async () => {
    const result = await ask("PROBE_PAGE");

    if (result.ok === false) {
      show_output(els.probe_output, "");
      els.probe_copy.hidden = true;
      say(result.error || "Could not read that page.", "warn");

      return;
    }

    say("");
    show_output(els.probe_output, describe_probe(result.report || {}));
    els.probe_copy.hidden = false;
  }));

els.probe_copy.addEventListener("click", () => copy(els.probe_output.textContent, "Page check"));

/* ---- troubleshooting: Buildertrend ----------------------------------------- */

/**
 * The last job-creation and estimate runs, and the queue.
 *
 * The job-creation run is only shown when it has something to say about a
 * failure — on a clean run it is noise. An estimate run that touched no job and
 * hit no error has nothing to account for either.
 */
function render_troubleshooting(state) {
  const bt_on = state.settings?.buildertrend_enabled !== false;

  els.bt_troubleshooting.hidden = !bt_on;
  els.estimates_now.hidden = !bt_on;

  if (!bt_on) return;

  const pending = Object.keys(state.bt_pending_links || {}).length;
  const run = state.bt_last_run;
  const run_worth_showing =
    run && ((run.summary?.unidentified || 0) > 0 || (run.summary?.failed || 0) > 0 || pending > 0);

  const estimate = state.bt_last_estimate_run;
  const estimate_worth_showing =
    estimate && ((estimate.reports || []).length > 0 || estimate.error || estimate.summary?.reason);

  const text = [
    run_worth_showing ? describe_bt_run(run) : "",
    estimate_worth_showing ? describe_estimate_run(estimate) : "",
  ].filter(Boolean).join(NEWLINE + NEWLINE);

  show_output(els.bt_runs, text);
  els.bt_runs_empty.hidden = text !== "";
  els.bt_runs_copy.hidden = text === "";

  const queued = Object.keys(state.bt_queue || {}).length;

  els.bt_queue_note.textContent = queued === 0
    ? "Nothing is waiting to be added to Buildertrend."
    : `${queued} work order${queued === 1 ? " is" : "s are"} waiting to be added to Buildertrend. `
      + "Clearing the queue forgets them here; the work orders stay in the web app.";
  els.bt_queue_clear.hidden = queued === 0;
}

els.bt_runs_copy.addEventListener("click", () => copy(els.bt_runs.textContent, "Run report"));

/* Two presses, the same as clearing tab errors, because this forgets work that
   is written nowhere else in the extension. CLEAR_BT_QUEUE touches the queue
   only — v1's "Clear All" called storage.local.clear(), which would now sign
   the manager out as a side effect of tidying a list. */
let queue_clear_armed = null;

els.bt_queue_clear.addEventListener("click", async () => {
  if (queue_clear_armed === null) {
    els.bt_queue_clear.textContent = "Press again to clear the queue";
    queue_clear_armed = setTimeout(() => {
      queue_clear_armed = null;
      els.bt_queue_clear.textContent = "Clear the Buildertrend queue";
    }, 4000);

    return;
  }

  clearTimeout(queue_clear_armed);
  queue_clear_armed = null;
  els.bt_queue_clear.textContent = "Clear the Buildertrend queue";

  const result = await ask("CLEAR_BT_QUEUE");

  say(`Cleared ${result.removed || 0} from the Buildertrend queue.`, "ok");
  render_troubleshooting(await ask("STATE"));
});

/* ---- troubleshooting: tab errors ------------------------------------------- */

/**
 * The reports kept when an owned tab was closed on an error.
 *
 * Read here rather than in the popup because they carry screenshots. Opening
 * this page is what counts as having looked, which is what clears the line in
 * the popup.
 */
let tab_reports = [];

async function render_tab_errors() {
  const answer = await ask("TAB_ERRORS");

  tab_reports = Array.isArray(answer.reports) ? answer.reports : [];

  els.tab_errors_list.replaceChildren(...tab_reports.map(report_item));
  els.tab_errors_empty.hidden = tab_reports.length > 0;
  els.tab_errors_copy.disabled = tab_reports.length === 0;
  els.tab_errors_download.disabled = tab_reports.length === 0;

  await ask("TAB_ERRORS_SEEN");
}

function report_item(report) {
  const item = document.createElement("li");
  item.className = "report";

  const head = document.createElement("p");
  head.className = "report__head";
  head.textContent = [
    new Date(report.at).toLocaleString(),
    report.owner,
    report.number ? `WO ${report.number}` : "",
  ].filter(Boolean).join(" · ");

  const error = document.createElement("p");
  error.className = "report__error";
  error.textContent = report.error || "(no error text)";

  item.append(head, error);

  if (report.screenshot) {
    const shot = document.createElement("img");
    shot.className = "report__shot";
    shot.src = report.screenshot;
    shot.alt = `The tab when ${report.number || "the run"} failed`;
    shot.title = "Open full size";
    shot.addEventListener("click", () => open_blob(report.screenshot));
    item.append(shot);
  }

  const facts = document.createElement("dl");
  facts.className = "facts";

  for (const [label, value] of report_facts(report)) {
    const term = document.createElement("dt");
    term.textContent = label;

    const detail = document.createElement("dd");
    detail.textContent = value;

    facts.append(term, detail);
  }

  item.append(facts);

  if (report.snapshot) {
    const actions = document.createElement("p");
    actions.className = "card__actions";

    const download = document.createElement("button");
    download.type = "button";
    download.className = "btn btn--quiet";
    download.textContent = "Download page copy";
    download.addEventListener("click", () =>
      save(`tab-error-${report.id}.html`, report.snapshot, "text/html"));

    actions.append(download);
    item.append(actions);
  }

  return item;
}

/** Label/value pairs, shared by the card and by Copy as text. */
function report_facts(report) {
  return [
    ["Doing", report.label],
    ["Step", report.step],
    ["State", report.state],
    ["Run", report.run],
    ["Page", report.url],
    ["Title", report.title],
    ["Closed by", report.tab_closed_by_person ? "a person, while it ran" : ""],
    ["Screenshot", report.screenshot ? "kept" : report.screenshot_note],
    ["Page copy", report.snapshot ? `kept (${Math.round(report.snapshot.length / 1024)} KB)` : report.snapshot_note],
    ["Detail", report.detail ? JSON.stringify(report.detail) : ""],
    ["Version", report.extension_version],
  ].filter(([, value]) => value);
}

function reports_as_text() {
  return tab_reports
    .map((report) =>
      [
        `${new Date(report.at).toISOString()}  ${report.owner}${report.number ? `  WO ${report.number}` : ""}`,
        `error      : ${report.error || "(none)"}`,
        ...report_facts(report).map(([label, value]) => `${label.toLowerCase().padEnd(11)}: ${value}`),
      ].join("\n"))
    .join("\n\n");
}

/** A data: URL cannot be opened as a tab, so it goes through a blob. */
async function open_blob(data_url) {
  const blob = await (await fetch(data_url)).blob();

  window.open(URL.createObjectURL(blob), "_blank");
}

function save(filename, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

els.tab_errors_copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(reports_as_text());
    say("Tab-error reports copied, without screenshots or page copies.", "ok");
  } catch {
    say("Could not copy to the clipboard.", "error");
  }
});

els.tab_errors_download.addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  save(`nss-tab-errors-${stamp}.json`, JSON.stringify(tab_reports, null, 2), "application/json");
});

/* Two presses, because this deletes the only copy of what those tabs showed. */
let clear_armed = null;

els.tab_errors_clear.addEventListener("click", async () => {
  if (clear_armed === null) {
    els.tab_errors_clear.textContent = "Press again to clear them all";
    clear_armed = setTimeout(() => {
      clear_armed = null;
      els.tab_errors_clear.textContent = "Clear";
    }, 4000);

    return;
  }

  clearTimeout(clear_armed);
  clear_armed = null;
  els.tab_errors_clear.textContent = "Clear";

  await ask("CLEAR_TAB_ERRORS");
  await render_tab_errors();
  say("Tab-error reports cleared.", "ok");
});

render();
render_tab_errors();
