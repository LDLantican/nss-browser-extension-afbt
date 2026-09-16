/**
 * Is anybody signed in to the portal?
 *
 * Two destinations this extension writes to and does not own — the AppFolio
 * vendor portal and Buildertrend — and both sessions lapse silently. Neither
 * caller used to ask before acting, and the cost was unequal: delivery claimed
 * a row first and discovered the problem second, so a signed-out portal spent
 * one job's attempt and posted a `failed` that counted toward the circuit
 * breaker; Buildertrend opened a focused tab first, so it took the manager's
 * screen to show her a login page.
 *
 * ## The signal is the URL, for both
 *
 * Observed live on 14 September 2026 by signing out of each:
 *
 *   vendor.appfolio.com  ->  passport.appf.io/sign_in/request_access_link?idp_type=vendor
 *   buildertrend.net     ->  login.buildertrend.com/u/login?state=...   (Auth0)
 *
 * Both land on a **third-party identity origin**, which is the fact the whole
 * file turns on. Neither origin is matched by any `content_scripts` entry in
 * the manifest, so no page script runs there and there is nothing to ask — a
 * message to that tab throws "receiving end does not exist", which is exactly
 * what a slow load looks like. So a DOM check cannot see a real sign-out at
 * all, and the background URL check is the only thing that can.
 *
 * This is why `appfolio_vendor_invoice.js`'s `read_state()` never fired in
 * practice. It looks for a visible `input[type='password']` and a
 * `/sign in|log in/` title, and on the page a signed-out manager actually
 * reaches there is neither: the default is an emailed access link
 * (`input[type='email']#usernameInput`, a password only under *More Sign In
 * Options*) and the title is `Passport | AppFolio`. It is kept as a secondary
 * confirmation, not as the guard.
 *
 * `buildertrend.js` had the right idea in v1 — `report_not_ready()` already
 * treats "the URL left /app/JobPage/0/" as the reliable signal — and this
 * generalises it rather than replacing it.
 *
 * ## Three answers, and `unknown` is not `signed_out`
 *
 * A wrong `signed_out` blocks a queue that works. A wrong `unknown` just falls
 * through to the behaviour that existed before this file. So absence of proof
 * is never proof: the rule `buildertrend_add_job.js` states as "the ABSENCE of
 * a ready signal is never treated as proof of this", and the delivery notes as
 * "an inference about what is absent is not an observation."
 */

export const PORTALS = {
  appfolio: {
    label: "the AppFolio vendor portal",
    home: "https://vendor.appfolio.com/",
    host: "vendor.appfolio.com",
    sign_in_hosts: ["passport.appf.io"],
    status_message: "VENDOR_PAGE_STATUS",

    /* The content script's word for "loaded and signed in". The two pages
       answer with different vocabularies and neither is worth renaming. */
    ready_state: "ready",
    signed_out_state: "signed_out",

    /* Worth asking. VENDOR_PAGE_STATUS is deliberately exempt from the
       await_ready() gate — it is the liveness handshake and must answer
       instantly or it cannot be told from a page with no script on it — so
       polling it is cheap and it corroborates the URL. */
    ask_page: true,
  },

  buildertrend: {
    label: "Buildertrend",
    home: "https://buildertrend.net/app/JobPage/0/1?openCondensed=true",
    host: "buildertrend.net",

    /* Buildertrend serves plenty of pages this extension has no script on, so
       the host alone is not enough — the job form is the page it drives, and
       leaving that path is the v1 signal this generalises.
       
       A **list**, because there are two such pages now: the add-job form and
       the estimate screen. With one prefix the estimate page classified as
       `elsewhere`, which check_signed_in() reports as `unknown` for ever
       rather than as a session it can act on. */
    path_prefixes: ["/app/JobPage/0/", "/app/Estimate"],
    sign_in_hosts: ["login.buildertrend.com"],
    status_message: "ADD_JOB_PAGE_STATUS",
    ready_state: "ready",
    signed_out_state: "signed-out",

    /* Not asked, and this is the one asymmetry in the file.
     *
     * ADD_JOB_PAGE_STATUS returns the page's memoized verdict, and working that
     * verdict out involves determinePageState() polling the DOM for up to
     * forty-five seconds. Asking it repeatedly would stack those waits into
     * minutes, and it would buy nothing: the URL is the whole signal here —
     * v1's own report_not_ready() already treats leaving /app/JobPage/0/ as the
     * reliable one — and fill_job runs the real handshake immediately after
     * this returns, so the DOM still gets its say before anything is typed. */
    ask_page: false,

    /* How many consecutive readings must say "still on the job page" before
     * that counts as signed in.
     *
     * More than one, because here the redirect *is* the verdict and a redirect
     * takes time: a single reading taken the instant the tab reports
     * `complete` can be taken from a page that is about to leave. AppFolio
     * needs no equivalent — the content script's "ready" is a positive
     * statement about what rendered, which a page on its way to Passport
     * cannot make. */
    confirmations: 3,
  },
};

/**
 * Where a tab currently is, relative to the portal we want.
 *
 * `sign_in` is asserted only for a host we have actually seen a sign-out land
 * on. Anything else unrecognised is `elsewhere`, which is a question and not an
 * answer — an identity provider that changes hostname must read as "I do not
 * know" rather than as "signed in".
 */
export function classify_url(site, url) {
  const portal = PORTALS[site];
  if (!portal || !url) return "elsewhere";

  let parsed = null;

  try {
    parsed = new URL(url);
  } catch {
    return "elsewhere";
  }

  if (portal.sign_in_hosts.includes(parsed.hostname)) return "sign_in";

  if (parsed.hostname !== portal.host) return "elsewhere";

  if (portal.path_prefixes && !portal.path_prefixes.some((prefix) => parsed.pathname.startsWith(prefix)))
    return "elsewhere";

  return "portal";
}

/**
 * Ask a tab that is already on (or on its way to) the portal.
 *
 * The caller owns the tab. That is what lets delivery.js hand over the one
 * background tab it already keeps and reuses across every job, so the check
 * before the first claim costs no extra page load at all — and it keeps this
 * file from importing delivery.js, which imports nothing from here.
 *
 * It polls rather than reading once, because the redirect that decides the
 * answer is **client-side**: AppFolio serves a 200 Next.js shell to an
 * unauthenticated request and only sends the browser to Passport after it
 * hydrates. A single read taken the moment `tab.status` turns `complete` is
 * therefore taken before the page has decided, and would report the portal.
 *
 * The budget is measured, not guessed. A cold navigation to a signed-out
 * `vendor.appfolio.com` took about four seconds to land on Passport (observed
 * 14 September 2026), so sixteen half-second attempts leaves roughly double
 * that. It is only ever spent on an ambiguous or signed-out portal: a signed-in
 * one answers on the first attempt and returns immediately.
 */
export async function check_signed_in(site, tab_id, { attempts = 16, interval = 500 } = {}) {
  const portal = PORTALS[site];

  if (!portal) return { state: "unknown", detail: `Unknown portal: ${site}.`, url: "" };
  if (tab_id === null || tab_id === undefined)
    return { state: "unknown", detail: "No tab to look at.", url: "" };

  let last_url = "";

  /* Consecutive readings that found the tab still on the portal. Reset by
     anything else, so a page that wanders off and comes back starts again. */
  let settled = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const tab = await chrome.tabs.get(tab_id).catch(() => null);

    /* The tab is gone. Not evidence about anybody's session. */
    if (!tab) return { state: "unknown", detail: "That tab was closed.", url: last_url };

    last_url = tab.url || "";

    const where = classify_url(site, last_url);

    if (where !== "portal") settled = 0;

    /* Certain, and the only certain answer this function has. */
    if (where === "sign_in")
      return {
        state: "signed_out",
        detail: `Nobody is signed in to ${portal.label}.`,
        url: last_url,
      };

    if (where === "portal" && tab.status === "complete") {
      /* Nothing to ask: the URL is the verdict, and the caller does its own
         handshake straight afterwards. It has to hold still first — see
         `confirmations`. */
      if (!portal.ask_page) {
        settled += 1;

        if (settled >= (portal.confirmations || 1))
          return { state: "signed_in", detail: "", url: last_url };
      } else {
        const said = await ask_page(tab_id, portal.status_message);

        /* The page confirms it rendered as a signed-in page. */
        if (said === portal.ready_state)
          return { state: "signed_in", detail: "", url: last_url };

        /* The DOM check still exists and is still believed when it speaks — it
           just is not the thing being waited for. */
        if (said === portal.signed_out_state)
          return {
            state: "signed_out",
            detail: `Nobody is signed in to ${portal.label}.`,
            url: last_url,
          };

        /* Anything else — "unknown" from a page still rendering, or "" from a
           script that is not listening — falls through to another attempt, and
           to the URL check at the top of it, which is the one that can see a
           cross-origin redirect. */
      }
    }

    if (attempt < attempts - 1)
      await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return {
    state: "unknown",
    detail: `Could not tell whether anybody is signed in to ${portal.label}.`,
    url: last_url,
  };
}

/**
 * One handshake, with a missing listener treated as no answer.
 *
 * A throw here is genuinely ambiguous — the content script runs at
 * document_idle and may not be listening yet, *or* there may be no content
 * script on this origin at all, which is the case on both sign-in pages. The
 * caller's URL check is what tells those apart, so this only has to be quiet
 * about it.
 */
async function ask_page(tab_id, type, timeout = 4000) {
  let timer = null;

  try {
    return await Promise.race([
      Promise.resolve(chrome.tabs.sendMessage(tab_id, { type })).then((r) => r?.state || ""),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out.")), timeout);
      }),
    ]);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bring the sign-in page to the front.
 *
 * The tab is already sitting on it — the redirect that produced the verdict put
 * it there — so this is a focus, never a navigation. Nothing is typed and no
 * credential is ever read or stored by this extension.
 */
export async function show_sign_in(tab_id) {
  if (tab_id === null || tab_id === undefined) return;

  const tab = await chrome.tabs.get(tab_id).catch(() => null);
  if (!tab) return;

  await chrome.tabs.update(tab_id, { active: true }).catch(() => null);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
}

/* ---- one sign-in tab per portal, however many runs find it signed out ---- */

const SIGN_IN_TABS_KEY = "nss_sign_in_tabs";

/**
 * The sign-in tab a run already put in front of somebody, if it is still one.
 *
 * Both drainers run on a one-minute timer now, and a signed-out portal is the
 * normal state of an office PC after a weekend. Each run used to hand its tab
 * over and focus it, and the next minute's run — holding no memory of that —
 * opened another and focused that too: a tab and a stolen window a minute, for
 * as long as nobody was at the desk.
 *
 * So the handed-over tab is remembered, and this answers whether it still
 * stands for "nobody has signed in yet". It does only while the tab is open
 * **and still on the identity provider's page** — the moment somebody signs in
 * the tab leaves that host, and the moment they close it the tab is gone, and
 * either way the next run goes back to asking the portal itself. The record is
 * never the verdict; the tab's own address is.
 *
 * `chrome.storage.session` because the worker is evicted between alarms, and
 * not `storage.local` because a browser restart takes the tab with it.
 */
export async function waiting_sign_in_tab(site) {
  let tabs = {};

  try {
    ({ [SIGN_IN_TABS_KEY]: tabs = {} } = await chrome.storage.session.get(SIGN_IN_TABS_KEY));
  } catch {
    return null;
  }

  const tab_id = tabs?.[site];
  if (!Number.isInteger(tab_id)) return null;

  const tab = await chrome.tabs.get(tab_id).catch(() => null);

  if (tab && classify_url(site, tab.url || tab.pendingUrl || "") === "sign_in") return tab_id;

  await forget_sign_in_tab(site);

  return null;
}

export async function remember_sign_in_tab(site, tab_id) {
  if (!Number.isInteger(tab_id)) return;

  try {
    const { [SIGN_IN_TABS_KEY]: tabs = {} } = await chrome.storage.session.get(SIGN_IN_TABS_KEY);

    await chrome.storage.session.set({ [SIGN_IN_TABS_KEY]: { ...tabs, [site]: tab_id } });
  } catch {
    /* Losing this costs one extra sign-in tab, not a wrong answer. */
  }
}

async function forget_sign_in_tab(site) {
  try {
    const { [SIGN_IN_TABS_KEY]: tabs = {} } = await chrome.storage.session.get(SIGN_IN_TABS_KEY);

    delete tabs[site];
    await chrome.storage.session.set({ [SIGN_IN_TABS_KEY]: tabs });
  } catch {}
}
