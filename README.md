# NSS Appfolio Helper

A Chrome extension for Alabama Signature Homes' office, and the browser half of the ASH web app. It does
three things, all through one sign-in:

- **Import.** On the property manager's AppFolio work-order pages, the work orders a person ticks are
  imported into the web app's work-order system.
- **Deliver.** As a delivery worker, it bills approved work back in AppFolio's vendor portal (accepts
  the work order, posts the photographs, submits the invoice, presses Work Done) by itself, every
  minute, while the browser is open.
- **Inspections.** As the same worker, it puts an inspection ASH approved into the property manager's
  AppFolio: creates it, fills in its areas and items, attaches the photographs and marks it done.

Version **4.1.11**.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → this folder. Then open the extension's
**Settings**, enter the web app's address (Chrome asks permission to contact it), and sign in with a web
app email and password. There is no build step and nothing to install.

**Docs:** [docs/README.md](docs/README.md). The privacy policy is [PRIVACY_POLICY.md](PRIVACY_POLICY.md).
