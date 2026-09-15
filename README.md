# NSS Appfolio Helper

A Chrome extension for Alabama Signature Homes' office managers. It takes work
orders out of AppFolio and puts them into two places that do not depend on each
other:

- **the ASH web app** — where a subcontractor enters what a job cost, a manager
  marks it up and approves it, and the day's approved work leaves as CSV or
  JSON. This is the leg that matters, and the reason the extension exists now.
- **Buildertrend** — the old destination, still working, unchanged, and
  switchable off in Settings the day ASH stops using it.

Neither leg can break the other. Turning Buildertrend off removes its controls
and its queue and changes nothing about the web app.

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
   the web app's **Your Account** page, where you can end its access.
5. If ASH still uses Buildertrend, check the values in section 3 — job type, job
   group, client name, and the client's Buildertrend row id.

### Local or production

There is no environment switch. The extension talks to whichever address is in
Settings and nothing else, so one install points at one web app at a time:
`http://localhost/projects/alabamasignaturehomes` under XAMPP,
`http://localhost:6789` under the dev server, or the real domain.

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

**The popup** is the ledger afterwards. Rows needing a person come first, with
the reason and either a retry or a link to the record.

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
  notify.js       notifications and the toolbar badge
content/        the page scripts
  appfolio_scrape.js       shared reader, loaded first in both AppFolio entries
  appfolio_list.js         badges, the action bar, reading AppFolio's ticks
  appfolio_work_order.js   the single work-order page
  buildertrend_add_job.js  v1's form filler, near enough unchanged
ui/             popup and options
```

Everything that touches the network lives in the service worker, and that is not
a preference: under Manifest V3 a content script's `fetch` is subject to the
page's CORS rules, so a call to the web app from a script on appfolio.com would
be blocked. Routing it through the worker also means the web app needs no CORS
headers at all.

No build step, no dependencies, no bundler — the browser loads these files as
they are.

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
