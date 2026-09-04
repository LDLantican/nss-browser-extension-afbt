/**
 * Every request this extension makes to the web app.
 *
 * All of it lives in the service worker, and that is not a preference. In
 * Manifest V3 a content script's fetch is subject to the *page's* CORS rules —
 * it does not inherit the extension's host permissions the way V2's did — so a
 * call to the web app from a script running on appfolio.com would be blocked
 * with no useful error, and the web app would need CORS headers it should not
 * have to grow. A fetch from here carries the extension's own permissions and
 * is not subject to CORS at all.
 *
 * Nothing here throws for an HTTP status. A 409 from the intake endpoint is
 * information the manager needs to see, not an exception, and the batch
 * endpoint deliberately answers 200 with per-row outcomes inside. So every call
 * resolves to { ok, status, body } and the caller decides what a status means.
 * Only a request that never got an answer — offline, DNS, timeout, abort —
 * rejects, and it rejects as NetworkError so that case is distinguishable from
 * every server answer.
 */

import { settings, auth } from "./store.js";

const TIMEOUT_MS = 20000;

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Trailing slashes off, so joining a path never produces a double slash. */
export function normalize_base(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/**
 * The origin pattern to ask chrome.permissions for.
 *
 * A user-configured endpoint cannot be a static host permission, so the options
 * page requests one at the moment the URL is saved — which is also the only
 * moment there is a user gesture to request it under.
 */
export function origin_pattern(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return "";
  }
}

async function base_url() {
  const config = await settings();
  const base = normalize_base(config.app_url);

  if (base === "") throw new NetworkError("No web app address is set yet.");

  return base;
}

function query_string(query) {
  if (!query) return "";

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;

    params.set(key, String(value));
  }

  const encoded = params.toString();

  return encoded === "" ? "" : `?${encoded}`;
}

/**
 * One request. `token` may be false to send none, true to require the stored
 * one, or a string to use that one — which is what sign-in needs, since it has
 * a token in hand that is not the stored one yet.
 */
export async function request(method, path, { body, query, token = true } = {}) {
  const base = await base_url();
  const headers = { Accept: "application/json" };

  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (token === true) {
    const stored = await auth();
    if (stored?.token) headers.Authorization = `Bearer ${stored.token}`;
  } else if (typeof token === "string" && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }

  /* A request with no ceiling is a queue that can hang forever, and this one is
     driven by a retry loop that needs its turns to end. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;

  try {
    response = await fetch(`${base}${path}${query_string(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,

      /* The web app is on a session cookie for its own pages, and this must not
         ride on one: a request authenticated by an ambient cookie is the thing
         CSRF tokens exist to stop, and the whole reason the API accepts a
         bearer token is so it does not have to trust cookies. */
      credentials: "omit",
      cache: "no-store",
    });
  } catch (error) {
    throw new NetworkError(
      error?.name === "AbortError"
        ? "The web app did not answer in time."
        : "Could not reach the web app.",
    );
  } finally {
    clearTimeout(timer);
  }

  /* A body that is not JSON is not a protocol failure worth throwing over —
     more often it is an Apache error page or a PHP notice, and the status plus
     whatever text arrived is what a person needs to see. */
  const text = await response.text().catch(() => "");
  let parsed = null;

  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: describe_non_json(response.status, text) };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsed ?? {},
  };
}

/**
 * The message for a response that was not JSON.
 *
 * Worth the few lines: the two ways this actually happens in practice are a
 * wrong address pointed at somebody else's site and a PHP fatal, and "the
 * address does not look like the ASH web app" is a far better first guess for
 * the former than a hundred characters of HTML.
 */
function describe_non_json(status, text) {
  const looks_like_html = /^\s*<(?:!doctype|html)/i.test(text);

  if (looks_like_html)
    return status === 404
      ? "That address answered, but not with the ASH web app. Check the address in Settings."
      : `The web app returned a page instead of an answer (${status}).`;

  return `Unexpected answer from the web app (${status}): ${text.slice(0, 160)}`;
}

export const api = {
  sign_in: (email, password, device_name) =>
    request("POST", "/api/session", {
      body: { email, password, device_name },
      token: false,
    }),

  whoami: (token) => request("GET", "/api/session", { token }),

  sign_out: () => request("POST", "/api/session/destroy"),

  send_one: (work_order) =>
    request("POST", "/api/work-orders", { body: work_order }),

  send_batch: (work_orders) =>
    request("POST", "/api/work-orders/batch", { body: { work_orders } }),

  lookup: (numbers) =>
    request("GET", "/api/work-orders/lookup", {
      query: { numbers: numbers.join(",") },
    }),
};
