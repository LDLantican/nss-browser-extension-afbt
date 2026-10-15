/**
 * The fixture site's "platform": renders a work order from the books and
 * behaves like a vendor portal when its buttons are pressed.
 *
 * The books live in chrome.storage.local under `fixture_site` — or under
 * `?store=<key>`, which the extension's test page uses so a test never touches
 * the books a developer may be watching. Pressing Submit Invoice records an
 * invoice however many times it is pressed; refusing a duplicate is not the
 * platform's job here any more than it is AppFolio's.
 */

import { accept, empty_site, invoice_total_cents, SITE_KEY, snapshot, submit_invoice } from "./ledger.js";

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    key: SITE_KEY,
    number: "",

    init() {
      const params = new URLSearchParams(location.search);

      app.key = params.get("store") || SITE_KEY;
      app.number = params.get("wo") || "";

      document.querySelector(".js-add-line").addEventListener("click", () => app.add_line());
      document.querySelector(".js-submit-invoice").addEventListener("click", () => app.submit());
      document.querySelector(".js-accept-button").addEventListener("click", () => app.accept());
      document.querySelector(".js-sign-in").addEventListener("click", () => app.sign_in());
      document.querySelector(".js-line-rows").addEventListener("input", () => app.show_total());

      app.render();
    },

    async load() {
      const { [app.key]: site } = await chrome.storage.local.get(app.key);

      return site || empty_site();
    },

    async change(mutate) {
      const site = await app.load();
      const result = mutate(site);

      await chrome.storage.local.set({ [app.key]: site });

      return result;
    },

    async render() {
      const site = await app.load();
      const signed_in = site.signed_in !== false;

      document.querySelector(".js-signed-out").hidden = signed_in;
      document.querySelector(".js-work-order").hidden = !signed_in;
      document.querySelector(".js-wo-number").textContent = app.number;

      const order = snapshot(site, app.number);

      document.querySelector(".js-accepted-badge").hidden = !order.accepted;
      document.querySelector(".js-accept-button").hidden = order.accepted;

      const list = document.querySelector(".js-invoice-list");

      list.replaceChildren(
        ...order.invoices.map((invoice) => {
          const item = document.createElement("li");
          const number = document.createElement("span");
          const total = document.createElement("span");

          item.className = "js-invoice";
          item.dataset.invoiceId = invoice.id;
          number.className = "js-invoice-number";
          number.textContent = invoice.number;
          total.className = "js-submitted-total";
          total.textContent = app.dollars(invoice.total_cents);
          item.append(number, " — ", total);

          return item;
        }),
      );

      document.body.dataset.fixtureReady = "1";
    },

    add_line() {
      const row = document.createElement("tr");

      row.className = "js-line-row";

      for (const name of ["description", "quantity", "rate"]) {
        const cell = document.createElement("td");
        const input = document.createElement("input");

        input.className = `js-line-${name}`;
        cell.append(input);
        row.append(cell);
      }

      document.querySelector(".js-line-rows").append(row);
    },

    lines() {
      return [...document.querySelectorAll(".js-line-row")].map((row) => ({
        description: row.querySelector(".js-line-description").value,
        quantity: row.querySelector(".js-line-quantity").value,
        rate: row.querySelector(".js-line-rate").value,
      }));
    },

    show_total() {
      const cents = invoice_total_cents(app.lines());

      document.querySelector(".js-invoice-total").textContent = cents === null ? "—" : app.dollars(cents);
    },

    async submit() {
      const lines = app.lines();

      if (lines.length === 0) return;

      await app.change((site) => submit_invoice(site, app.number, lines));

      document.querySelector(".js-line-rows").replaceChildren();
      app.show_total();
      await app.render();
    },

    async accept() {
      await app.change((site) => accept(site, app.number));
      await app.render();
    },

    async sign_in() {
      await app.change((site) => {
        site.signed_in = true;
      });
      await app.render();
    },

    dollars(cents) {
      const sign = cents < 0 ? "-" : "";
      const whole = Math.abs(cents);

      return `${sign}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
});
