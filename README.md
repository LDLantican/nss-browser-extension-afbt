# NSS Appfolio Helper

A Chrome extension for Alabama Signature Homes' office. It is the browser half
of the ASH web app, and since 4.0.0 it does exactly two things, both through one
sign-in:

- **Import.** On the property manager's AppFolio work-order pages, the work
  orders a person ticks are imported into the web app's work-order system.
- **Deliver.** As a **delivery worker**, it bills approved work back in
  AppFolio's vendor portal — accepts the work order, posts the photographs,
  submits the invoice and presses Work Done — through the `appfolio_vendor`
  adapter. It does this by itself, every minute, while the browser is open.

Both go through the web app's worker API (`/api/worker/*`, the web app's
`docs/worker-api.md`) and nothing else.

**4.0.0 removed the legacy runtime.** Sync, the legacy delivery drain, the
Buildertrend leg (jobs and estimates), the tab-error reports and the session
sign-in at `/api/session` are gone, along with the web app endpoints they
called. An upgraded browser forgets what that runtime stored the first time
4.0.0 starts, keeping only the web app's address, and has to be signed in once
more if it never signed in as a worker.

## Setting it up

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Open the extension → **Settings**.
3. Enter the web app's address and save. **The browser will ask permission to
   contact it** — this is expected, and the extension cannot reach the web app
   without it. A user-typed address cannot be declared in the manifest, so the
   permission is requested at the moment you save.
4. Sign in with your web app email and password. This registers this browser as
   a worker (`/api/worker/register`) and keeps the **device token** it is given;
   the password is not kept. The device appears on the web app's **Your
   Account** page, where you can retire it.

### Local or production

There is no environment switch. The extension talks to whichever address is in
Settings and nothing else, so one install points at one web app at a time:
`http://localhost/projects/alabamasignaturehomes` under XAMPP,
`http://localhost:6789` under the dev server, or the real domain.

**Only those.** The manifest names the addresses it may ever ask for —
`https://alabamasignaturehomes.com`, its subdomains, and `localhost` /
`127.0.0.1` on any port. Every call carries a credential, so anything that is
not this computer must be https. A web app moved to another domain needs a
manifest change and a new version.

**Changing that address signs this device out**, on purpose: the device token
was issued by the app you are leaving and the new one will refuse it. The
comparison is the whole address, not just the host, because under XAMPP every
project shares `http://localhost` and differs only by path. Dropping a trailing
slash is normalized away and does not count as a change.

## Importing

The bar at the bottom of AppFolio's work-order list, and the button on a single
work order's page, is **Import**. It sends the ticked work orders to the web app
through the worker sign-in (`worker/imports.js`). Anyone whose account may add
work orders in the web app may import.

- **The page picks the connection.** Every import and badge lookup carries the
  AppFolio page's host, read off the tab that asked, and the company name the
  page shows. The web app imports through the property-manager connection for
  that host, and refuses a page signed in to another company. A refused lookup
  says why on the bar, not only in a badge's tooltip, and the bar counts what an
  import did apart: *1 imported, 2 already imported*.
- **The connection decides test or live.** Each property-manager connection is in
  `test` or `live` mode. In test mode only Dustin's test work orders are imported
  (their description is `This is a test work order approved by Dustin.`); in live
  mode only real ones. The bar states the mode permanently, and a row the mode
  does not take is refused on the page and again by the web app. **With no mode
  in hand nothing can be imported**: the button says *mode unknown*, and *Retry
  status* recovers it along with the badges.
- **Badges show what the web app holds right now:** `WO-000123 · Assigned ·
  Shauna`, or *not imported*. If the web app cannot be reached or this browser
  is not signed in, every badge says so (*status unknown*, *sign in for status*)
  rather than showing a remembered value — a stale badge would cause a wrong
  decision silently, and an honest one costs a click.
- **Importing again is safe.** A number the web app already holds is refreshed
  (its description and unit), never doubled. One whose street changed is flagged
  *address differs* and left for a person.

Rows are chosen with **AppFolio's own row checkboxes** — the ones that drive
their header select-all and their "N Selected" counter. The extension adds no
box of its own; it reads theirs. Shift-click selects a range, which AppFolio
does not do by itself. Nothing is ever ticked for you: not every AppFolio work
order is ASH's, and there is no field that says which are. The only two things
the extension writes to the selection are finishing a shift-range you started
and clearing rows it has just imported — both by clicking the box, so AppFolio's
own counter never disagrees with what you see.

A row is read by fetching its own work-order page and parsing it
(`content/appfolio_scrape.js`), one at a time, so forty rows never become forty
parallel requests against the portal a person is working in.

## The delivery worker

**What a person sees.** The popup shows who is signed in and the *Delivery
worker* panel: a **Process ASH jobs** switch (on by default), and for each
connection this browser could work, either "ready" or what would make it ready —
"sign in to it in this browser", "paused on the web app". Those words are the
web app's own answer to the heartbeat. Jobs run in background tabs gathered into
one collapsed tab group called **ASH**, on an alarm (`ash-worker-tick`) every
minute.

**Signing in.** The device token (a year, revocable at *Your Account*) lives in
`storage.local`. Each hour it is exchanged for an **access token** kept only in
`storage.session`, so closing the browser throws it away. Signing out forgets
both in this browser only; retire the device at *Your Account* to end it on the
server too.

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
brought to a person to press.

**Adapters.** A platform's page knowledge lives in `adapters/<id>/` — a
manifest, a versioned selector file, the steps, and the page script — and the web
app can switch a version off without touching the others. Two ship:
- **`appfolio_vendor`** bills AppFolio's vendor portal. It accepts the work order,
  posts the photographs as notes of up to ten, submits the invoice and presses Work
  Done. Each is pressed once, and is looked for before it is pressed. Its page
  script is a content script on `vendor.appfolio.com`, its hooks were read off the
  live portal, and its contract is in the web app's `docs/vendor-adapter.md`,
  "The appfolio_vendor adapter". Before it types anything it re-reads the work
  order's description off the vendor page and refuses one that disagrees with the
  connection's mode.
- **`fixture`** bills a pretend portal packaged in the extension. It is only offered
  work by a connection someone made for it on purpose.

**Is this browser signed in to the vendor portal?** Any vendor page you open says
so. When that is more than four minutes old, and only while "Process ASH jobs" is
on, a background tab in the ASH group opens the portal to look, then closes.

**One browser has to stay open**, signed in to the web app and to AppFolio's
vendor portal, for work to go out without anybody pressing anything. Any number
can be — the server hands a job to one worker at a time.

**The web app's `DELIVERY_EXTENSION_VERSION` must say `4.0.0`** once this
version is loaded, or the worker API answers 426.

## Settings

- **Web app** — the address, and whether Chrome has granted permission to call it.
- **Sign in** — the worker sign-in, and once signed in, who, which device, and
  the worker's number, with **Sign out this device**.
- **Troubleshooting** — **Check the page** reads the vendor-portal tab you used
  most recently and lists which of the `appfolio_vendor` adapter's hooks it found
  (read-only, safe on a real work order). **Stop after the next press** stops
  this browser dead straight after its next press, as if Chrome had ended it,
  which is how the live kill runs are done; it ships unarmed.

## Layout

```
background/     the service worker: Settings' half of it
  service_worker.js  the address, sign-in and sign-out, the page check, install cleanup
  api.js             normalizing the address and the origin pattern to ask for
  store.js           the settings, with writes serialized; what the legacy runtime left
  notify.js          notifications
  senders.js         which pages may send the service worker which messages
worker/         the delivery worker (/api/worker/*)
  runtime.js      one tick: outbox, heartbeat, the job in hand, claims
  job.js          one job as a step machine that survives the worker dying
  client.js       the worker API, device and access tokens
  imports.js      the AppFolio import, on the same credentials
  outbox.js       results kept until the web app has them
  journal.js      a short account of recent jobs
  registry.js     the adapters this build carries
  chrome_env.js   every effect the runtime has, over chrome.*
  index.js        the alarm, the worker's messages, the wiring
adapters/       one folder per platform-and-role pair
  appfolio_vendor/  AppFolio's vendor portal: accept, notes, invoice, Work Done
  fixture/        a stand-in vendor portal packaged in the extension, for tests
content/        the property manager's AppFolio pages
  appfolio_scrape.js       shared reader, loaded first in both entries
  appfolio_list.js         badges, the Import bar, reading AppFolio's ticks
  appfolio_work_order.js   the single work-order page
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

## Tests

`node tests/run.mjs` (Node is only the place they run — there is no
package.json) or `tests/index.html` opened inside the extension, which also runs
the fixture page's DOM and Chrome's real tabs. The kill loop kills the worker
after every single storage write, request and page command of a job, and after
random pairs of them, then lets the alarm finish: no run may submit twice. The
web app's `tests/integration/extension_test.php` runs `tests/e2e.mjs` against the
real worker API, and `vendor_extension_test.php` runs `tests/e2e_vendor.mjs`:
whole vendor chains, with real photographs, killed around every press.
