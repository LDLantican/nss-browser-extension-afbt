# Adapters

An adapter is one platform-and-role pair: everything the extension knows about one kind of page, and the
steps it takes there. The web app names which adapter works a connection
(`platform_connections.adapter`). This build carries three, listed in `worker/registry.js`:

| Adapter | Version | Works | Operations |
|---|---|---|---|
| `appfolio_vendor` | 1.2.0 | AppFolio's vendor portal, `vendor.appfolio.com`, where ASH bills as the vendor | `accept`, `post_photos`, `submit_invoice`, `mark_work_done` |
| `appfolio_pm` | 1.0.8 | The property manager's AppFolio (`<company>.appfolio.com`), its inspection pages | `create`, `fill_areas`, `post_photos`, `mark_done` |
| `fixture` | 1.0.0 | A pretend vendor portal packaged in the extension, for tests | `accept`, `submit_invoice` |

The versions are each adapter's `manifest.js`. The portal-side detail, the hooks read off the live pages
and the rules that refuse, are the web app's `docs/reference/vendor-adapter.md` and
`docs/reference/pm-adapter.md`; the API they talk to is its `docs/reference/worker-api.md`. The
contract was decided in the web app's `docs/decisions/ADR-008-adapter-contract.md`.

## `appfolio_vendor`

Bills approved work in AppFolio's vendor portal. The web app queues a chain on Approve, one delivery per
operation, and the adapter works each in a background tab:

- **accept**: accept the dispatched work order.
- **post_photos**: post the job's photographs as notes, up to ten per note. Each is pressed once, and
  is looked for before it is pressed.
- **submit_invoice**: type the invoice lines exactly as the web app handed them over, check the page's
  own Amounts and Total against `expected_total_cents` to the cent, and submit. Nothing is computed in
  the extension. An invoice over the property's maintenance limit is held unless the connection says
  `send`.
- **mark_work_done**: press Work Done.

Every plan runs `locate` (find the work order by its URL or by number on the list, and check it is the
right one, signed in and still open), `find_existing` (what an earlier attempt may already have done),
`prepare` or `fill`, the one commit step, then `capture` (read back what the press produced). Before it
types anything it re-reads the work order's description off the live vendor page and refuses one that
disagrees with the connection's mode (test work orders carry `This is a test work order approved by
Dustin.`). A settled or Estimates work order is not billed.

Identity is the vendor portal's URL id (`/{account}/workOrders/{id}`); nothing ASH-made is written into
AppFolio, so a work order is found again by its number. Its page script is a content script on
`vendor.appfolio.com`, and it reports this browser's sign-in to the worker whenever a vendor page loads.

## `appfolio_pm`

Puts an inspection ASH approved into the property manager's AppFolio, so the office can press AppFolio's
own Create Work Order(s) on its flags:

- **create**: search the inspection list, narrowed to the property, for ASH's number before creating
  anything; otherwise fill the New Inspection form on AppFolio's default layout and press Start
  Inspection. The name always carries ASH's number (`<name> · INS-000045`), and ends ` · TEST` for a
  test inspection.
- **fill_areas**: make AppFolio's areas and items ASH's: an area or item added on site is added, a
  default one ASH removed is removed (only while blank), and every item gets ASH's OK or Follow-up and
  its note. Its commit step is a loop: read the sheet, do the next thing that differs, read again.
- **post_photos**: one item's photographs, attached and saved, counted before and after so a second
  upload is never made.
- **mark_done**: Mark Inspection Done.

Identity is AppFolio's inspection id, from `/inspections/{id}`. The connection's `external_host` says
which AppFolio to work in. Its page scripts run on that AppFolio's inspection pages and never on the
vendor portal: `page.js` in the extension's isolated world, and `page_bridge.js` in the page's own
JavaScript world, at `document_start`, which drives the address box's select2 through its own API,
reads the address a list row would open without opening it (a script's `window.open` in a background
tab is blocked), and counts the page's own writes so `page.js` waits until AppFolio has stored each
press. With no bridge, a list row is opened in a new tab, which the worker finds by its opener, reads
and closes (`tab_children`).

## `fixture`

Bills a pretend vendor portal packaged in the extension (`adapters/fixture/site/`), so nothing it does
can reach a real platform. Its operations carry the same flags as the vendor portal's `accept` and
`submit_invoice`, because its purpose is to exercise the same rules. The web app offers it work only on
a connection whose `adapter` is `fixture`, which nothing seeds: such a connection exists only where
somebody made one on purpose, in a test or development database. Its `session()` reads the pretend
site's books and never opens a tab.

## The contract

Every adapter's default export (`worker/registry.js`):

| Member | What it is |
|---|---|
| `id`, `version` | the pair the web app's kill switch names (from `manifest.js`) |
| `identity` | what it can capture or search by: `native_id`, `number`, `url`, `reference_tag`, `search_by_tag`, `search_by_number` |
| `operations` | per operation: `entity`, `commit_step`, and the `idempotent`, `verifiable` and `negative_verify_trusted` flags, which must equal the web app's ([release.md](../guides/release.md#operation-flags-match-the-web-app)) |
| `session(env, connection, { processing })` | `{ state: live \| expired \| unknown, account_hint }` for the heartbeat |
| `session_lost(env)` | optional: a job found this browser signed out; forget a cached `live` |
| `plan(job)` | the execute steps, exactly one with `commit: true` |
| `verify_plan(job)` | the steps of a verification, reads only; a commit step in one is reported `adapter_broken` |
| `parse_url(url)` | the identity a URL names, or null |

A step is `{ name, run(ctx) }`, or for the commit step `{ name, commit: true, act(ctx), await_person(ctx) }`:
`act` presses the button itself (the connection's `auto_submit` is `true`), and `await_person` brings the
tab to a person and waits for them to press. `run` may return `data` to keep on the job, `already_done`
(believed only before the commit request), or in a verification a `verdict` of `found` or `absent`.
`ctx` gives the job, `open(url)`, `ask(command, args, options)` (one command to the page script),
`tab_url()`, `tab_children()`, `url_of()`, `close_tab()`, `photo(file_id)` (a photograph's bytes from the
web app, for the holder of a `post_photos` claim only), `reveal(message)`, `touch(step)`, `sleep()` and
`now()`. `worker/job.js` says what each outcome leads to, and
[architecture.md](../background/architecture.md#the-step-machine) explains the phases around the commit
step.

An adapter throws `AdapterError` with one of the worker API's error classes (`transient`, `permanent`,
`permission`, `session_expired`, `adapter_broken`, `unknown_outcome`, `verified_absent`;
`worker/errors.js`). Anything else it throws is a bug in the adapter, reported `adapter_broken` before
the commit point and `unknown_outcome` after it.

The list is static on purpose. An adapter is code, and code arrives with an extension update, never from
the network.

## Files in an adapter's folder

| File | Holds |
|---|---|
| `manifest.js` | the declarations above |
| `selectors.v1.js` | everything the adapter knows about the pages' structure, and the only file that does. A change to it bumps the adapter's version ([release.md](../guides/release.md#adapter-versions)) |
| `adapter.js` | the service-worker half: `session`, the plans, the verification plans |
| `page.js` | the page half: answers one `ASH_PAGE_COMMAND` at a time. For the two AppFolio adapters it is a classic content script, reading `globalThis.ash_vendor.SELECTORS` or `globalThis.ash_pm.SELECTORS` set by `selectors.v1.js`, listed before it, because content scripts cannot `import` |
| `site/` | the pretend portal (below) |

## The pretend portals

There is no AppFolio sandbox, so each adapter ships a pretend copy of its site **inside the extension**,
under `adapters/<id>/site/`, served as an extension page (`chrome-extension://<id>/adapters/...`):

| Adapter | Page | Books |
|---|---|---|
| `fixture` | `site/work_order.html` | `site/ledger.js`, stored under `fixture_site` |
| `appfolio_vendor` | `site/portal.html` | `site/portal.js`, stored under `appfolio_vendor_fixture` |
| `appfolio_pm` | `site/portal.html` (also loads `timers.js` to slow its timers as a hidden tab's are, and `network.js` to answer its saves after a delay) | `site/books.js`, stored under `appfolio_pm_fixture` |

Each page loads the adapter's real `selectors.v1.js` and `page.js` (and for `appfolio_pm`,
`page_bridge.js`), told apart from the live site by its `?frame=` and reading its route from the hash,
since an extension page cannot have AppFolio's paths. The books are plain data and pure functions, so
the same books back the pretend pages in Chrome and the fakes under Node (`tests/support/fake_page.js`,
`fake_vendor.js`, `fake_pm.js`). Every accept, note, submit, upload, create and Done is **counted,
duplicates included**, and nothing refuses a second one, because refusing would hide the bug the tests
exist to catch. A test opens a page with `?store=<key>` so its books never touch anybody else's.

The `fixture` adapter's jobs run on its pretend page in Chrome; the other two pretend portals are what
the extension's test page and the end-to-end tests drive
([local-development.md](../guides/local-development.md#tests)).

## Versions in the heartbeat

Every heartbeat reports `adapter_versions`, every adapter this build carries with its version
(`registry.versions()`), beside `extension_version`. The web app offers a connection's jobs only to a
browser that runs the connection's adapter at a version nobody has killed and that meets the
connection's minimum (`adapter_min_version`); otherwise the popup shows "This version of the extension
has been switched off for it" or "is too old for it". A job already in hand when its version is killed
has its commit refused (`adapter_killed`) and is given back untouched. Killing a version is in
[release.md](../guides/release.md#the-kill-switch).
