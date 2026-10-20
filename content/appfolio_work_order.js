/**
 * A single Appfolio work order, with one button and one badge.
 *
 * The list page's Import, for the manager who has opened a work order to read
 * it and decided there and then. It shares the parser and the status
 * vocabulary with the list, so nothing can drift between them: this page simply
 * passes its own `document` to the parser the list page passes a fetched one to.
 *
 * The badge follows the same rule as the list's. It is fetched live, and if the
 * web app cannot be reached it says so rather than showing anything remembered.
 * So does the scope: the button refuses while it is unknown, and says why. This
 * page is one work order rather than fifty, so the refusal can be stated before
 * anything is pressed instead of per row afterwards.
 *
 * Since 3.1.0 (the web app's roadmap phase 8) the button is Import, into the
 * new work-order system, and the "Queue for Buildertrend" button is gone; the
 * list page's header says why.
 */

(() => {
  const nss = globalThis.nss;

  const app = {
    work_order: null,
    busy: false,

    /** Never remembered — see the list page's header. */
    scope: null,

    async init() {
      const body = await nss.query_element(nss.SELECTORS.detail_body);
      if (!body) return;

      const anchor = await nss.query_element(nss.SELECTORS.detail_anchor);
      if (!anchor) return;

      app.work_order = nss.parse_detail(document, "", location.href);
      if (!app.work_order) return;

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
      send.disabled = true;
      send.textContent = "Import";
      send.addEventListener("click", () => app.send());
      holder.appendChild(send);

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

    /** Say what this page may do with this work order, and disable the button if not. */
    paint_scope() {
      const mode = app.scope?.mode === "sample" || app.scope?.mode === "live" ? app.scope.mode : null;
      const admitted = mode !== null && nss.scope_admits(app.work_order?.description, app.scope);

      for (const button of document.querySelectorAll(".nss-detail__go")) {
        button.disabled = app.busy || !admitted;
        button.textContent = app.busy ? "Importing…" : "Import";
      }

      if (admitted) return;

      app.say(
        mode === null
          ? "The web app has not said which work orders it takes, so this cannot be imported."
          : mode === "sample"
            ? "The connection is in test mode, and this work order is not marked as a test work order."
            : "This is a test work order, and the connection is live.",
        "error",
      );
    },

    paint(label, kind, title = "") {
      const badge = document.getElementById("nss-detail-badge");
      if (!badge) return;

      badge.className = `nss-badge nss-badge--${kind}`;
      badge.textContent = label;
      badge.title = title;
    },

    /** "WO-000123 · Assigned · Shauna", as the list page writes it. */
    job_label(server) {
      const detail = [server.public_id, server.status_label || server.status];

      if (server.subcontractor) detail.push(server.subcontractor);

      return detail.filter(Boolean).join(" · ");
    },

    async load_status() {
      const answer = await nss.ask("IMPORT_STATUSES", { numbers: [app.work_order.number], company: nss.company() });

      app.scope = answer?.ok ? answer.scope || null : null;
      app.paint_scope();

      if (!answer?.ok) {
        app.paint(answer?.reason === "signed_out" ? "sign in for status" : "status unknown", "unknown", answer?.error || "");
        if (answer?.error) app.say(answer.error, "error");

        return;
      }

      const server = (answer.work_orders || {})[app.work_order.number] || null;
      const legacy = (answer.legacy || {})[app.work_order.number] || null;

      if (server) {
        app.paint(app.job_label(server), server.status === "approved" ? "done" : "present");
      } else if (legacy) {
        app.paint(`in legacy · ${legacy.status_label || legacy.status}`, "legacy");
        app.say("The old system still has this work order open, so it cannot be imported until it is finished or cancelled there.", "warn");
      } else {
        app.paint("not imported", "absent");
      }
    },

    async send() {
      if (app.busy || !app.work_order) return;
      if (!nss.scope_admits(app.work_order.description, app.scope)) return app.paint_scope();

      app.busy = true;
      app.paint_scope();
      app.say("Importing…");
      app.paint("importing…", "loading");

      const answer = await nss.ask("IMPORT", { records: [app.work_order], company: nss.company() });
      const result = (answer?.results || [])[0] || null;

      app.busy = false;
      app.paint_scope();

      const said = {
        created: ["Imported.", "ok"],
        refreshed: ["Already imported; AppFolio's description or unit was newer, and the web app now has it.", "ok"],
        unchanged: ["Already imported, and nothing had changed.", "ok"],
      }[result?.status];

      if (said) app.say(...said);
      else app.say((result?.errors || [])[0] || answer?.error || "That could not be imported.", "error");

      /* Ask the web app what it has rather than reporting what we sent. */
      setTimeout(() => app.load_status(), 600);
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
})();
