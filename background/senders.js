/**
 * Who may ask the service worker for what.
 *
 * chrome.runtime.onMessage only ever hears this extension — no web page can
 * send to it — but "this extension" includes content scripts, and a content
 * script runs inside a page somebody else controls. So the messages that
 * change what the extension *is* — its settings, its sign-in, the worker's
 * switches — are answered only for the extension's own pages (the popup,
 * Settings), and the few a content script needs are answered only for a tab on
 * the site that script is written for.
 */

/** The popup, Settings, or another page packaged in this extension. */
export function from_extension_page(sender) {
  if (sender?.id !== chrome.runtime.id) return false;

  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

/**
 * A content script in a tab on one of `hosts` — exact names, or `*.example.com`
 * for any subdomain. https only, as every manifest match pattern here is.
 */
export function from_tab_on(sender, hosts) {
  if (sender?.id !== chrome.runtime.id || !sender.tab) return false;

  let url;

  try {
    url = new URL(sender.url || sender.tab.url || "");
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  return hosts.some((host) =>
    host.startsWith("*.") ? url.hostname.endsWith(host.slice(1)) : url.hostname === host,
  );
}
