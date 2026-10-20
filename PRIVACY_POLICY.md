# Privacy Policy

**Effective Date:** October 20, 2026
**Developer:** NSS David
**Contact:** [david@nowsoftwaresolutions.com](mailto:david@nowsoftwaresolutions.com)

> **What changed in version 4.0.** The extension no longer enters anything into
> Buildertrend, no longer keeps a queue of work orders or reports of failed
> tabs (with screenshots and page copies) in the browser, and no longer signs in
> to the web app with a separate session. It signs in once, as a delivery worker,
> and does two things: imports the AppFolio work orders you choose into the
> Alabama Signature Homes web app, and bills approved work back in AppFolio's
> vendor portal. On updating, it deletes what earlier versions stored, except the
> web app's address.

> **What changed in version 4.1.** The extension can also put an inspection
> Alabama Signature Homes approved into the property manager's AppFolio — the
> inspection's name, date, property, areas, items, notes and photographs — on
> the web app's behalf, in a background tab, as a person would.

---

## 1. Overview

This browser extension was developed by **NSS David** for Alabama Signature
Homes. It does two things:

1. **Imports** work orders you select on **AppFolio**'s work-order pages into the
   **Alabama Signature Homes web app**.
2. **Bills approved work** in **AppFolio's vendor portal**, on the web app's
   behalf: it accepts the work order, posts its photographs as notes, submits the
   invoice and marks the work done, in a background tab, as a person would.
3. **Puts approved inspections into AppFolio**, as the property manager, on the
   web app's behalf: it creates the inspection, fills in its areas and items,
   attaches its photographs and marks it done, in a background tab.

There is no third-party service involved in either. Data goes between AppFolio
and Alabama Signature Homes' own web app, and nowhere else.

---

## 2. Information Collected

The developer collects nothing. There is no analytics, no telemetry, no
advertising and no tracking of any kind.

The information the extension reads and sends is:

- **Work order details already shown in your AppFolio account** — number,
  street, unit, city, state, ZIP, description, and AppFolio's own id and address
  for the work order — for the work orders you tick and import, along with the
  name of the company the AppFolio page shows, so the web app can check it is the
  right one. These are sent to the web app you configure.
- **Your email address and password**, at the moment you sign in, sent once to
  the configured web app in exchange for a device token. The password is not
  stored by the extension and is not sent anywhere else or at any other time.
- **Your name and email address** as the web app reports them back, so the
  extension can show who is signed in.
- **Approved work from the web app** — the invoice figures, notes and
  photographs for a job this browser has been handed — which is typed into or
  uploaded to AppFolio's vendor portal, and nowhere else.
- **Whether this browser is signed in to AppFolio's vendor portal**, and the
  vendor account number the portal shows, reported to the web app so it only
  hands this browser work it can do.
- **What happened on each vendor-portal step** — whether a step succeeded, and
  the invoice or note it produced — reported back to the web app.
- **Approved inspections from the web app** — the inspection's name, date and
  property, its areas and items with their answers and notes, and its
  photographs — typed into or uploaded to the property manager's AppFolio, and
  nowhere else; and AppFolio's id and address for the inspection it created,
  reported back to the web app.
- **Whether this browser is signed in to the property manager's AppFolio**,
  reported to the web app, as for the vendor portal.

---

## 3. Where Data Is Sent

To the **Alabama Signature Homes web app**, at the address entered in the
extension's settings. Nothing is sent until that address is set, and your
browser will ask your permission before the extension may contact it.

The extension sends:

- the work orders you select, when you press Import;
- a request asking which work orders the web app already holds, so it can show
  their status beside the AppFolio rows;
- your credentials once at sign-in; a device token once an hour to obtain a
  short-lived access token; and the access token on each later request;
- once a minute, a check-in saying whether this browser is processing jobs, which
  extension and adapter versions it runs, and whether it is signed in to the
  vendor portal; and the results of the jobs it works.

To **AppFolio's vendor portal**, only by using the portal's own pages in a tab,
as a person would. Nothing is sent to AppFolio outside those pages.

---

## 4. Local Data Storage

Stored in your browser's local storage (`chrome.storage.local`):

- the web app's address;
- the device token issued at sign-in, the device's name, and your name and email
  as the web app reported them;
- the delivery worker's state: whether processing is switched on, the web app's
  last answer about the connections this browser may work, results not yet
  delivered to the web app, and a short list of recent jobs;
- whether this browser was last seen signed in to the vendor portal.

Stored in session storage (`chrome.storage.session`), which the browser discards
when it closes: the hourly access token, the job in hand, and which tabs the
extension opened for it.

None of this is synced between devices or uploaded anywhere by the extension.

**Your password is never stored.**

You can remove all of it by signing out in the extension's settings or
uninstalling the extension. You can also retire this browser from the **Your
Account** page of the web app, which is the right thing to do if the browser is
one you no longer control — it ends the device token on the server, so it stops
working even if the extension is still installed.

---

## 5. Data Sharing

This extension does **not**:

- send data to the developer;
- send data to any third-party service, analytics provider or advertiser;
- read data from websites other than AppFolio and the web app address you
  configure.

---

## 6. Permissions Used

| Permission | Why |
| --- | --- |
| `storage` | Keep the settings, the device token and the delivery worker's state in your browser. |
| `tabs` | Open a vendor-portal tab for a job, know when it has loaded, and close it afterwards. |
| `tabGroups` | Gather the tabs it opens into one collapsed group named ASH. |
| `alarms` | Check for approved work once a minute, which survives the extension's background worker being stopped. |
| `notifications` | Tell you when a job is waiting for you to press something, since the popup is usually closed. |
| Access to AppFolio work-order pages | Read the work orders shown on them, add status badges and the Import bar. |
| Access to AppFolio's vendor portal | Work approved jobs there, and notice whether you are signed in. |
| Access to the web app address you enter | Sign in, import work orders and work the delivery queue. Requested at the moment you save the address, and never granted in advance. |

Browsing history is not accessed. Cookies are not read; the extension's requests
to the web app deliberately carry no cookies and are authenticated by its tokens
alone.

---

## 7. User Control

At any time you may:

- sign out, which forgets this browser's tokens;
- retire any device from the web app's **Your Account** page;
- switch **Process ASH jobs** off in the popup, so this browser works no jobs;
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
