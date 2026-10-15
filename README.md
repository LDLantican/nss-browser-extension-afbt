# NSS Appfolio Helper

A Chrome extension for Alabama Signature Homes' office managers. It takes work
orders out of AppFolio and puts them into two places that do not depend on each
other:

- **the ASH web app** — where a subcontractor enters what a job cost, a manager
  marks it up and approves it, and the day's approved work leaves as CSV or
  JSON. This is the leg that matters, and the reason the extension exists now.
- **Buildertrend** — the old destination, still working, unchanged, and
  switchable off in Settings the day ASH stops using it.

Turning Buildertrend off in Settings removes its controls and its queue and
changes nothing about the web app.

**The reverse is no longer true, deliberately.** The Buildertrend leg re-reads
from the web app, at the moment of filling, which population of work orders this
installation may touch — so a web app that cannot be reached stops jobs being
created in Buildertrend even though Buildertrend itself is fine. That is the
owner's rule applied to the obvious failure: a work order must not end up in one
system and not the other, and the way to honour that is to refuse rather than to
guess on a stale answer about whether something is test data.

## Why the web app

Today, billing Camelot for a job means importing the AppFolio work order into
Buildertrend, building an estimate there, building an invoice there, and pushing
the result back to AppFolio. Four steps in a tool whose only purpose in the
chain is to capture ASH's own cost-versus-billed figures, done by hand for a
hundred-odd work orders a day. The web app replaces that middle, and this
extension is the first step of it.

## Setting it up

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Open the extension → **Settings**.
3. Enter the web app's address and save. **The browser will ask permission to
   contact it** — this is expected, and the extension cannot reach the web app
   without it. A user-typed address cannot be declared in the manifest, so the
   permission is requested at the moment you save.
4. Sign in with your web app email and password. This exchanges them once for a
   token stored in this browser; the password is not kept. The device appears on
   the web app's **Your Account** page, where you can end its access. The same
   sign-in registers this browser as a **delivery worker** for the new queue
   (see [The 3.0 delivery worker](#the-30-delivery-worker)), which is listed on
   that page too.
5. If ASH still uses Buildertrend, check the values in section 3 — job type, job
   group, client name, and the client's Buildertrend row id.

### Local or production

There is no environment switch. The extension talks to whichever address is in
Settings and nothing else, so one install points at one web app at a time:
`http://localhost/projects/alabamasignaturehomes` under XAMPP,
`http://localhost:6789` under the dev server, or the real domain.

**Only those.** Since 3.0 the manifest names the addresses it may ever ask for —
`https://alabamasignaturehomes.com`, its subdomains, and `localhost` /
`127.0.0.1` on any port — where it used to accept any address at all. Every
call carries a credential, so anything that is not this computer must be https.
A web app moved to another domain needs a manifest change and a new version.

**Changing that address signs this device out and clears the sync list**, on
purpose. The token was issued by the app you are leaving and the new one will
refuse it; more importantly the sync list stores work-order ids, and the popup
builds a record link as `<address>/work-orders/<id>` — so a stale id against a
new address gives a *working* link to a different, real work order. The
Buildertrend queue is kept, since it has nothing to do with which web app is
configured.

The comparison is the whole address, not just the host, because under XAMPP every
project shares `http://localhost` and differs only by path. Dropping a trailing
slash is normalized away and does not count as a change. Saving the Buildertrend
settings never signs anybody out.

## Using it

**Syncing writes to both places.** Ticked rows go to the web app first — it is
the system of record, and the fast, reliable half — and then a Buildertrend job
is created for each, one at a time, in one tab. There is no "also queue for
Buildertrend" checkbox any more: a job has to exist in both, so making the second
one optional was the wrong shape, and the checkbox's state lived only in the bar
and reset on every re-render, so ticking it and then sorting the list silently
lost it.

A work order the web app already holds a Buildertrend URL for is **skipped**
rather than created again. That is the only duplicate check available — there is
no API to ask Buildertrend whether a job exists — and without it a re-run after
an unconfirmed save makes a second real job.

If Buildertrend fails, the web app still has the work order and knows it has no
Buildertrend job. Nothing is silently out of step; finishing the missing half is
a re-run rather than an investigation.

**A row leaves the queue when its job is created, not when its link is
recorded.** Waiting for the link reads as the careful choice and is the
dangerous one: a job whose id could not be read stayed queued, so the next sync
created a *second* job with the same title — and two jobs sharing a title cannot
be told apart afterwards, so neither can ever be linked. Creation empties the
row instead, and anything still unlinked is listed in the popup with a **Link
now** button. That button searches Buildertrend and records what it finds; it
never opens the add-job page, so pressing it twice cannot create anything.

A job created but not identified no longer stops the rest of the batch either.
Stopping is right for a systemic failure — signed out, web app unreachable —
because the remaining rows would fail the same way. An unreadable id is not
that: the job is fine, and the link is one click to repair.

**Settings → 4 · Troubleshooting** shows what the last Buildertrend run did, per
job, as plain text meant to be screenshotted or pasted. It exists because this leg once failed six
runs in a row while reporting nothing at all.

**On the AppFolio work-order list**, rows are chosen with **AppFolio's own row
checkboxes** — the ones that drive their header select-all and their "N
Selected" counter. The extension adds no box of its own; it reads theirs. It
used to add one, and the result was two checkboxes on every row a thumb's width
apart, with no way to tell which meant *sync* and which sat beside *Cancel*.
Shift-click selects a range, which AppFolio does not do by itself. Every row
also gains a status badge read live from the web app, and the bar at the bottom
sends what is ticked and optionally queues the same rows for Buildertrend.

Nothing is ever ticked for you: not every AppFolio work order is ASH's, and
there is no field that says which are, so the choice stays yours. The only two
things the extension writes to the selection are finishing a shift-range you
started and clearing rows it has just sent — and it does both by clicking the
box, so AppFolio's own counter never disagrees with what you see. (Setting
`checked` and firing a `change` event does not update their counter; only a
click does. Measured against the live list, not assumed.)

A row is read by fetching its own work-order page and parsing it — confirmed
working against a live list — rather than by clicking expand and reading the
fields on the next statement, which is the race that used to leave fields empty.

**A badge says what the web app holds right now** — not imported, synced,
who it is assigned to, whether it is approved. If the web app cannot be reached
or this device is signed out, every badge says *status unknown* rather than
showing a remembered value. That is deliberate: a stale badge would cause a
wrong decision silently, and an honest one costs a click.

**The popup** is written for whoever is doing the day's work, and answers two
questions: is everything all right, and does anything need me? It shows one
status line (*All caught up*, *N things need your attention*, *Sending…*, or
*Checking for approved work…* when no invoice run has finished in ten minutes),
then only the rows a person has to act on — each with the reason and one button
(*Try again*, *Open in web app*, *Link now*, *Add to Buildertrend*, or *Sign in*
when approved invoices or estimates are held up by a signed-out AppFolio or
Buildertrend) — and a folded
*Recently sent* list. Its footer says approved work goes out by itself every
minute and offers **Send now**, which runs the invoice pass and then the
estimate pass and reports the result in one sentence.

Everything for working out *why* something went wrong is in **Settings → 4 ·
Troubleshooting** instead: the invoice and estimate runs as separate buttons
with every count they keep, the vendor-page check, the last Buildertrend run
reports, clearing the Buildertrend queue, and the tab-error reports.

**Sending is safe to repeat.** The web app keys work orders on client and
number, so re-sending one either creates it or refreshes a few fields — it can
never move a job backwards, unassign anyone, or change the title something was
billed under. After every batch the extension asks the web app what it actually
holds and records that, rather than recording what it believes it sent. So an
interrupted batch costs a retry, not a reconciliation.

## Layout

```
background/     the service worker: all network, credentials and queues
  api.js          every request to the web app
  auth.js         sign-in, sign-out, heartbeat
  store.js        chrome.storage, with writes serialized
  sync.js         the durable queue, retries, and the reconcile step
  delivery.js     draining the delivery queue into the Appfolio vendor portal
  portals.js      is anybody signed in to the vendor portal / Buildertrend
  buildertrend.js opening and driving the Buildertrend tab
  owned_tabs.js   which tabs this extension opened, locking them, closing them
  tab_errors.js   what a tab showed when a run gave up on it
  notify.js       notifications and the toolbar badge
  senders.js      which pages may send the service worker which messages
worker/         the 3.0 delivery worker (the new queue, /api/worker/*)
  runtime.js      one tick: outbox, heartbeat, the job in hand, claims
  job.js          one job as a step machine that survives the worker dying
  client.js       the worker API, device and access tokens
  outbox.js       results kept until the web app has them
  journal.js      the popup's short account of recent jobs
  registry.js     the adapters this build carries
  chrome_env.js   every effect the runtime has, over chrome.*
  index.js        the alarm, the messages, the wiring
adapters/       one folder per platform-and-role pair
  fixture/        a stand-in vendor portal packaged in the extension, for tests
content/        the page scripts
  appfolio_scrape.js       shared reader, loaded first in both AppFolio entries
  appfolio_list.js         badges, the action bar, reading AppFolio's ticks
  appfolio_work_order.js   the single work-order page
  buildertrend_add_job.js  v1's form filler, near enough unchanged
  tab_guard.js             the lock on a tab the extension is working in
ui/             popup and options
tests/          node tests/run.mjs, or open tests/index.html inside the extension
```

Everything that touches the network lives in the service worker, and that is not
a preference: under Manifest V3 a content script's `fetch` is subject to the
page's CORS rules, so a call to the web app from a script on appfolio.com would
be blocked. Routing it through the worker also means the web app needs no CORS
headers at all.

No build step, no dependencies, no bundler — the browser loads these files as
they are.

## The 3.0 delivery worker

The web app is moving its work orders to new tables (its
`docs/architecture/`), and with them to a new delivery queue that this
extension works through `/api/worker/*` (the web app's `docs/worker-api.md`).
3.0 adds the runtime for that queue **beside** the one above, which keeps
draining the legacy queue until legacy is retired. The two share nothing but
the web app's address: separate credentials, a separate alarm
(`ash-worker-tick`, every minute), separate tabs.

**What a person sees.** The popup's *Delivery worker* panel: a **Process ASH
jobs** switch (on by default), and for each connection this browser could work,
either "ready" or what would make it ready — "sign in to it in this browser",
"paused on the web app". Those words are the web app's own answer to the
heartbeat. Jobs run in background tabs gathered into one collapsed tab group
called **ASH**.

**Signing in.** The Settings sign-in also registers this browser as a worker
and keeps a **device token** (a year, revocable at *Your Account*) in
`storage.local`. Each hour the device token is exchanged for an **access token**
kept only in `storage.session`, so closing the browser throws it away. An
install upgraded from 2.x is not registered until somebody signs in again.

**Crash safety.** A job is a list of short steps saved to `storage.session`
after each one, so a service worker that dies — Chrome ends them freely —
leaves a record the next one picks up. Exactly one step is the click that
cannot be taken back. The server must say yes to it first (`commit`), the record
says `acting` *before* the click, and a worker that finds `acting` with no result
**never clicks again**: it reports an unknown outcome and the server sends a
verification, which only looks. Results go into an outbox in `storage.local`
and are resent until the web app answers; it treats a resend as the same report.
`worker/job.js` explains each phase.

**Safe defaults.** A connection's `dry_run` must be explicitly false before
anything is submitted, and its `auto_submit` explicitly true before this browser
presses the button; otherwise the job is rehearsed and given back, or the tab is
brought to a person to press. (The legacy runtime defaulted both the other way
until 3.0.)

**Adapters.** A platform's page knowledge lives in `adapters/<id>/` — a
manifest, a versioned selector file, the steps, and the page script — and the web
app can switch a version off without touching the others. 3.0 ships one, the
`fixture` adapter, which bills a pretend portal packaged in the extension and is
only offered work by a connection someone made for it on purpose. The
vendor-portal adapter is roadmap phase 9.

**Tests.** `node tests/run.mjs` (Node is only the place they run — there is no
package.json) or `tests/index.html` opened inside the extension, which also runs
the fixture page's DOM and Chrome's real tabs. The kill loop kills the worker
after every single storage write, request and page command of a job, and after
random pairs of them, then lets the alarm finish: no run may submit twice. The
web app's `tests/integration/extension_test.php` runs the same loop against the
real worker API.

**The web app's `DELIVERY_EXTENSION_VERSION` must say `3.0.0`** once this
version is loaded, or both queues answer 426 — the legacy drain included.

## The tabs it opens

Three things open a tab and drive it: delivering invoices into the vendor
portal, creating Buildertrend jobs, and writing Buildertrend estimates. Each tab
is recorded in `background/owned_tabs.js`, and nothing else is ever treated as
the extension's — a vendor-portal or Buildertrend tab you opened yourself is
never adopted, locked or closed.

**While a run is working in one, the tab is locked.** A banner says what it is
doing, and every real click, tap, scroll and keystroke in the page is swallowed.
The automation is unaffected, because what it does to the page produces events
the browser marks as untrusted, and only trusted ones are blocked.

**What a page cannot stop** is the tab being closed, reloaded, or navigated from
the address bar, Back button or a browser shortcut. Closing is detected: a run
whose tab you close stops, and says so, rather than opening another behind your
back. So don't close one mid-run unless you mean to stop it.

**The lock cannot outlive the run.** The page asks every three seconds whether
it is still locked, and the answer comes only from the running service worker.
If that worker is gone — crashed, evicted, extension reloaded — the answer is
"no", the banner lifts, and the next worker closes the tab it left behind.

**A tab is closed when its run finishes, and whenever something goes wrong in
it**, whether the run was scheduled or started from the popup. Two are handed to
you instead — unlocked, brought forward, and left alone from then on:

- a **sign-in page**, when AppFolio or Buildertrend has signed you out;
- a **filled invoice waiting for Submit Invoice**, when automatic submitting is
  off.

A sign-in page is only brought forward when you pressed a button. Invoices and
estimates are also delivered **every minute by themselves** — the web app's
Approve is the last thing a manager has to do — and a timed run that finds you
signed out leaves its sign-in tab in the background, shows one notification,
and waits for that tab rather than opening another every minute. Sign in on it
and the next minute's run carries on.

So **one browser has to stay open, with this extension signed in to the web app
and to AppFolio's vendor portal and Buildertrend.** Any number can be — two
browsers never deliver the same job twice — and a laptop that should not write
estimates by itself can say so in **Settings → 3 · Buildertrend**.

### Tab errors

Closing a tab on an error takes away the page that showed what went wrong, so a
report is kept first. **Settings → 4 · Troubleshooting** lists them, newest first:
the time, which leg, the work order, the step, the error, the page address, a
copy of the page, and a screenshot when the tab happened to be on screen. A tab
running in the background is never brought forward just to be photographed, so
delivery reports usually have the page copy and no screenshot. The popup says
*A background task ran into a problem* when there are reports you have not
looked at, and links straight to them.

The page copy includes what had been typed into the form, and **excludes
anything that signs anybody in**: scripts, hidden fields, password fields and
anything named like a token are stripped. The last 50 reports are kept, and the
newest 10 keep their screenshot and page copy. **Copy as text** leaves the
pictures out; **Download JSON** includes them.

They stay in this browser. Each report is one JSON object with a version number,
handed to a list of destinations of which this browser is currently the only
one, so sending them to the web app later is an addition rather than a rewrite.

## Sample mode

The web app is set to one population of work orders at a time, and says which on
every answer it gives:

- **sample** — only the work orders Dustin marks as tests in AppFolio, whose
  description is `This is a test work order approved by Dustin.`
- **live** — only real work orders.

The bar on the AppFolio list states the mode permanently, and a ticked row the
mode does not admit is refused there, on the row, with the reason — it stays
ticked rather than disappearing. **If the web app cannot be reached, nothing can
be sent at all**: the button says *mode unknown* and is disabled, because not
knowing which population this app is pointed at is not a reason to guess. The
*Retry status* link recovers it along with the badges.

The extension never remembers the mode, and never carries its own copy of the
marker text. Both arrive from the web app, and the web app checks everything it
is sent again regardless.

Two places it matters beyond the list. Buildertrend has no test mode, so a job
built from a sample is a real Buildertrend job — it gets a `[TEST] ` title
prefix so those can be found and deleted, and the mode is re-read from the
server at the moment the job is filled rather than when the row was queued.
And before an invoice is typed into the AppFolio vendor portal, the extension
re-reads that work order's description **off the vendor page itself** and stops
if it disagrees with what the web app holds.

## Previously known limitation, now fixed

`simulateInputTyping` in `content/buildertrend_add_job.js` used to write
`input.value` directly instead of going through the native property setter, so
React's value tracker did not see the change and Ant Design fields reverted.
That was the cause of the recurring "field resetting" problems.

It was left unfixed while Buildertrend's future was undecided. It is decided —
Buildertrend is ASH's system of record for non-Camelot work orders — so the
value now goes in through the native setter.
