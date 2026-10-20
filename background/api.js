/**
 * The web app's address, as the service worker stores and asks permission for.
 *
 * Every request to the web app is the delivery worker's now
 * (worker/client.js), and that module checks the address again before each
 * call — https only, except on this machine. What is left here is the two
 * things Settings needs before there is a worker: the stored form of the
 * address, and the origin pattern to ask Chrome for.
 */

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
