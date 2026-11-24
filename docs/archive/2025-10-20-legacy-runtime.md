# The legacy runtime (before 4.0.0)

> **Historical record.** The extension's first runtime, from the first commit (`2f302c2`, "init",
> 2025-10-20) to 3.3.0. 4.0.0 (`f0103ea`, 2026-10-20) removed it. Nothing here describes how the
> extension works today: for that, see the [docs index](../README.md).

## What it was

Before the web app's re-architecture, the extension took work orders out of the property manager's
AppFolio and put them into two places: the ASH web app and **Buildertrend**. A **Sync** button on
AppFolio's work-order list sent the ticked rows to the web app first and then created a Buildertrend job
for each, one at a time, in one tab; a later leg built Buildertrend estimates. It signed in to the web
app with a separate session token at **`/api/session`**, kept its queues (the sync ledger, the
Buildertrend queue, pending links, run reports) and tab-error reports with screenshots in
`storage.local`, and drained a legacy delivery queue on its own alarms (`nss-delivery-drain`,
`nss-sync-retry`).

From 3.0.0 (`07587b5`, 2026-10-15) the delivery worker ran beside it, with its own credentials, alarm
and tabs. 3.1.0 (`7e76b78`) replaced the Sync button with Import on AppFolio's pages, leaving the Buildertrend
queue and its runner in place, 3.2.0 (`d100a26`) added the `appfolio_vendor`
adapter, and 3.3.0 (`e0cfd03`) picked the import's connection by the page's host and company. 4.0.0
deleted the rest: 40 files changed, about 13,000 lines removed, including `background/buildertrend.js`,
`background/delivery.js`, `background/estimates.js`, `background/sync.js`, `background/auth.js`,
`background/tab_errors.js`, `content/appfolio_vendor_invoice.js`, the three `content/buildertrend_*.js`
scripts and `content/tab_guard.js`. The web app removed its side in the same phase (its roadmap phase 11),
and the owner dropped Buildertrend on 2026-10-15.

The code is intact in git history: `git show f0103ea^:README.md` is the README as it stood at 3.3.0, and
`git ls-tree -r --name-only f0103ea^` lists its files.

## What the README said, word for word

*From `README.md` as it stood on 2026-11-24, before the docs were moved into `docs/`.*

**4.0.0 removed the legacy runtime.** Sync, the legacy delivery drain, the
Buildertrend leg (jobs and estimates), the tab-error reports and the session
sign-in at `/api/session` are gone, along with the web app endpoints they
called. An upgraded browser forgets what that runtime stored the first time
4.0.0 starts, keeping only the web app's address, and has to be signed in once
more if it never signed in as a worker.

What it stored, and what removes it on every install and update, is in
[permissions-and-storage.md](../reference/permissions-and-storage.md#what-install-and-update-clear).
