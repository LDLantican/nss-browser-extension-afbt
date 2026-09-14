/**
 * Reading work orders out of Appfolio.
 *
 * Loaded first in both Appfolio content-script entries and shared through one
 * global in the isolated world. It cannot be an ES module: Manifest V3 has no
 * `"type": "module"` for declarative content scripts, and listing two files in
 * one `js` array — which run in order, in the same world — is the mechanism
 * that exists instead.
 *
 * ## Why this fetches instead of clicking
 *
 * v1 scraped the list page by clicking a row's expand button and then reading
 * the address and description **synchronously**, on the next statement, before
 * Appfolio had rendered them. That is a race it won often enough to ship and
 * lost often enough to be the reason several fields arrive empty. It also could
 * not survive a batch: twenty rows meant twenty expand animations fighting one
 * another.
 *
 * So a row is read by fetching its own detail page and parsing that. The
 * content script is on appfolio.com, so the request is same-origin and carries
 * the manager's session — no host permission, no CORS, no mutation of the page
 * she is looking at, and one parser for both entry points instead of two that
 * disagree.
 *
 * The list page is still used for one thing it is better at: knowing which rows
 * exist and what their numbers are.
 *
 * **Confirmed against a live Appfolio list on 4 September 2026**: every row does
 * carry a link to its work order, so the fetch path is the one that runs. The
 * in-place fallback below is kept anyway — it costs one branch, and it means a
 * change on Appfolio's side degrades this rather than breaking it.
 */

(() => {
  /* One regex for both pages. v1 had two, and they disagreed: the list page
     accepted ZIP+4 and the detail page did not, so the same property parsed
     differently depending on where you clicked. */
  const CITY_STATE_ZIP = /^(.*?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/;

  const SELECTORS = {
    list: ".js-work-order-list ul.list-group",
    list_item: ":scope > li.list-group-item",
    number_in_row: ".js-work-order-number [aria-label='Number']",

    /* Appfolio's own per-row select box, which is the list's only selection.
       Two things about it are worth writing down, because both look usable and
       are not: its `id` is Appfolio's internal work-order id (`18662`) and not
       the number the row displays (`18094-2`), so a box is matched to a row
       through the `<li>` that contains it and never through its own value; and
       the header select-all above the list has no stable hook at all — its id
       is `selectall-1`, then `selectall-2` on the next load. Watch the count
       below instead of trying to name that box. */
    row_select: "input.js-select-work-order-item",

    /* "12 Selected", in two responsive duplicates. This is the authoritative
       signal that the selection changed: Appfolio's select-all sets every row
       box directly and fires no `change` on any of them, but it always writes
       these. */
    selected_count: ".js-num-selected-text",

    detail_body: ".js-work-order-body__details",
    detail_header: ".js-work-order-header-left.work-order-header__left",
    detail_description: ".js-work-order-description",
    detail_address_card: ".contact-card-container",
    detail_address: ".js-contact-card-address",
    detail_anchor: "div.u-clearfix:has(h2.service-request__box-title.js-service-request-title)",
  };

  /** Trimmed text, or "" — never a throw on a selector that found nothing. */
  function text_of(root, selector) {
    const node = root?.querySelector(selector);

    return node ? collapse(node.textContent || "") : "";
  }

  function collapse(value) {
    return String(value).replace(/\s+/g, " ").trim();
  }

  /**
   * Split "Birmingham, AL 35203" into its parts.
   *
   * Returns blanks rather than null when it does not match, because a work
   * order with an unparseable city is still a work order — the web app only
   * requires a number and a street, and it would rather have those than reject
   * the row over a ZIP.
   */
  function split_city_state_zip(value) {
    const match = collapse(value).match(CITY_STATE_ZIP);

    if (!match) return { city: "", state: "", zip: "" };

    return {
      city: collapse(match[1]),
      state: match[2].toUpperCase(),
      zip: match[3],
    };
  }

  /**
   * The work-order number out of a detail page's header.
   *
   * The header holds more than the number, hence the pattern rather than the
   * whole string. Appfolio's numbers look like `2737-1` — a service request and
   * the work order within it.
   */
  function number_from_header(header_text) {
    const match = collapse(header_text).match(/\d+-\d+/);

    return match ? match[0] : "";
  }

  /**
   * Parse a work order out of a detail document.
   *
   * Takes a Document so it serves both callers: the detail page passes its own
   * `document`, and the list page passes one DOMParser made from a fetch. That
   * is the whole reason the two entry points cannot drift apart.
   *
   * The address is read from innerHTML because Appfolio separates the street
   * from the city line with a <br>, which textContent would run together into
   * "123 Main StBirmingham, AL 35203".
   */
  function parse_detail(doc, fallback_number = "") {
    const body = doc.querySelector(SELECTORS.detail_body);

    const number =
      number_from_header(text_of(body || doc, SELECTORS.detail_header)) ||
      String(fallback_number || "").trim();

    if (number === "") return null;

    const address_node = doc
      .querySelector(SELECTORS.detail_address_card)
      ?.querySelector(SELECTORS.detail_address);

    let street = "";
    let city = "";
    let state = "";
    let zip = "";

    if (address_node) {
      const lines = String(address_node.innerHTML || "")
        .split(/<br\s*\/?>/i)
        .map((line) => collapse(line.replace(/<[^>]*>/g, "")))
        .filter((line) => line !== "");

      street = lines[0] || "";

      /* The last line that parses as a city line, rather than lines[1]: some
         properties carry a unit or a second address line in between. */
      for (let index = lines.length - 1; index >= 1; index--) {
        const parts = split_city_state_zip(lines[index]);

        if (parts.state !== "") {
          city = parts.city;
          state = parts.state;
          zip = parts.zip;
          break;
        }
      }
    }

    return {
      number,
      street,
      city,
      state,
      zip,
      description: text_of(body || doc, SELECTORS.detail_description),
    };
  }

  /**
   * Every row on the list page, with the link to its detail page.
   *
   * A row with no link cannot be fetched, so its href comes back empty and the
   * caller falls back to expanding it in place. That fallback is the reason the
   * old code path is kept rather than deleted.
   */
  function list_rows() {
    const list = document.querySelector(SELECTORS.list);
    if (!list) return [];

    return [...list.querySelectorAll(SELECTORS.list_item)]
      .map((element) => {
        const number = text_of(element, SELECTORS.number_in_row);
        if (number === "") return null;

        const anchor = element.querySelector(
          "a[href*='/work_orders/'], a[href*='/service_requests/']",
        );

        /* A row whose box is missing is still a row — it simply cannot be
           selected, and it still deserves a badge. */
        return {
          element,
          number,
          href: anchor?.href || "",
          box: element.querySelector(SELECTORS.row_select),
        };
      })
      .filter((row) => row !== null);
  }

  /**
   * Fetch and parse one work order's detail page.
   *
   * Same-origin, with the session cookie, so this is the manager's own access
   * and not a second authentication. A redirect to a login page produces a
   * document with none of the selectors in it, which parse_detail reports as
   * null rather than as blank fields.
   */
  async function fetch_detail(href, fallback_number = "") {
    const response = await fetch(href, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
      cache: "no-store",
    });

    if (!response.ok) throw new Error(`Appfolio answered ${response.status}.`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const work_order = parse_detail(doc, fallback_number);

    if (!work_order)
      throw new Error("Could not read that work order's details from Appfolio.");

    return work_order;
  }

  /**
   * Read a row without leaving the list page.
   *
   * The fallback for a row with no detail link, and the one place the old
   * expand-and-read approach survives — with the wait it always needed. The
   * fields are read once the expanded region actually contains an address,
   * rather than on the statement after the click.
   */
  async function scrape_row_in_place(row) {
    const expand = row.element.querySelector(
      "button.js-expand.btn.btn-link:has(i.fa-chevron-down,i.fa-chevron-up)",
    );

    if (!expand) throw new Error("Could not open that row to read it.");

    expand.click();

    try {
      const address = await wait_for(
        () => row.element.querySelector("[aria-label='Address']"),
        4000,
      );

      if (!address) throw new Error("That row did not open in time.");

      const parts = split_city_state_zip(
        text_of(row.element, "[aria-label='AddressCityAndState']"),
      );

      return {
        number: row.number,
        street: collapse(address.textContent || ""),
        city: parts.city,
        state: parts.state,
        zip: parts.zip,
        description: text_of(row.element, "[aria-label='Description']"),
      };
    } finally {
      /* Collapse it again whatever happened, so a failed read does not leave
         the manager's list expanded in a way she did not ask for. */
      expand.click();
    }
  }

  /** One work order, by whichever route the row allows. */
  async function scrape_row(row) {
    if (row.href !== "") return fetch_detail(row.href, row.number);

    return scrape_row_in_place(row);
  }

  /** Poll until a thing exists, or give up. Used only where a click precedes it. */
  function wait_for(get, timeout = 4000, interval = 100) {
    return new Promise((resolve) => {
      const found = get();
      if (found) return resolve(found);

      const started = Date.now();

      const timer = setInterval(() => {
        const value = get();

        if (value) {
          clearInterval(timer);
          resolve(value);

          return;
        }

        if (Date.now() - started >= timeout) {
          clearInterval(timer);
          resolve(null);
        }
      }, interval);
    });
  }

  /**
   * Wait for an element to appear, the way v1 did — MutationObserver with a
   * ceiling. Kept because the page is a SPA and the list arrives after load.
   */
  function query_element(selector, timeout = 10000) {
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);

        if (found) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(found);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  /** Ask the service worker something, and never throw at the caller. */
  async function ask(type, payload = {}) {
    try {
      const answer = await chrome.runtime.sendMessage({ type, payload });

      return answer ?? { ok: false, error: "No answer from the extension." };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || "The extension is not responding.",
      };
    }
  }

  globalThis.nss = {
    SELECTORS,
    collapse,
    text_of,
    split_city_state_zip,
    parse_detail,
    list_rows,
    fetch_detail,
    scrape_row,
    query_element,
    wait_for,
    ask,
  };
})();
