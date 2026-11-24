# NSS Appfolio Helper: documentation

NSS Appfolio Helper is a Chrome extension for Alabama Signature Homes' office (repo
`nss-browser-extension-afbt`). It is the browser half of the ASH web app (repo `alabamasignaturehomes`),
and does three things through one sign-in: **imports** the AppFolio work orders a person ticks into the
web app, **delivers** approved work by billing it in AppFolio's vendor portal, and puts approved
**inspections** into the property manager's AppFolio. Every call to the web app goes through its worker
API, `/api/worker/*`.

**Status:** version 4.1.11, on the `refactor` branch, loaded on the owner's laptop and accepted live for
inspections on 2026-11-24; it reaches staff browsers when the web app's refactor ships. Project status:
`alabamasignaturehomes/docs/status.md`.

## I want to…

| I want to… | Read |
|---|---|
| Load it, point it at a local web app, run the tests | [local-development.md](guides/local-development.md) |
| Release a new version | [release.md](guides/release.md) |
| Switch an adapter version off | [release.md](guides/release.md#the-kill-switch) |
| Look up what an adapter does, or the adapter contract | [adapters.md](reference/adapters.md) |
| Know why it asks for a permission, or what it stores | [permissions-and-storage.md](reference/permissions-and-storage.md) |
| See how the code is laid out and how a job survives a crash | [architecture.md](background/architecture.md) |
| Look up the worker API it calls | the web app's `docs/reference/worker-api.md` |
| Know why something was decided | the web app's `docs/decisions.md` and `docs/decisions/ADR-*.md` (ADR-004, ADR-007, ADR-008, ADR-014) |
| See what happened before | [archive/README.md](archive/README.md) |
| Read the privacy policy | [PRIVACY_POLICY.md](../PRIVACY_POLICY.md) |

## Index

**Guides** (do a task)

| Doc | What it covers |
|---|---|
| [local-development.md](guides/local-development.md) | Load unpacked, the web app's address, signing in, `DELIVERY_EXTENSION_VERSION`, the Node tests, the test page and the end-to-end tests |
| [release.md](guides/release.md) | Making a release, putting it to work, adapter versions, operation flags, the kill switch |

**Reference** (look something up)

| Doc | What it covers |
|---|---|
| [adapters.md](reference/adapters.md) | The three adapters and their versions, the adapter contract, the pretend portals, versions in the heartbeat |
| [permissions-and-storage.md](reference/permissions-and-storage.md) | Every permission and content script and why, every `chrome.storage` key, what sign-out and install clear |

**Background** (how it works and why)

| Doc | What it covers |
|---|---|
| [architecture.md](background/architecture.md) | Layout, where the network calls are, messages, importing, the delivery worker: one tick, tokens, the step machine, the ASH tab group, silent pages, sign-in probes, Settings, install clean-up |

**Decisions:** none here. They are the web app's: `alabamasignaturehomes/docs/decisions.md` and
`alabamasignaturehomes/docs/decisions/ADR-*.md`.

**Archive** (finished, dated; see [archive/README.md](archive/README.md))

| Doc | What it covers |
|---|---|
| [2025-10-20-legacy-runtime.md](archive/2025-10-20-legacy-runtime.md) | The runtime before 4.0.0: Sync, Buildertrend and the `/api/session` sign-in |

## Rules for working in this repo

- **Zero dependencies and no build step.** No `package.json`, no bundler, no framework: Chrome loads the
  files as they are, and Node only runs the tests.
- **Every effect goes through `env`.** `worker/runtime.js`, `worker/job.js` and the adapters never touch
  `chrome.*` themselves; `worker/chrome_env.js` is Chrome's `env` and `tests/support/fake_env.js` the
  tests'. That is what lets the kill loop kill the worker anywhere.
- **Every call to the web app is made by the service worker**, never by a content script
  ([architecture.md](background/architecture.md#where-the-network-calls-are)).
- **One commit step per plan, and it is never repeated.** A press is sent to the page once, after the web
  app's `commit`, with its phase written first ([architecture.md](background/architecture.md#the-step-machine)).
- **Nothing is computed here.** Every figure is the web app's; an adapter types what it is handed and
  checks the page's arithmetic against it.
- **A change to an adapter's `selectors.v1.js` bumps that adapter's version**, and its operation flags
  stay equal to the web app's seed migrations ([release.md](guides/release.md)).
- **A new message type** from a content script is added to `PAGE_MESSAGES` in `worker/index.js` with the
  hosts it may come from; anything else is answered for the extension's own pages only.
- The web app's `DELIVERY_EXTENSION_VERSION` must equal `manifest.json`'s version exactly, or the worker
  API answers 426 ([local-development.md](guides/local-development.md#the-version-the-web-app-accepts)).
- Run `node tests/run.mjs` and the test page after any change.

## Keeping these docs current

- **One folder per kind:** `guides/` (do a task), `reference/` (look something up), `background/` (how it
  works and why). Only this README sits at the top of `docs/`; decisions live in the web app
  (`alabamasignaturehomes/docs/decisions.md` and `alabamasignaturehomes/docs/decisions/ADR-*.md`).
- **Finished one-offs** move to `archive/`, named `YYYY-MM-DD-<what>.md` (the date the work started),
  with a "Historical record" banner under the title and a row in [archive/README.md](archive/README.md).
- **Describe what is true**, without "now", "currently", "planned" or "will"; dates belong in the archive
  and in commit messages.
- **Never cite plan files** (`…\.claude-nss\plans\…`): Claude Code deletes them after 30 days. Put
  decisions in the web app's decisions files.
- Every new doc gets a line in the index above, and the Status line names `manifest.json`'s version.
- Links between docs here are relative Markdown links, and must resolve, anchors included. Docs in the
  web app are named by their repo path in backticks, not linked.
- **Never delete history:** move it to the archive, and ask the owner before removing anything.
- **Checked automatically:** `php tests/docs_check.php` in the `alabamasignaturehomes` repo checks these
  docs too: folders, archive dates and banners, the index, plan-file citations, and the Status line's
  version against `manifest.json`. Run it after any doc change.
