/**
 * Settings: the address, the sign-in, and Troubleshooting.
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
 * The rest is an ordinary form, with one rule: it never stores a password.
 * Signing in registers this browser as a delivery worker (the web app's
 * `/api/worker/register`); the password is sent once, and what this browser
 * keeps is the device token it is exchanged for — revocable from the web app's
 * account page without anybody having to change a password. That one sign-in
 * covers both things the extension does: importing from AppFolio's work-order
 * pages, and working the delivery queue.
 *
 * Troubleshooting holds what the popup deliberately leaves out: the
 * vendor-page check and the rollout ladder's stop switch.
 *
 * Each of the three is a tab, one panel at a time. The hash names the tab, so
 * a link can open options.html#troubleshooting straight onto it.
 */

const NEWLINE = String.fromCharCode(10);

const els = {
  alert: document.getElementById("alert"),

  app_form: document.getElementById("app-form"),
  app_url: document.getElementById("app-url"),
  app_save: document.getElementById("app-save"),
  permission_note: document.getElementById("permission-note"),

  signed_in: document.getElementById("signed-in"),
  who: document.getElementById("who"),
  device: document.getElementById("device"),
  worker_id: document.getElementById("worker-id"),
  account_link_holder: document.getElementById("account-link-holder"),
  sign_out: document.getElementById("sign-out"),

  sign_in_form: document.getElementById("sign-in-form"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  device_name: document.getElementById("device-name"),
  sign_in: document.getElementById("sign-in"),

  probe: document.getElementById("probe"),
  probe_copy: document.getElementById("probe-copy"),
  probe_output: document.getElementById("probe-output"),
  stop_after_press: document.getElementById("stop-after-press"),

  tabs: [...document.querySelectorAll('[role="tab"]')],
  tab_app_dot: document.getElementById("tab-app-dot"),
  tab_sign_in_dot: document.getElementById("tab-sign-in-dot"),
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

/**
 * A name for this browser, offered as the default device label.
 *
 * The manager can overwrite it. It exists because "Unnamed device" in a list of
 * four is not something anybody can make a revoke decision about, and asking
 * somebody to invent a name before they can sign in is worse.
 */
function suggested_device_name() {
  const agent = navigator.userAgent || "";

  const browser_name = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\//.test(agent)
      ? "Opera"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Chrome\//.test(agent)
          ? "Chrome"
          : "Browser";

  const platform = /Windows/.test(agent)
    ? "Windows"
    : /Macintosh|Mac OS/.test(agent)
      ? "Mac"
      : /Linux/.test(agent)
        ? "Linux"
        : "";

  return platform === "" ? browser_name : `${browser_name} on ${platform}`;
}

/* ---- tabs ------------------------------------------------------------------ */

const TAB_NAMES = els.tabs.map((tab) => tab.dataset.tab);

let current_tab = null;

function tab_from_hash() {
  const name = decodeURIComponent(location.hash.slice(1));

  return TAB_NAMES.includes(name) ? name : null;
}

function select_tab(name, { focus = false } = {}) {
  if (!TAB_NAMES.includes(name)) return;

  for (const tab of els.tabs) {
    const selected = tab.dataset.tab === name;

    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;

    if (selected && focus) tab.focus();
  }

  current_tab = name;

  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}

for (const tab of els.tabs) {
  tab.addEventListener("click", () => select_tab(tab.dataset.tab));

  tab.addEventListener("keydown", (event) => {
    const index = TAB_NAMES.indexOf(tab.dataset.tab);
    const last = TAB_NAMES.length - 1;
    const next = {
      ArrowDown: index === last ? 0 : index + 1,
      ArrowRight: index === last ? 0 : index + 1,
      ArrowUp: index === 0 ? last : index - 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];

    if (next === undefined) return;

    event.preventDefault();
    select_tab(TAB_NAMES[next], { focus: true });
  });
}

window.addEventListener("hashchange", () => {
  const name = tab_from_hash();

  if (name && name !== current_tab) select_tab(name);
});

function trim_trailing_slashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function render() {
  const [state, worker] = await Promise.all([ask("STATE"), ask("WORKER_STATE")]);

  if (state.ok === false || worker.ok === false) {
    if (current_tab === null) select_tab("app");
    say(state.error || worker.error || "Could not read the extension's settings.", "error");

    return;
  }

  const settings = state.settings || {};

  els.app_url.value = settings.app_url || "";

  /* The worker's identity is the only sign-in there is, and it is held
     against the address it was made for: a different address reads as
     signed out here, which is what it is. */
  const signed_in = worker.signed_in === true;

  els.tab_app_dot.hidden = Boolean(settings.app_url);
  els.tab_sign_in_dot.hidden = signed_in;

  /* The first render picks the tab when the hash did not: the first step
     still to do, or the address when nothing is. */
  if (current_tab === null)
    select_tab(settings.app_url && !signed_in ? "sign-in" : "app");

  els.signed_in.hidden = !signed_in;
  els.sign_in_form.hidden = signed_in;

  if (signed_in) {
    els.who.textContent = worker.user
      ? `${worker.user.name} (${worker.user.email})`
      : "—";
    els.device.textContent = worker.device_name || "—";
    els.worker_id.textContent = worker.worker_id === null || worker.worker_id === undefined ? "—" : `#${worker.worker_id}`;

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
    els.device_name.value = els.device_name.value || suggested_device_name();
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

els.app_form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = trim_trailing_slashes(els.app_url.value);

  if (url === "") {
    say("Enter the web app's address.", "error");

    return;
  }

  let origin;

  let parsed;

  try {
    parsed = new URL(url);
    origin = `${parsed.origin}/*`;
  } catch {
    say("That does not look like a web address. Include https://.", "error");

    return;
  }

  /* Every call carries a credential, so only https — except on this computer,
     where the development server lives and nothing crosses a network. The
     manifest allows the same addresses and no others, so anything else would
     be refused by the permission request below anyway; this says why. */
  const loopback = ["localhost", "127.0.0.1"].includes(parsed.hostname);

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    say("The web app's address must start with https://.", "error");

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
    say(
      /manifest/i.test(String(error?.message))
        ? "This extension only works with the ASH web app at alabamasignaturehomes.com, or a development copy on this computer."
        : error?.message || "The browser refused the permission request.",
      "error",
    );

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
     and appears to have been signed out for no reason. It is deliberate and
     not recoverable by retrying, so it is reported rather than left to be
     discovered. */
  if (saved.moved) {
    say("Address saved. This is a different web app, so this device was signed out. Sign in to carry on.", "warn");
    select_tab("sign-in");
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

/* ---- troubleshooting ------------------------------------------------------- */

/**
 * Puts a button in its working state for the length of `work`, then back.
 *
 * A present-tense label, because a disabled button with its original text on
 * it looks dead.
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

/** The adapter's probe as plain text, so it survives a paste into a chat. */
function describe_probe(report) {
  const adapter = report.adapter || {};

  return [
    `Page: ${report.tab_title || "(untitled)"}`,
    `appfolio_vendor adapter, ${adapter.kind || "unknown"} page, ${adapter.signed_in ? "signed in" : "signed out"}${adapter.loading ? ", still loading" : ""}`,
    `  found:   ${(adapter.found || []).join(", ") || "nothing"}`,
    `  missing: ${(adapter.missing || []).join(", ") || "nothing"}`,
  ].join(NEWLINE);
}

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

els.stop_after_press.addEventListener("click", () =>
  busy(els.stop_after_press, "Arming…", async () => {
    const result = await ask("WORKER_STOP_AFTER_NEXT_PRESS");

    say(result.ok === false ? result.error || "Could not arm it." : "Armed: the next press is followed by a stop.", result.ok === false ? "warn" : "ok");
  }));

if (tab_from_hash()) select_tab(tab_from_hash());

render();
