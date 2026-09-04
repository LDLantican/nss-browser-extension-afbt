# Privacy Policy

**Effective Date:** September 4, 2026
**Developer:** NSS David
**Contact:** [david@nowsoftwaresolutions.com](mailto:david@nowsoftwaresolutions.com)

> **What changed in version 2.0.** Earlier versions of this extension sent
> nothing anywhere: work orders were stored in the browser and typed into
> Buildertrend, and that was all. Version 2.0 sends work orders to the Alabama
> Signature Homes web app, at an address the person using the extension
> configures, and signs in to it. This policy has been rewritten to say so
> plainly, because the previous version's statement that no data leaves the
> browser is no longer true.

---

## 1. Overview

This browser extension was developed by **NSS David** for Alabama Signature
Homes. It does two things:

1. Sends work orders from **AppFolio** to the **Alabama Signature Homes web
   app**, so that costs can be recorded and invoices produced there.
2. Optionally enters those same work orders into **Buildertrend**, which is what
   earlier versions did on their own.

There is no third-party service involved in either. Data goes to Alabama
Signature Homes' own web app, and to Buildertrend, and nowhere else.

---

## 2. Information Collected

The developer collects nothing. There is no analytics, no telemetry, no
advertising and no tracking of any kind.

The information the extension reads and sends is:

- **Work order details already shown in your AppFolio account** — number,
  street, city, state, ZIP, and description. These are sent to the web app you
  configure, and entered into Buildertrend if that is switched on.
- **Your email address and password**, at the moment you sign in, sent once to
  the configured web app in exchange for an access token. The password is not
  stored by the extension and is not sent anywhere else or at any other time.
- **Your name, email address and permissions** as the web app reports them back,
  so the extension can show who is signed in and what they may do.
- **Your Buildertrend login status** (read-only, to confirm you are signed in
  before it tries to enter a job).

---

## 3. Where Data Is Sent

To the **Alabama Signature Homes web app**, at the address entered in the
extension's settings. Nothing is sent until that address is set, and your
browser will ask your permission before the extension may contact it.

The extension sends:

- the work orders you select, when you press Sync;
- a request asking which work orders the web app already holds, so it can show
  their status beside the AppFolio rows;
- your credentials once at sign-in, and the access token on each later request.

To **Buildertrend**, only by filling in its own new-job form in a tab, as a
person would. Nothing is sent to Buildertrend outside that page.

---

## 4. Local Data Storage

Stored in your browser's local storage (`chrome.storage.local`):

- the access token issued at sign-in, and your name, email and permissions as
  the web app reported them;
- the queue of work orders waiting to be sent or entered, and the record of what
  happened to each;
- your settings — the web app's address, and the Buildertrend values.

None of this is synced between devices or uploaded anywhere by the extension.

**Your password is never stored.**

You can remove all of it by signing out in the extension's settings, clearing
the queues in the popup, or uninstalling the extension. You can also end this
browser's access from the **Your Account** page of the web app, which is the
right thing to do if the browser is one you no longer control — it revokes the
token on the server, so it stops working even if the extension is still
installed.

---

## 5. Data Sharing

This extension does **not**:

- send data to the developer;
- send data to any third-party service, analytics provider or advertiser;
- read data from websites other than AppFolio, Buildertrend, and the web app
  address you configure.

---

## 6. Permissions Used

| Permission | Why |
| --- | --- |
| `storage` | Keep the queues, settings and access token in your browser. |
| `tabs` | Open the Buildertrend new-job page and know when it has loaded. |
| `alarms` | Retry a failed send later, after a pause. |
| `notifications` | Tell you how a sync or a Buildertrend fill went, since the popup is usually closed by then. |
| Access to AppFolio pages | Read the work orders shown on them and add the extension's own tick boxes. |
| Access to the Buildertrend new-job page | Fill in the form. |
| Access to the web app address you enter | Send work orders and sign in. Requested at the moment you save the address, and never granted in advance. |

Browsing history is not accessed. Cookies are not read; the extension's requests
to the web app deliberately carry no cookies and are authenticated by the access
token alone.

---

## 7. User Control

At any time you may:

- sign out, which revokes this browser's access token;
- end any device's access from the web app's **Your Account** page;
- remove queued work orders, or clear a queue entirely;
- switch the Buildertrend half off without affecting the web app half;
- disable or uninstall the extension.

---

## 8. Updates to This Policy

If this Privacy Policy changes, an updated version will be published with a new
effective date. Since the extension is shared as **unlisted**, users will be
informed directly by the developer if major changes occur.

---

## 9. Contact

For any privacy-related questions or concerns, contact:
📧 [david@nowsoftwaresolutions.com](mailto:david@nowsoftwaresolutions.com)
