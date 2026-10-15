/**
 * The fixture adapter's page half — what would be a content script on a real
 * portal. It answers one small command at a time from the service worker
 * (adapter.js) and keeps nothing between them, because a step may be asked
 * again after the worker restarts and the page may have reloaded since.
 *
 * Reached over chrome.runtime messaging as `ASH_PAGE_COMMAND`, addressed to
 * this tab (and, inside the extension's test page, to this frame). Answers
 * `{ ok: true, result }` or `{ ok: false, error, error_class }`.
 */

import { SELECTORS as S } from "./selectors.v1.js";

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    tab_id: null,
    frame: null,

    async init() {
      app.frame = new URLSearchParams(location.search).get("frame");

      const tab = await chrome.tabs.getCurrent().catch(() => null);

      app.tab_id = tab?.id ?? null;
      chrome.runtime.onMessage.addListener(app.on_message);
    },

    on_message(message, sender, respond) {
      if (message?.type !== "ASH_PAGE_COMMAND") return false;
      if (sender?.id !== chrome.runtime.id) return false;
      if (message.tab_id !== app.tab_id || (message.frame ?? null) !== app.frame) return false;

      app
        .handle(message.command, message.args || {})
        .then((result) => respond({ ok: true, result }))
        .catch((error) => respond({ ok: false, error: error?.message || String(error), error_class: error?.error_class || "adapter_broken" }));

      return true;
    },

    async handle(command, args) {
      await app.ready();

      switch (command) {
        case "state":
          return app.state();
        case "find_invoice":
          return app.find_invoice(args);
        case "fill_invoice":
          return app.fill_invoice(args);
        case "read_total":
          return { total_cents: app.cents(app.text(S.total)) };
        case "submit":
          return app.click(S.submit);
        case "accept":
          return app.click(S.accept_button);
        default:
          throw Object.assign(new Error(`Unknown command: ${command}`), { error_class: "adapter_broken" });
      }
    },

    async ready(timeout = 5000) {
      const until = Date.now() + timeout;

      while (document.body?.dataset?.[S.ready_flag] !== "1") {
        if (Date.now() > until) throw Object.assign(new Error("The page never finished loading."), { error_class: "transient" });

        await app.sleep(50);
      }
    },

    state() {
      const signed_in = document.querySelector(S.signed_out)?.hidden !== false;

      return {
        signed_in,
        number: signed_in ? app.text(S.number) : "",
        accepted: signed_in && document.querySelector(S.accepted_badge)?.hidden === false,
      };
    },

    invoices() {
      return [...document.querySelectorAll(S.invoice)].map((item) => ({
        id: item.dataset.invoiceId || "",
        number: item.querySelector(S.invoice_number)?.textContent.trim() || "",
        total_cents: app.cents(item.querySelector(S.invoice_total)?.textContent || ""),
      }));
    },

    /** The newest invoice with this total, waiting up to `wait_ms` for one to appear. */
    async find_invoice({ total_cents = null, wait_ms = 0 }) {
      const until = Date.now() + Number(wait_ms || 0);

      for (;;) {
        const found = app
          .invoices()
          .reverse()
          .find((invoice) => total_cents === null || invoice.total_cents === total_cents);

        if (found || Date.now() >= until) return { invoice: found || null };

        await app.sleep(100);
      }
    },

    fill_invoice({ items = [] }) {
      for (const row of document.querySelectorAll(S.line_row)) row.remove();

      for (const item of items) {
        document.querySelector(S.add_line).click();

        const rows = document.querySelectorAll(S.line_row);
        const row = rows[rows.length - 1];

        app.type(row.querySelector(S.line_description), item.description);
        app.type(row.querySelector(S.line_quantity), item.quantity);
        app.type(row.querySelector(S.line_rate), item.rate);
      }

      return { lines: document.querySelectorAll(S.line_row).length };
    },

    type(input, value) {
      input.value = String(value ?? "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },

    click(selector) {
      const button = document.querySelector(selector);

      if (!button || button.hidden) throw Object.assign(new Error(`No ${selector} to press.`), { error_class: "adapter_broken" });

      button.click();

      return { clicked: true };
    },

    text(selector) {
      return document.querySelector(selector)?.textContent.trim() || "";
    },

    /** A displayed amount, "104.97", as cents; null if it is not one. */
    cents(text) {
      const match = /^(-?)(\d+)\.(\d{2})$/.exec(String(text).replace(/[$,\s]/g, ""));

      if (!match) return null;

      const cents = Number(match[2]) * 100 + Number(match[3]);

      return match[1] === "-" ? -cents : cents;
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
});
