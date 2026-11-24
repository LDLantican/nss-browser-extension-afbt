# Local development

Loading the extension from this folder, pointing it at a web app running on this computer, and running
the tests. There is nothing to build or install: no `package.json`, no bundler, no dependencies. Chrome
loads the files as they are, and Node only runs the tests.

## Load it

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → this folder (the one holding
   `manifest.json`).
2. After changing any file, press the extension's reload button on `chrome://extensions`. A change to a
   content script also needs the AppFolio tab reloaded.

The extension's id is assigned by Chrome per install, so it differs between machines and after a fresh
**Load unpacked** on a rebuilt laptop.

## Point it at a web app

There is no environment switch. The extension talks to whichever address is in Settings and nothing
else, so one install points at one web app at a time.

1. Open the extension → **Settings** → **Web app**.
2. Enter the address and press **Save address**. **Chrome asks permission to contact it.** That is
   expected: a typed address cannot be declared in the manifest, so it is an optional host permission
   requested at the moment of saving.

The address must be one the manifest's `optional_host_permissions` allow:

| Web app | Address |
|---|---|
| XAMPP | `http://localhost/projects/alabamasignaturehomes` |
| The web app's dev server (`php keldagrim/oracle.php server`) | `http://localhost:6789` |
| Production | `https://alabamasignaturehomes.com` (or a subdomain) |

Anything that is not this computer must be https, because every call carries a bearer token; Settings
refuses a plain `http://` address unless its host is `localhost` or `127.0.0.1`, and Chrome refuses a
host the manifest does not name. `localhost` and `127.0.0.1` match on any port. The full rules are in
[permissions-and-storage.md](../reference/permissions-and-storage.md#host-access).

**Changing the address signs this browser out**, on purpose: the device token was issued by the app you
are leaving and the new one would refuse it. The comparison is the whole address, not just the host,
because under XAMPP every project shares `http://localhost` and differs only by path. A trailing slash
is normalized away and does not count as a change.

## Sign in

**Settings** → **Sign in**, with a web app email and password. This registers the browser as a worker
(`/api/worker/register`) and keeps the device token it is given; the password is not kept. The device
appears on the web app's **Your Account** page, where it can be retired. **Sign out this device** forgets
it in this browser only.

To be offered jobs, the account needs the web app's `deliveries.deliver` permission and to be an
operator of the connection, and the browser must be signed in to the AppFolio site that connection works (the popup
says what is missing, in the web app's own words). To import, the account needs `work_orders.create`.

## The version the web app accepts

The web app accepts exactly one extension build. Every call sends the manifest's version as
`X-Extension-Version` (`env.version` in `worker/chrome_env.js`, sent by `worker/client.js`), and the web
app compares it with **`DELIVERY_EXTENSION_VERSION`** in its `.env`
(`config('integration.extension_version')`). The comparison is an exact string, not a minimum, and a
blank or missing value lets no build through.

So the web app's `.env` must say the manifest's version exactly:

```
DELIVERY_EXTENSION_VERSION=4.1.11
```

Otherwise every `/api/worker` claim gets **426 Upgrade Required**, as do lease renewals, commits,
photograph downloads, imports and import lookups; the popup shows the worker as outdated and the Import
bar cannot read its badges. Signing in, the token exchange, the heartbeat and the reports
(`complete`, `fail`, `release`) are not version-checked, so a browser on the wrong build still checks in
and can still hand back what it holds.

## Tests

### Under Node

```
node tests/run.mjs [filter]
```

Runs every `tests/**/*_test.js` except `tests/support/` and the files in `BROWSER_ONLY`, which need a
DOM or Chrome's own APIs:

- `adapters/appfolio_pm_page_test.js`
- `adapters/appfolio_vendor_page_test.js`
- `adapters/chrome_env_test.js`
- `adapters/fixture_page_test.js`

`filter` keeps only tests whose file path and name, joined by a space, contain it. Exits 0 when everything passes and 1 otherwise, and
prints a line per kill loop: how many operations a job has and how the runs ended. The worker's tests run
against a fake Chrome (`tests/support/fake_env.js`) and a fake worker API
(`tests/support/fake_server.js`); the kill loop (`tests/worker/kill_loop_test.js`) kills the worker after
every single storage write, request and page command of a job, and after random pairs of them.

### Inside the extension

Open `chrome-extension://<id>/tests/index.html` (the id is on `chrome://extensions`). It runs every file
listed in `tests/index.js`: the Node files, and the four browser-only ones:

- the pretend portals' DOM, driven by the real page scripts in an iframe (`fixture_page_test`,
  `appfolio_vendor_page_test`, `appfolio_pm_page_test`), each test with its own books;
- `chrome_env_test`: Chrome's real tabs, tab group and messaging. It opens and closes background tabs:
  a page that never answers (`tests/support/silent_page.html`), the pretend AppFolio with slowed timers,
  and a whole fixture job in a real background tab, which must not land in a collapsed group.

**Run again** reruns them. The page's title starts with ✓ or ✗.

### Against the real web app

Three scripts run the extension's own runtime and adapters under Node against the real worker API, with
only Chrome (and AppFolio) pretend. Each kills the worker around the job's presses and checks that
nothing was done twice, prints one JSON summary line, and exits 0 when every run held:

| Script | Runs | Started by the web app's |
|---|---|---|
| `tests/e2e.mjs` | the `fixture` adapter's kill loop, killed after every operation of a job, at least `--runs` (default 100) runs, then ten with the browser closed | `tests/integration/extension_test.php` |
| `tests/e2e_vendor.mjs` | whole `appfolio_vendor` chains with real photographs, killed just before and after each press, at random points, and with the browser closed; `--runs` (default 10), `--photos` (default 12) | `tests/integration/vendor_extension_test.php` |
| `tests/e2e_pm.mjs` | whole `appfolio_pm` inspection chains the same way; `--runs` (default 10), `--photos` (default 12) | `tests/integration/pm_extension_test.php` |

Their arguments (each script's header comment):

```
node tests/e2e.mjs --base=http://127.0.0.1:PORT --version=test-harness
  --email=... --password=... --connection=ID
  --php=/path/to/php --fixture=/path/to/tests/integration/fixtures/extension.php
  --root=/path/to/the/web/app [--runs=100]
```

`e2e_vendor.mjs` and `e2e_pm.mjs` take the same, with `[--runs=10] [--photos=12]`.

They are meant to be started by the web app's tests, which start a `php -S` server on the test database,
seed an operator and a connection, and pass all of the above (`--version=test-harness`, the web app's
`TestApp::EXTENSION_VERSION`). From the web app's folder:

```
php tests/run.php extension
```

The PHP tests find this repository and Node from two environment variables:

| Variable | Default |
|---|---|
| `ASH_EXTENSION_DIR` | `~/Projects/nss-browser-extension-afbt` (`USERPROFILE`, else `HOME`) |
| `NODE_BINARY` | `node` |

Either missing is a failure that says so, never a quiet pass.
