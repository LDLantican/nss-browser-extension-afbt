# Architecture

How the extension is built and why it is shaped that way. It is the browser half of the ASH web app
(`alabamasignaturehomes`), and every call it makes to that app goes through the web app's worker API,
`/api/worker/*` (the web app's `docs/reference/worker-api.md`). The decisions behind the worker, its
tokens and its adapters are the web app's: ADR-004 (the delivery state machine), ADR-007 (worker
identity and tokens), ADR-008 (the adapter contract) and ADR-014 (inspections), all under
`alabamasignaturehomes/docs/decisions/`.

## What it does

Three things, all through one sign-in:

- **Import.** On the property manager's AppFolio work-order pages, the work orders a person ticks are
  imported into the web app's work-order system ([Importing](#importing)).
- **Deliver.** As a **delivery worker**, it bills approved work back in AppFolio's vendor portal:
  accepts the work order, posts the photographs, submits the invoice and presses Work Done, through the
  `appfolio_vendor` adapter. It does this by itself, every minute, while the browser is open
  ([The delivery worker](#the-delivery-worker)).
- **Inspections** (since 4.1.0). As the same delivery worker, it puts an inspection ASH approved into
  the property manager's AppFolio: creates it, fills in its areas and items, attaches the photographs
  and marks it done, through the `appfolio_pm` adapter, so the office can make work orders from its
  flags.

The adapters themselves are in [adapters.md](../reference/adapters.md).

## Layout

```
manifest.json      permissions, content scripts, the service worker (permissions-and-storage.md)
background/        the service worker: Settings' half of it
  service_worker.js  the address, sign-in and sign-out, the page check, install clean-up
  api.js             normalizing the address and the origin pattern to ask for
  store.js           the settings, with writes serialized; what the legacy runtime left
  notify.js          notifications
  senders.js         which pages may send the service worker which messages
worker/            the delivery worker (/api/worker/*)
  index.js           the alarm, the worker's messages, the wiring
  runtime.js         one tick: outbox, heartbeat, the job in hand, claims
  job.js             one job as a step machine that survives the worker dying
  client.js          the worker API, device and access tokens
  imports.js         the AppFolio import, on the same credentials
  outbox.js          results kept until the web app has them
  journal.js         a short account of recent jobs, for the popup
  registry.js        the adapters this build carries
  chrome_env.js      every effect the runtime has, over chrome.*
  errors.js          the worker API's error classes, and the errors a step can throw
  silence.js         a page that did not answer, put into words
adapters/          one folder per platform-and-role pair (reference/adapters.md)
  appfolio_vendor/   AppFolio's vendor portal: accept, notes, invoice, Work Done
  appfolio_pm/       the property manager's AppFolio: inspections
    page_bridge.js     runs in the page's own JavaScript world (select2, row addresses, write counting)
  fixture/           a stand-in vendor portal packaged in the extension, for tests
  <id>/manifest.js     id, version, identity, per-operation flags
  <id>/selectors.v1.js everything the adapter knows about the pages' structure
  <id>/adapter.js      the service-worker half: session, plans, verification plans
  <id>/page.js         the page half: one small command at a time
  <id>/site/           the pretend portal, packaged in the extension
content/           the property manager's AppFolio work-order pages
  appfolio_scrape.js       shared reader, loaded first in both entries
  appfolio_list.js         badges, the Import bar, reading AppFolio's ticks
  appfolio_work_order.js   the single work-order page
  appfolio.css             the extension's own controls on those pages, all prefixed .nss-
ui/                popup and Settings
  popup.html/.js/.css      who is signed in, and the delivery worker panel
  worker_panel.js          the popup's "Process ASH jobs" switch and connection states
  options.html/.js/.css    Settings: Web app, Sign in, Troubleshooting
  common.css               shared by both
icons/             16, 32, 48, 64 and 128 px
tests/             run.mjs (Node), index.html + index.js (inside the extension), harness.js,
                   e2e.mjs, e2e_vendor.mjs, e2e_pm.mjs (against the real web app)
  support/           a fake Chrome (fake_env.js), a fake worker API (fake_server.js), fake page
                     scripts (fake_page.js, fake_vendor.js, fake_pm.js), scenarios, a silent page
  adapters/          the page scripts' DOM tests and chrome_env's real-tab test (browser only)
  worker/            the runtime, client, import, silence, adapters and the kill loop
```

No build step, no dependencies, no bundler: the browser loads these files as they are.
[local-development.md](../guides/local-development.md) says how to load and test them.

## Where the network calls are

Every call to the web app is made by the service worker (`worker/client.js`), and that is not a
preference: under Manifest V3 a content script's `fetch` is subject to the page's CORS rules, so a call
to the web app from a script on appfolio.com would be blocked. Routing it through the worker also means
the web app needs no CORS headers at all. Calls carry a bearer token, no cookies
(`credentials: "omit"`) and an `X-Extension-Version` header with the manifest's version.

The one fetch outside the service worker is the import's reader: `content/appfolio_scrape.js` fetches
each ticked row's own AppFolio work-order page and parses it. It runs on appfolio.com, so that request
is same-origin and carries the person's AppFolio session. Rows are read one at a time, so forty rows
never become forty parallel requests against the portal a person is working in.

Adapters never fetch AppFolio either. They drive AppFolio's own pages in a tab, as a person would, by
sending commands to their page script.

## Who may send the service worker what

`chrome.runtime.onMessage` only ever hears this extension, but that includes content scripts, which run
inside pages somebody else controls. So `background/senders.js` tells the two apart:

- **The extension's own pages** (`from_extension_page`: the popup, Settings, the test page) may send
  everything: `STATE`, `SAVE_SETTINGS`, `CHECK_ORIGIN_PERMISSION`, `SIGN_IN`, `SIGN_OUT`, `PROBE_PAGE`
  (`background/service_worker.js`), and `WORKER_STATE`, `WORKER_SET_PROCESSING`, `WORKER_TICK`,
  `WORKER_STOP_AFTER_NEXT_PRESS` (`worker/index.js`).
- **A content script** (`from_tab_on`: an https tab on a named host) may send only what `PAGE_MESSAGES`
  in `worker/index.js` lists:

  | Message | From |
  |---|---|
  | `IMPORT_STATUSES`, `IMPORT` | `*.appfolio.com` (the Import bar and button) |
  | `ASH_VENDOR_SEEN` | `vendor.appfolio.com` (the vendor page script reporting its sign-in) |

  Anything else from a page is answered "That request is not accepted from this page."

The other direction, the worker to a page script, is `ASH_PAGE_COMMAND` (one command),
`ASH_PAGE_TICK` and `ASH_PAGE_DIAG` ([Hidden tabs and silent pages](#hidden-tabs-and-silent-pages)). A
page script answers only messages whose sender is this extension.

## Importing

The bar at the bottom of AppFolio's work-order list, and the button on a single work order's page, is
**Import**. It sends the ticked work orders to the web app through the worker sign-in
(`worker/imports.js`, `/api/worker/imports`). Anyone whose account may add work orders in the web app
may import.

- **The page picks the connection.** Every import and badge lookup carries the AppFolio page's host,
  read by the service worker off the tab Chrome says sent the message (never from anything the page
  wrote), and the company name the page shows. The web app imports through the property-manager
  connection for that host, and refuses a page signed in to another company. A refused lookup says why
  on the bar, not only in a badge's tooltip, and the bar counts what an import did apart: *1 imported,
  2 already imported*.
- **The connection decides test or live.** Each property-manager connection is in `test` or `live`
  mode. In test mode only Dustin's test work orders are imported (their description is `This is a test
  work order approved by Dustin.`); in live mode only real ones. The bar states the mode permanently,
  and a row the mode does not take is refused on the page and again by the web app. **With no mode in
  hand nothing can be imported**: the button says *mode unknown*, and *Retry status* recovers it along
  with the badges.
- **Badges show what the web app holds at the moment they were asked:** `WO-000123 · Assigned ·
  Shauna`, or *not imported*. If the web app cannot be reached or this browser is not signed in, every
  badge says so (*status unknown*, *sign in for status*) rather than showing a remembered value: a
  stale badge would cause a wrong decision silently, and an honest one costs a click.
- **Importing again is safe.** A number the web app already holds is refreshed (its description and
  unit), never doubled. One whose street changed is flagged *address differs* and left for a person.

Rows are chosen with **AppFolio's own row checkboxes**, the ones that drive their header select-all and
their "N Selected" counter. The extension adds no box of its own; it reads theirs. Shift-click selects
a range, which AppFolio does not do by itself. Nothing is ever ticked for you: not every AppFolio work
order is ASH's, and there is no field that says which are. The only two things the extension writes to
the selection are finishing a shift-range you started and clearing rows it has just imported, both by
clicking the box, so AppFolio's own counter never disagrees with what you see.

An import is not a delivery and not the step machine: nothing is clicked in AppFolio and nothing waits
on a lease. A person is present, presses Import and watches the rows change.

## The delivery worker

**What a person sees.** The popup shows who is signed in and the *Delivery worker* panel
(`ui/worker_panel.js`): a **Process ASH jobs** switch (on by default), and for each connection this
browser could work, either "ready" or what would make it ready ("sign in to it in this browser",
"paused on the web app"). Those words are the web app's own answer to the heartbeat. Jobs run in
background tabs gathered into one tab group called **ASH**, on an alarm (`ash-worker-tick`) every
minute: the shortest period Chrome honours, and the only timer that survives the service worker being
ended.

**One browser has to stay open**, signed in to the web app and to the AppFolio sites its connections
need, for work to go out without anybody pressing anything. Any number can be: the server hands a job
to one worker at a time.

### One tick

`worker/runtime.js`, every minute, in this order:

1. close any tab a dead job left in the ASH group (`close_strays`);
2. send whatever results are still in the outbox;
3. heartbeat: the processing switch, the extension version, the adapter versions, and for each
   connection this browser has an adapter for, whether it is signed in there (`live`, `expired` or
   `unknown`, and for the vendor portal the account number it shows); the answer is kept for the popup.
   A connection the browser has not yet reported a session for gets a second heartbeat at once;
4. finish the job in hand, if a service worker died holding one;
5. while processing is on and some connection says this browser may claim, claim and work jobs one at
   a time until the queue answers 204 or the tick's budget is spent: **at most 25 jobs and 240 seconds
   per tick**, so one alarm never runs into the next for long.

One tick runs at a time; a second call while one runs gets the running one's promise. A service worker
that wakes for any other reason with a job in hand resumes it at once rather than waiting for the
alarm, because that job holds a lease.

Everything outside the browser's memory comes through `env`: `worker/chrome_env.js` for Chrome's, and
`tests/support/fake_env.js` for the tests', which is what lets the same code run against a fake Chrome
and a real web app, and be killed anywhere.

### Signing in: two tokens

Signing in (Settings, `/api/worker/register`) registers this browser as a **worker** and returns a
**device token**: good for a year, revocable on the web app's **Your Account** page, and good for
exactly one thing, exchanging it once an hour at `/api/worker/token` for an **access token**. The
device token lives in `storage.local`, because it has to outlive a browser restart; the access token
only in `storage.session`, so closing the browser throws it away. The password is sent once and never
stored.

A 401 on any call means the access token is no good, so the exchange is tried once more and the call
repeated. A 401 on the exchange itself means the device is retired or the account switched off: the
stored identity is forgotten and only signing in again helps.

`worker/client.js` refuses an `http://` address unless it is loopback (`localhost`, `127.0.0.1`,
`[::1]`), because every call carries a bearer token. Changing the web app's address in Settings signs
this browser out, because the new app would refuse the old app's token. What sign-out forgets is in
[permissions-and-storage.md](../reference/permissions-and-storage.md#what-sign-out-clears).

### The step machine

`worker/job.js`. Manifest V3 ends an idle service worker after thirty seconds and may end a busy one for
any reason, taking every variable with it. So a claimed job is a record in `storage.session`
(`ash_worker_job`), written after every step, and a new service worker picks it up where the last one
stopped.

An adapter's plan is a list of short steps, and exactly one of them is the **commit step**: the click
that cannot be taken back (Submit, Save). Every step before it only navigates, reads and types, so a
worker that dies there simply runs that step again. Around the commit step the record says how far it
got, and **each phase is written before the thing it names is done**:

| Phase | Meaning |
|---|---|
| `commit_requested` | about to ask the server's permission (`commit`). Asking again is safe: a holder that is already committing gets the same yes. |
| `committed` | the server said yes and nothing has been clicked. |
| `acting` | the click may have happened. A worker that finds this phase with no result **never clicks again**: it reports `unknown_outcome`, and the server hands the job to a verification, which only looks. |
| `acted` | the click happened and what it produced is recorded. |

So a crash anywhere costs at most one verification, and never a second click.
`tests/worker/kill_loop_test.js` proves it by killing the worker after every single storage write,
request and page command of a job, and after random pairs of them, then letting the alarm finish: no
run may submit twice. The commit step's click is also sent to the page **once**
(`page.send(..., { once: true })`): a page that pressed the button and navigated away before answering
looks exactly like a page that never heard, and asking twice is the double invoice.

The lease is renewed (`touch`) before every step, so it measures silence, not length. A job is given
back (`release`) when nothing was written and it cannot go on: the tab went away before the commit
point, the extension was updated mid-job, or the web app refused the commit because the connection is
paused or the adapter version killed.

**Reports are written before they are sent.** A finished job writes its report, with its own
`attempt_uuid`, into the record first, then into the outbox in `storage.local` (`worker/outbox.js`),
and only then forgets the job. The outbox resends until the web app answers; the server treats a resend
with the same `attempt_uuid` as the same report.

**Switches that fail safe.** The claim carries the connection's `dry_run` and `auto_submit`. Only an
explicit `false` for `dry_run` lets a job past its commit point, and only an explicit `true` for
`auto_submit` lets this browser press the button itself; otherwise the job is rehearsed (every step
before the commit runs) and given back, or the tab is brought to a person to press. A rehearsal is
remembered by delivery and payload hash (`ash_worker_rehearsed`, the last 500), so the same unchanged
job is not rehearsed again every minute.

### The ASH tab group

A job runs in a background tab (`chrome.tabs.create({ active: false })`), gathered into one tab group
named **ASH** (grey), so a desk that works the queue all day collects one group rather than a row of
loose tabs, and not a minimized window, which can stall a page's rendering.

**The group is kept open** (since 4.1.11, `worker/chrome_env.js`). Chrome freezes the tabs of a
collapsed group: on 2026-11-24 the inspection list went silent seven times in the worker's tab, and
Chrome's own word on it was "frozen, a background tab, in a collapsed group". So the group is created
open, opened again if a person collapses it, and checked before every command a page is sent
(`keep_open`).

Every tab the worker opens is written down in `storage.session` (`ash_worker_tabs`) the moment it
exists, so a worker that died holding one closes it at the next tick unless the job in hand still
needs it. A tab handed to a person (`reveal`) is taken out of the group, brought to the front with its
window focused, and announced with a notification.

### Hidden tabs and silent pages

A background tab's timers are slowed: on 2026-11-24 AppFolio's inspection page went unanswered for
30 s in an active, unfrozen background tab, and the same steps took seconds with the tab in front. Two
things answer that:

- **Ticks.** While `page.send` waits for an answer it sends the page `ASH_PAGE_TICK` every 250 ms.
  Nobody answers a tick; the `appfolio_pm` page script uses it to wake its waits (`nap()` in
  `adapters/appfolio_pm/page.js` ends on its timer, a change to the page, or a tick, whichever comes
  first), because a message is handled at once however slowed the page's timers are.
- **Bounded waits.** No wait for a page's answer is longer than the command's own time left (30 s by
  default). A page that takes a command and never answers is a failure, not a hang: `transient` for an
  ordinary command, `unknown_outcome` for a press sent `once`. A page with no ASH script to hear the
  command ("Receiving end does not exist") is told apart from one that heard and went quiet.

When a page has gone quiet, `page.send` asks it `ASH_PAGE_DIAG`, which a page script that is running at
all answers at once (the `appfolio_pm` page script does; the vendor and fixture ones do not), and asks
Chrome about the tab: frozen, discarded, still loading, in front or behind, its group open or
collapsed. `explain_silence()` in `worker/silence.js` puts both into the failure's message, which
reaches the delivery's timeline on the web app: where the command was and for how long, whether the
page was hidden, how late its timers ran, how long long tasks held it, and whether Chrome froze it; or,
when even the status check went unanswered, that its main thread is busy or Chrome froze it.
`silence.js` is pure, so it is tested under Node (`tests/worker/silence_test.js`).

### Is this browser signed in to AppFolio?

Each adapter's `session()` answers for the heartbeat, from a cached answer in `storage.local` that is
trusted for **four minutes** (the web app wants a session report under five minutes old):

- **Vendor portal** (`ash_vendor_session`). Any vendor page a person opens reports its sign-in
  (`ASH_VENDOR_SEEN`, from `adapters/appfolio_vendor/page.js`), which keeps the answer fresh for free.
- **Property manager's AppFolio** (`ash_pm_session`, per host). Only a probe learns it.

When the cached answer is older than four minutes, a **probe** opens the site in a background tab of the
ASH group (the vendor portal's `/`, or the property manager's `/maintenance/inspections`), sees whether
it lands signed in or on AppFolio's sign-in page, and closes the tab either way (20 s at most for the
vendor portal, 30 s for the property manager's). A probe is opened only while **Process ASH jobs** is
on, the connection is enabled, and the web app's last reason for the connection is one a probe could
change (`PROBE_HELPS`: none, `session_not_live`, `session_stale`, `heartbeat_stale`,
`adapter_not_reported`); "not an operator", "paused" or "killed" open no tab. A job that finds itself
signed out marks the cached answer `expired` at once (`session_lost`).

## Settings

`ui/options.html`, three tabs (the hash names the tab, so `options.html#troubleshooting` opens on it):

- **Web app**: the address, and whether Chrome has granted permission to call it. The permission is
  requested from the Save button's own click, because `chrome.permissions.request` needs a user
  gesture ([local-development.md](../guides/local-development.md#point-it-at-a-web-app)).
- **Sign in**: the worker sign-in, and once signed in, who, which device, and the worker's number,
  with **Sign out this device**.
- **Troubleshooting**: **Check the page** reads the AppFolio tab you used most recently (a
  vendor-portal work order, or one of the property manager's inspection pages; tabs the worker opened
  are skipped) and lists which of its adapter's hooks it found. It clicks and types nothing, so it is
  safe on a real page. **Stop after the next press** stops this browser dead straight after its next
  press, as if Chrome had ended it, which is how the live kill runs are done; it ships unarmed
  (`ash_worker_stop_after_press` absent).

## Install and update clean-up

The legacy runtime (before 4.0.0; [2025-10-20-legacy-runtime.md](../archive/2025-10-20-legacy-runtime.md))
stored a session token, queues, Buildertrend state and tab-error reports with screenshots. On every
install and update (`chrome.runtime.onInstalled` in `background/service_worker.js`), `remove_legacy()`
in `background/store.js` removes its `storage.local` and `storage.session` keys and the settings only it
read, keeping the web app's address; the service worker also clears its two alarms
(`nss-delivery-drain`, `nss-sync-retry`) and the count it kept on the toolbar icon. It runs every time
rather than once behind a flag, because removing a key that is not there costs nothing. The legacy
session token is dropped, not revoked: it is ended from the web app's `/account` page.

On install and on every browser start the alarm is created again (`chrome.alarms.create` replaces one of
the same name), and every service-worker wake checks it exists and resumes a job in hand.
