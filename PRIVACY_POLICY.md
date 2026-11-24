# Privacy Policy

**Effective Date:** November 24, 2026
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
Homes. It does three things:

1. **Imports** work orders you select on **AppFolio**'s work-order pages into the
   **Alabama Signature Homes web app**.
2. **Bills approved work** in **AppFolio's vendor portal**, on the web app's
   behalf: it accepts the work order, posts its photographs as notes, submits the
   invoice and marks the work done, in a background tab, as a person would.
3. **Puts approved inspections into AppFolio**, as the property manager, on the
   web app's behalf: it creates the inspection, fills in its areas and items,
   attaches its photographs and marks it done, in a background tab.

There is no third-party service involved in any of them. Data goes between
AppFolio and Alabama Signature Homes' own web app, and nowhere else.

---

## 2. Information Collected

The developer collects nothing. There is no analytics, no telemetry, no
advertising and no tracking of any kind.

The information the extension reads and sends is:

- **Work order details already shown in your AppFolio account** — number,
  street, unit, city, state, ZIP, description, and AppFolio's own id and address
  for the work order — for the work orders you tick and import, along with the
  name of the company the AppFolio page shows and the page's host name (for
  example `camelot.appfolio.com`), so the web app can tell which AppFolio
  account they came from and check it is the right one. These are sent to the
  web app you configure.
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
  reported to the web app, as for the vendor portal. The check-in reports this
  for every connection this browser can work.

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
  extension and adapter versions it runs, and, for each connection it can work,
  whether it is signed in there — the vendor portal and the property manager's
  AppFolio; and the results of the jobs it works.

To **AppFolio's vendor portal**, only by using the portal's own pages in a tab,
as a person would. To the **property manager's AppFolio**, the same way: an
approved inspection is typed into its inspection pages and its photographs
attached there, in a tab, as a person would. Nothing is sent to AppFolio outside
those pages.

To find out whether this browser is still signed in to either AppFolio site,
the extension may open the site in a background tab of its ASH group every few
minutes, see whether it lands signed in or on AppFolio's sign-in page, and close
the tab again. It does this only while **Process ASH jobs** is switched on, and
only when the answer could change the work it is offered.

---

## 4. Local Data Storage

Stored in your browser's local storage (`chrome.storage.local`):

- the web app's address;
- the identity record made at sign-in: the device token, the device's name, the
  worker number and unique worker id the web app gave this browser, and your name and
  email as the web app reported them;
- the delivery worker's state: whether processing is switched on, the web app's
  last answer about the connections this browser may work, the last check-in's
  outcome (`ash_worker_status`), results not yet delivered to the web app, and a
  short list of recent jobs;
- which jobs were rehearsed while a connection was in dry run, so they are not
  rehearsed again (`ash_worker_rehearsed`), and whether the troubleshooting
  switch "Stop after the next press" is armed (`ash_worker_stop_after_press`);
- whether this browser was last seen signed in to the vendor portal, and to the
  property manager's AppFolio (`ash_pm_session`);
- if the extension's own pretend portals are opened (by its tests), their
  made-up work orders and inspections (`fixture_site`,
  `appfolio_vendor_fixture`, `appfolio_pm_fixture`).

Stored in session storage (`chrome.storage.session`), which the browser discards
when it closes: the hourly access token, the job in hand, which tabs the
extension opened for it, and which tab group is its ASH group
(`ash_worker_group`).

None of this is synced between devices or uploaded anywhere by the extension.

**Your password is never stored.**

Signing out in the extension's settings removes the identity record and the
access token, the job in hand (closing its tab), results not yet delivered, the
web app's last answer about the connections, and the last check-in's outcome.
Everything else listed above stays until you remove the extension, and removing
the extension removes all of it. You can also retire this browser from the
**Your Account** page of the web app, which is the right thing to do if the browser is
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
| `tabs` | Open a vendor-portal or property-manager tab for a job, or a short-lived tab to check you are signed in, know when it has loaded, and close it afterwards; find a tab a job's page opened, by reading open tabs' addresses and which tab opened them; and bring a tab to the front when a job is waiting for you. |
| `tabGroups` | Gather the tabs it opens into one group named ASH, kept open, because the browser freezes the tabs of a collapsed group. |
| `alarms` | Check for approved work once a minute, which survives the extension's background worker being stopped. |
| `notifications` | Tell you when a job is waiting for you to press something, since the popup is usually closed. |
| Access to AppFolio work-order pages | Read the work orders shown on them, add status badges and the Import bar. |
| Access to AppFolio's vendor portal | Work approved jobs there, and notice whether you are signed in. |
| Access to the property manager's AppFolio inspection pages | Put approved inspections in, and notice whether you are signed in. One small script (`page_bridge.js`) runs in the page's own JavaScript world, because AppFolio's address search and inspection list can only be driven from there; it also waits for AppFolio to finish saving each change. |
| Access to the web app address you enter | Sign in, import work orders and work the delivery queue. Requested at the moment you save the address, and never granted in advance. It can only be granted for `alabamasignaturehomes.com` and its subdomains, or `localhost` and `127.0.0.1` on this computer. |

Browsing history is not accessed; the addresses of open tabs are read only to
find the tabs a job opened. Cookies are not read; the extension's requests
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
