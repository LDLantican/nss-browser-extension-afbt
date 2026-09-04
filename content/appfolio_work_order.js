/**
 * A single Appfolio work order, with one button and one badge.
 *
 * The same two actions as the list page, for the manager who has opened a work
 * order to read it and decided there and then. It shares the parser and the
 * status vocabulary with the list, so nothing can drift between them: this page
 * simply passes its own `document` to the parser the list page passes a fetched
 * one to.
 *
 * The badge follows the same rule as the list's. It is fetched live, and if the
 * web app cannot be reached it says so rather than showing anything remembered.
 */

(() => {
  const nss = globalThis.nss;

  const app = {
    work_order: null,
    settings: {},
    busy: false,

    async init() {
      const body = await nss.query_element(nss.SELECTORS.detail_body);
      if (!body) return;

      const anchor = await nss.query_element(nss.SELECTORS.detail_anchor);
      if (!anchor) return;

      app.work_order = nss.parse_detail(document);
      if (!app.work_order) return;

      const state = await nss.ask("STATE");
      app.settings = state?.settings || {};

      app.render(anchor);
      app.load_status();
    },

    render(anchor) {
      anchor.querySelector(".nss-detail")?.remove();

      const holder = document.createElement("div");
      holder.className = "nss-detail";

      const badge = document.createElement("span");
      badge.className = "nss-badge nss-badge--loading";
      badge.id = "nss-detail-badge";
      badge.textContent = "checking…";
      holder.appendChild(badge);

      const send = document.createElement("button");
      send.type = "button";
      send.className = "nss-detail__go";
      send.disabled = app.busy;
      send.textContent = app.busy ? "Sending…" : "Sync to web app";
      send.addEventListener("click", () => app.send());
      holder.appendChild(send);

      if (app.settings.buildertrend_enabled !== false) {
        const queue = document.createElement("button");
        queue.type = "button";
        queue.className = "nss-detail__link";
        queue.textContent = "Queue for Buildertrend";
        queue.addEventListener("click", () => app.queue_for_bt());
        holder.appendChild(queue);
      }

      const note = document.createElement("p");
      note.className = "nss-detail__note";
      note.id = "nss-detail-note";
      holder.appendChild(note);

      anchor.appendChild(holder);
    },

    say(text, kind = "info") {
      const note = document.getElementById("nss-detail-note");
      if (!note) return;

      note.textContent = text;
      note.className = `nss-detail__note nss-detail__note--${kind}`;
    },

    paint(label, kind, title = "") {
      const badge = document.getElementById("nss-detail-badge");
      if (!badge) return;

      badge.className = `nss-badge nss-badge--${kind}`;
      badge.textContent = label;
      badge.title = title;
    },

    async load_status() {
      const answer = await nss.ask("STATUSES", { numbers: [app.work_order.number] });

      if (!answer?.ok) {
        app.paint(
          answer?.reason === "signed_out" ? "sign in for status" : "status unknown",
          "unknown",
          answer?.error || "",
        );

        return;
      }

      const server = (answer.work_orders || {})[app.work_order.number] || null;

      if (!server) {
        app.paint("not in web app", "absent");

        return;
      }

      const detail = [server.status_label || server.status];

      if (server.subcontractor) detail.push(server.subcontractor);

      app.paint(
        detail.join(" · "),
        server.status === "approved" ? "done" : "present",
        `${server.title || ""} — ${server.street || ""}`.trim(),
      );
    },

    async send() {
      if (app.busy || !app.work_order) return;

      app.busy = true;
      app.say("Sending…");
      app.paint("sending…", "loading");

      const result = await nss.ask("SYNC", { work_orders: [app.work_order] });

      app.busy = false;

      app.say(
        result?.queued > 0
          ? "Sent to the web app."
          : result?.error || "That could not be sent.",
        result?.queued > 0 ? "ok" : "error",
      );

      /* Ask the web app what it has rather than reporting what we sent — the
         same rule the ledger's reconcile step follows. */
      setTimeout(() => app.load_status(), 1200);
    },

    async queue_for_bt() {
      if (!app.work_order) return;

      await nss.ask("QUEUE_FOR_BT", { work_orders: [app.work_order] });

      app.say("Added to the Buildertrend queue. Open the extension to run it.", "ok");
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
})();
