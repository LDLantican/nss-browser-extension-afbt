# Permissions and storage

What `manifest.json` asks Chrome for and why, and every key the extension keeps in `chrome.storage`. The
user-facing account of the same is the root [PRIVACY_POLICY.md](../../PRIVACY_POLICY.md), which must
agree with this page.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The settings, the device token and the delivery worker's state ([Storage](#storage)). |
| `tabs` | Open a background tab for a job or a sign-in probe, wait for it to load, read its address (a redirect to a sign-in page shows there first), navigate it, close it; find the tabs a job's page opened by reading open tabs' opener and address (`tabs.children`); bring a tab to the front for a person; send commands to a page script (`tabs.sendMessage`); and, for Settings' **Check the page**, find the AppFolio tab used most recently. |
| `tabGroups` | Gather the worker's tabs into one group named ASH, and keep it open: Chrome freezes a collapsed group's tabs ([architecture.md](../background/architecture.md#the-ash-tab-group)). |
| `alarms` | `ash-worker-tick` every minute, the only timer that survives the service worker being ended. |
| `notifications` | Tell a person a job is waiting for them to press something, since the popup is usually closed. One id (`nss-status`), so a second replaces the first. |

## Host access

**The web app** is an optional host permission, because a person types its address:

```json
"optional_host_permissions": [
  "https://alabamasignaturehomes.com/*",
  "https://*.alabamasignaturehomes.com/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]
```

Settings requests the one origin typed (`chrome.permissions.request`, from the Save button's click), and
Chrome refuses anything outside these patterns. So the web app can only be at
`alabamasignaturehomes.com` or one of its subdomains over https, or on this computer at `localhost` or
`127.0.0.1` over http. A web app on another domain needs a manifest change and a new version. Nothing is
granted in advance.

**AppFolio** is reached only by content scripts, which are declared, not requested:

| Matches | Scripts | Runs | Why |
|---|---|---|---|
| `https://*.appfolio.com/maintenance/service_requests/work_orders*` | `content/appfolio_scrape.js`, `content/appfolio_list.js`, `content/appfolio.css` | `document_idle` | The work-order list: badges and the Import bar. |
| `https://*.appfolio.com/maintenance/service_requests/*/work_orders/*` | `content/appfolio_scrape.js`, `content/appfolio_work_order.js`, `content/appfolio.css` | `document_idle` | A single work order: its badge and Import button. |
| `https://vendor.appfolio.com/*` | `adapters/appfolio_vendor/selectors.v1.js`, `adapters/appfolio_vendor/page.js` | `document_idle` | The vendor adapter's page script: works jobs, and reports whether this browser is signed in. |
| `https://*.appfolio.com/inspections/*`, `https://*.appfolio.com/maintenance/inspections*`, excluding `vendor.appfolio.com` | `adapters/appfolio_pm/selectors.v1.js`, `adapters/appfolio_pm/page.js` | `document_idle` | The property manager's inspection pages: the `appfolio_pm` adapter's page script. |
| the same, excluding `vendor.appfolio.com` | `adapters/appfolio_pm/page_bridge.js` | `document_start`, `"world": "MAIN"` | Runs in the page's own JavaScript world, where AppFolio's jQuery and `window.open` are: drives the select2 address box, reads the address a list row would open, and counts the page's own writes. `document_start` so it is in place before AppFolio's scripts keep a `fetch` of their own. |

The content scripts on the work-order pages fetch each ticked row's own AppFolio page, same-origin, with
the person's AppFolio session; no host permission is needed for that.

## Storage

Nothing uses `chrome.storage.sync`, and nothing is uploaded except what the worker API is sent.

### `chrome.storage.local`

| Key | Written by | Holds |
|---|---|---|
| `settings` | `background/store.js` | `{ app_url }`: the web app's address, the only setting |
| `ash_worker_identity` | `worker/client.js` | the worker sign-in: the address it belongs to, `worker_id`, `worker_uuid`, `device_name`, `device_token`, `user` (`id`, `name`, `email`), `registered_ms` |
| `ash_worker_processing` | `worker/runtime.js` | the **Process ASH jobs** switch; absent means on |
| `ash_worker_connections` | `worker/runtime.js` | the connections the last heartbeat named: `slug`, `adapter`, `enabled`, `reason`, `external_host` |
| `ash_worker_status` | `worker/runtime.js` | the last tick's account of itself, for the popup |
| `ash_worker_outbox` | `worker/outbox.js` | reports not yet answered by the web app |
| `ash_worker_journal` | `worker/journal.js` | the last 30 jobs' outcomes, for the popup |
| `ash_worker_rehearsed` | `worker/job.js` | per delivery, the payload hash rehearsed in dry run (the last 500) |
| `ash_worker_stop_after_press` | `worker/index.js`, `worker/job.js` | Troubleshooting's armed "stop after the next press"; absent means never |
| `ash_vendor_session` | `adapters/appfolio_vendor/adapter.js`, `worker/index.js` | whether this browser was last seen signed in to the vendor portal, the account number, when |
| `ash_pm_session` | `adapters/appfolio_pm/adapter.js` | the same for the property manager's AppFolio, with its host |
| `fixture_site`, `appfolio_vendor_fixture`, `appfolio_pm_fixture` | `adapters/*/site/site.js` | the pretend portals' books, written only when one of those pages is opened (by a `fixture` job or the test page) |
| `fixture_test_<uuid>`, `vendor_test_<uuid>`, `pm_test_<uuid>`, `pm_env_<uuid>` | the test page (`tests/adapters/*`) | one test's books, removed when that test ends |

### `chrome.storage.session`

Discarded when the browser closes.

| Key | Written by | Holds |
|---|---|---|
| `ash_worker_access` | `worker/client.js` | the hourly access token, with its address, worker and expiry |
| `ash_worker_job` | `worker/job.js` | the job in hand: the claim, its step cursor, its commit phase, its tab, its report |
| `ash_worker_tabs` | `worker/chrome_env.js` | ids of the tabs the worker opened, so a dead worker's tabs are closed at the next tick |
| `ash_worker_group` | `worker/chrome_env.js` | the id of the ASH tab group |

### What sign-out clears

**Sign out this device** in Settings (and changing the web app's address, which signs out) runs
`sign_out()` in `worker/runtime.js` and `forget()` in `worker/client.js`. It closes the job's tab and
removes:

- from `storage.local`: `ash_worker_identity`, `ash_worker_outbox`, `ash_worker_connections`,
  `ash_worker_status`;
- from `storage.session`: `ash_worker_job`, `ash_worker_access`.

It is local only: the worker API has no way for a device to retire itself, so the person retires the
device on the web app's **Your Account** page to end it on the server too. A job in hand is dropped; its
lease runs out and the web app's reaper reschedules or verifies it. A device token the web app refuses
(retired, or the account switched off) is forgotten the same way as `forget()`: identity and access token
only.

Everything else stays until the extension is removed: `settings`, `ash_worker_processing`,
`ash_worker_journal`, `ash_worker_rehearsed`, `ash_worker_stop_after_press`, `ash_vendor_session`,
`ash_pm_session` and the pretend portals' books in `storage.local`, and `ash_worker_tabs` and
`ash_worker_group` in `storage.session` until the browser closes. Uninstalling the extension removes all
of it.

### What install and update clear

Every install and update runs `remove_legacy()` (`background/store.js`), which removes what the legacy
runtime (before 4.0.0) stored and keeps `settings.app_url`:

- `storage.local`: `auth`, `sync_jobs`, `bt_queue`, `bt_pending_links`, `bt_last_run`,
  `bt_last_estimate_run`, `delivery_status`, `tab_errors`, `tab_errors_seen_at`, `work_orders`,
  `bt_unrecorded`;
- `storage.session`: `nss_awaiting_submit_url`, `nss_sign_in_tabs`, `nss_owned_tabs`,
  `nss_outdated_notice`;
- from `settings`: `buildertrend_enabled`, `bt_auto_estimates`, `client`, `job_type`, `job_group`,
  `bt_client_name`, `bt_client_row_id`, `bt_cost_code`.
