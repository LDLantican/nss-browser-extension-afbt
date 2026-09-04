/**
 * Signing in to the web app, and knowing whether we still are.
 *
 * The extension holds a token, not a password. It exchanges the password once,
 * at sign-in, and never stores it — so what sits in chrome.storage.local is a
 * credential the manager can revoke from /account without changing her
 * password, which is the whole point of it being a token.
 *
 * Permissions are cached alongside it only to decide what the popup offers.
 * They are never trusted for anything: the web app checks them on every call,
 * and a heartbeat refreshes this copy. A cached `can` that has gone stale
 * results in a button that collects a 403, not in an action that should not
 * have happened.
 */

import { api, NetworkError } from "./api.js";
import { auth, save_auth, clear_auth } from "./store.js";

/**
 * A name for this browser, offered as the default device label.
 *
 * The manager can overwrite it. It exists because "Unnamed device" in a list of
 * four is not something anybody can make a revoke decision about, and asking
 * somebody to invent a name before they can sign in is worse.
 */
export function suggested_device_name() {
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

export async function state() {
  const stored = await auth();

  if (!stored?.token) return { signed_in: false };

  return {
    signed_in: true,
    user: stored.user || null,
    device_name: stored.device_name || "",
    expires_at: stored.expires_at || null,
    permissions: stored.permissions || [],
    checked_at: stored.checked_at || null,
  };
}

export async function can(permission) {
  const stored = await auth();

  return Array.isArray(stored?.permissions)
    ? stored.permissions.includes(permission)
    : false;
}

export async function token() {
  const stored = await auth();

  return stored?.token || null;
}

/**
 * Exchange an email and password for a token.
 *
 * Returns { ok } or { ok: false, error }, never throws for a refusal — a wrong
 * password is an ordinary outcome of a sign-in form and the options page has to
 * render it, not catch it.
 */
export async function sign_in({ email, password, device_name }) {
  let response;

  try {
    response = await api.sign_in(email, password, device_name);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof NetworkError
          ? error.message
          : "Could not reach the web app.",
    };
  }

  if (!response.ok || !response.body?.token)
    return {
      ok: false,
      error:
        response.body?.error ||
        `The web app refused the sign-in (${response.status}).`,
    };

  const body = response.body;

  await save_auth({
    token: body.token,
    expires_at: body.expires_at || null,
    device_name: body.device_name || device_name || "",
    user: body.user
      ? { id: body.user.id, name: body.user.name, email: body.user.email }
      : null,
    permissions: Array.isArray(body.user?.permissions)
      ? body.user.permissions
      : [],
    checked_at: new Date().toISOString(),
  });

  return { ok: true, user: body.user || null };
}

/**
 * Tell the web app to revoke this token, then forget it locally.
 *
 * Local state is cleared whatever the server said. A manager who clicks sign
 * out on a laptop with no network expects to be signed out of the laptop, and
 * leaving the token in storage because the request failed would be the one
 * outcome she did not ask for. The token then expires on its own, and she can
 * revoke it from /account.
 */
export async function sign_out() {
  try {
    await api.sign_out();
  } catch {
    // Nothing to do about it, and nothing that should stop the local clear.
  }

  await clear_auth();

  return { ok: true };
}

/**
 * Ask the web app who we are, and refresh what we cached about it.
 *
 * Three outcomes worth telling apart, because they need different things from
 * the manager: signed in fine, the token is dead and she must sign in again, or
 * the web app could not be reached and nothing at all is known right now.
 *
 * The last one deliberately does not clear the token. An unreachable server is
 * not a revocation, and treating it as one would sign everybody out of the
 * extension every time the office wifi hiccuped.
 */
export async function heartbeat() {
  const stored = await auth();

  if (!stored?.token) return { status: "signed_out" };

  let response;

  try {
    response = await api.whoami(stored.token);
  } catch (error) {
    return {
      status: "unreachable",
      error: error instanceof NetworkError ? error.message : String(error),
    };
  }

  if (response.status === 401) {
    await clear_auth();

    return { status: "signed_out", error: "Your access was revoked or expired." };
  }

  if (!response.ok)
    return {
      status: "unreachable",
      error: response.body?.error || `The web app answered ${response.status}.`,
    };

  const user = response.body?.user || null;

  await save_auth({
    ...stored,
    user: user ? { id: user.id, name: user.name, email: user.email } : stored.user,
    permissions: Array.isArray(user?.permissions)
      ? user.permissions
      : stored.permissions || [],
    device_name: response.body?.device_name || stored.device_name,
    expires_at: response.body?.expires_at || stored.expires_at,
    checked_at: new Date().toISOString(),
  });

  return { status: "signed_in", user };
}
