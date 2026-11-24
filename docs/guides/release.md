# Release

How a new version of the extension is made and put to work. There is no build, no zip and no
`package.json`: a release is a version number in `manifest.json`, a commit, and the same folder loaded
on every machine.

## Make a release

1. **Bump `version` in `manifest.json`.** Semantic: the patch for a fix, the minor for something new
   (4.1.0 added the `appfolio_pm` adapter), the major for a break (4.0.0 removed the legacy runtime).
   Nothing else in the code carries the extension's version; the worker reads it from the manifest
   (`chrome.runtime.getManifest().version`).
2. **Bump each adapter whose behaviour changed** ([Adapter versions](#adapter-versions)), and check the
   operation flags still match the web app's ([below](#operation-flags-match-the-web-app)).
3. **Run the tests**: `node tests/run.mjs`, and the test page inside the extension
   ([local-development.md](local-development.md#tests)). A change to an adapter's steps or to the worker
   also runs the web app's end-to-end test for it.
4. **Commit as `X.Y.Z: summary`**, the version first and then what changed in plain words, for
   example `4.1.11: never collapse the ASH tab group; Chrome freezes a collapsed group's tabs`. A
   version that took more than one commit repeats the prefix (`4.1.9` has two).
5. **Update the docs** in this repository and the version in the [docs index](../README.md)'s Status
   line.

## Put it to work

The web app accepts exactly one build: its `.env` key `DELIVERY_EXTENSION_VERSION` names it, compared
exactly with the `X-Extension-Version` every call sends. The order is the one written beside that key
in the web app's `config/integration.php`: **bump the manifest, reload the extension on every machine,
then change `DELIVERY_EXTENSION_VERSION`.**

1. On every machine that runs the extension, pull this repository and press reload on
   `chrome://extensions` (or **Load unpacked** on a new machine, then Settings' address and sign-in:
   [local-development.md](local-development.md#point-it-at-a-web-app)).
2. Set the web app's `.env` line to the new version, exactly as the manifest says it:

   ```
   DELIVERY_EXTENSION_VERSION=4.1.11
   ```

Between the two steps the reloaded browsers are refused with 426 on claims, renewals, commits,
photographs and imports, and stop working until the line changes; nothing is lost, because a job in hand
is given back or reported, and reports are not version-checked. A browser left on the old build after
the line changes is refused the same way, and its popup says the extension is outdated. Changing `.env`
on the server is the owner's step (the web app's `docs/guides/deployment.md`).

## Adapter versions

Each adapter's version is in its `adapters/<id>/manifest.js`, and it is what the web app's kill switch
names. The header of every `selectors.v1.js` says the rule: it is the only file that knows the pages'
structure, so **any change to an adapter's `selectors.v1.js` bumps that adapter's version**. In practice
a release that changes an adapter's steps (`adapter.js`) or its page scripts (`page.js`,
`page_bridge.js`) bumps it too: `appfolio_pm` went from 1.0.0 to 1.0.8 across 4.1.1 to 4.1.9. A
behaviour change under an unchanged version could not be switched off without also switching off the
version before it.

Record why in the manifest when it is not obvious, as `appfolio_vendor`'s does
(`1.0.0 ran the first live rung …; 1.2.0 reads the number of an invoice made with the form`). A change to
a pretend portal under `site/` alone does not bump the adapter.

## Operation flags match the web app

Every operation in an adapter's `manifest.js` carries `idempotent`, `verifiable` and
`negative_verify_trusted`, and they must equal the web app's `platform_operations` rows, which come from
its seed migrations in `alabamasignaturehomes/database/migrations/main/`:

| Adapter | Seed migration | Operations |
|---|---|---|
| `appfolio_vendor` | `20261008210218357_seed_integration_platforms.sql` | `accept` (1, 1, 1), `post_photos` (0, 1, 1), `submit_invoice` (0, 1, 0), `mark_work_done` (1, 1, 1) |
| `appfolio_pm` | `20261020114826788_seed_inspection_delivery_chain.sql` | `create` (0, 1, 1), `fill_areas` (1, 1, 1), `post_photos` (0, 1, 1), `mark_done` (1, 1, 1) |

The figures are (`idempotent`, `verifiable`, `negative_verify_trusted`). The `create` row is first
inserted by the integration seed with `negative_verify_trusted` 0, and the inspection seed's `UPDATE`
sets it to 1. The `fixture` adapter has no seed row of its own: it copies the vendor portal's `accept`
and `submit_invoice` flags so it exercises the same rules.

The web app decides from its rows, and the adapter's are what the extension was written against, so a
change to either is a change to both: a new forward-only migration in the web app and the manifest here,
in the same release.

## The kill switch

An adapter version can be switched off on the web app without a new extension release. On a connection's
page at `/integrations/connections` (permission `connections.manage`), **Kill a version** takes a
version of that connection's adapter and a reason, and writes an `adapter_versions` row with status
`killed`. From then on, every browser reporting that version in its heartbeat is offered nothing on any
connection using that adapter, and a commit already asked for is refused with `adapter_killed`, so the
job in hand is given back untouched. Other adapters, and other versions of the same one, keep working.

The extension-wide floor is `DELIVERY_EXTENSION_VERSION`, above: changing it stops every build but one.
A connection can also demand a minimum adapter version (`adapter_min_version`), which the popup reports
as "too old".
