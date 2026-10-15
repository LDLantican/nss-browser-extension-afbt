/**
 * The worker API, as this browser calls it (the web app's docs/worker-api.md).
 *
 * ## Two tokens, kept in two places (ADR-007)
 *
 * Signing in registers this browser as a **worker** and returns a **device
 * token**: good for a year, revocable at /account, and good for exactly one
 * thing — exchanging it, once an hour, for an **access token**. The device
 * token lives in `storage.local`, because it has to outlive a browser restart;
 * the access token only in `storage.session`, so closing the browser throws it
 * away and a copy lifted out of the profile is worth an hour at most.
 *
 * A 401 on any call means the access token is no good — expired, or its device
 * retired — so the exchange is tried once more and the call repeated. A 401 on
 * the exchange itself means the device is retired or the account switched off,
 * and nothing but signing in again helps: the stored identity is forgotten.
 *
 * ## Only https, except on this machine
 *
 * Every call carries a bearer token. Over plain http that token crosses the
 * network in the clear, so an `http://` address is refused — unless it is
 * loopback (`localhost`, `127.0.0.1`, `[::1]`), where nothing crosses a
 * network at all and the development server lives.
 *
 * Nothing here throws for an HTTP status: every call resolves to
 * `{ ok, status, body }` and the caller decides what a status means, as
 * background/api.js does. A request that got no answer rejects as
 * NetworkError, and a browser with no worker identity as NotSignedIn.
 */

import { NetworkError, NotSignedIn } from "./errors.js";

export const IDENTITY_KEY = "ash_worker_identity";
export const ACCESS_KEY = "ash_worker_access";

/** Renew this long before the access token runs out, so no call races its expiry. */
const RENEW_BEFORE_MS = 120000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The address to call, or null with the reason it may not be called.
 *
 * Trailing slashes off, as background/api.js normalizes it, so the identity
 * stored against an address is compared the same way the settings are.
 */
export function check_base(url) {
  const base = String(url || "").trim().replace(/\/+$/, "");

  if (base === "") return { base: null, error: "No web app address is set yet." };

  let parsed;

  try {
    parsed = new URL(base);
  } catch {
    return { base: null, error: "The web app address is not a web address." };
  }

  if (parsed.protocol === "https:") return { base, error: null };
  if (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) return { base, error: null };

  return {
    base: null,
    error: "The web app address must start with https://. A plain http:// address would send this browser's credentials unencrypted.",
  };
}

export function create_client(env) {
  async function base() {
    const { base: checked, error } = check_base(await env.base_url());

    if (checked === null) throw new NotSignedIn("unavailable", error);

    return checked;
  }

  /**
   * One POST. `bearer` is the token to send, or null for none (register).
   *
   * Every worker endpoint is a POST of a JSON object, so this is the only
   * shape there is.
   */
  async function post(path, { bearer = null, body = {} } = {}) {
    const url = `${await base()}${path}`;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Extension-Version": env.version,
    };

    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    let response;

    try {
      response = await env.fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
    } catch (error) {
      throw new NetworkError(error?.message || "Could not reach the web app.");
    }

    const text = await response.text().catch(() => "");
    let parsed = {};

    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: `Unexpected answer from the web app (${response.status}).` };
      }
    }

    const status = Number(response.status) || 0;

    return { ok: status >= 200 && status < 300, status, body: parsed ?? {} };
  }

  /** The stored identity, if it belongs to the address configured now. */
  async function identity() {
    const stored = await env.local.get(IDENTITY_KEY);

    if (!stored?.device_token) return null;

    const { base: current } = check_base(await env.base_url());

    return stored.base === current ? stored : null;
  }

  async function forget() {
    await env.local.remove(IDENTITY_KEY);
    await env.session.remove(ACCESS_KEY);
  }

  /**
   * An access token that will last a while yet: the one held, or a fresh one
   * from the exchange.
   */
  async function access_token({ force = false } = {}) {
    const who = await identity();

    if (who === null) throw new NotSignedIn("signed_out", "This browser is not signed in as a delivery worker.");

    const held = await env.session.get(ACCESS_KEY);

    if (
      !force &&
      held?.token &&
      held.base === who.base &&
      held.worker_id === who.worker_id &&
      held.expires_ms - env.now() > RENEW_BEFORE_MS
    )
      return held.token;

    const answer = await post("/api/worker/token", { bearer: who.device_token });

    if (answer.status === 401) {
      await forget();

      throw new NotSignedIn("retired", "This browser's sign-in was ended on the web app. Sign in again.");
    }

    if (!answer.ok || !answer.body?.access_token)
      throw new NotSignedIn(
        "unavailable",
        answer.body?.error || `The web app would not renew this browser's access (${answer.status}).`,
      );

    /* Timed from receipt by this browser's clock, never from the server's
       `expires_at`: that string is the database's wall clock, which here
       disagrees with PHP's — let alone a laptop's — by hours. */
    await env.session.set(ACCESS_KEY, {
      base: who.base,
      worker_id: who.worker_id,
      token: answer.body.access_token,
      expires_ms: env.now() + (Number(answer.body.expires_in) || 3600) * 1000,
    });

    return answer.body.access_token;
  }

  /** A call with the access token, renewed once if it is refused. */
  async function call(path, body = {}) {
    let answer = await post(path, { bearer: await access_token(), body });

    if (answer.status === 401) answer = await post(path, { bearer: await access_token({ force: true }), body });

    return answer;
  }

  const delivery = (id, action) => `/api/worker/deliveries/${encodeURIComponent(id)}/${action}`;

  return {
    identity,
    forget,
    access_token,

    /**
     * Sign in as a worker. A real sign-in — the web app's throttle and lockout
     * apply — that makes a new worker every time it succeeds, so it is only
     * ever called by a person pressing Sign in.
     */
    async register({ email, password, device_name }) {
      const current = await base();
      const answer = await post("/api/worker/register", {
        body: { email, password, device_name, extension_version: env.version },
      });

      if (!answer.ok || !answer.body?.device_token) return answer;

      await env.session.remove(ACCESS_KEY);
      await env.local.set(IDENTITY_KEY, {
        base: current,
        worker_id: answer.body.worker_id,
        worker_uuid: answer.body.worker_uuid || "",
        device_name: answer.body.device_name || device_name || "",
        device_token: answer.body.device_token,
        user: answer.body.user
          ? { id: answer.body.user.id, name: answer.body.user.name, email: answer.body.user.email }
          : null,
        registered_ms: env.now(),
      });

      return answer;
    },

    heartbeat: (report) => call("/api/worker/heartbeat", report),
    claim: () => call("/api/worker/claim"),
    touch: (id, claim_token, step) => call(delivery(id, "touch"), { claim_token, step }),
    commit: (id, claim_token, step) => call(delivery(id, "commit"), { claim_token, step }),
    complete: (id, report) => call(delivery(id, "complete"), report),
    fail: (id, report) => call(delivery(id, "fail"), report),
    release: (id, claim_token) => call(delivery(id, "release"), { claim_token }),

    /* The AppFolio import (phase 8): not deliveries, but the same credentials. */
    import_records: (connection, records) => call("/api/worker/imports", { connection, records }),
    import_lookup: (connection, numbers) => call("/api/worker/imports/lookup", { connection, numbers }),
  };
}
