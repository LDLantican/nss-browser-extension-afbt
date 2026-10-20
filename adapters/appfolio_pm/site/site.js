/**
 * The pretend property-manager AppFolio's pages: the inspection list with its
 * Properties filter, the New Inspection form with its address search, and an
 * inspection with its areas, items and item forms — rendered from the books
 * (books.js) and behaving like AppFolio's when pressed.
 *
 * The markup and `js-*` hooks are the live pages', read on 2026-10-20
 * (structure only). The two search boxes imitate the libraries the live pages
 * use — select2 (opens on mousedown, picks on mouseup) on the form, and
 * react-select (picks on mousedown) on the list's filter — because those are
 * what page.js has to drive. The books live in chrome.storage.local under
 * `?store=<key>` (or BOOKS_KEY), so a test never touches anybody else's.
 */

import {
  add_area,
  add_item,
  BOOKS_KEY,
  by_id,
  create,
  delete_area,
  delete_item,
  empty_books,
  list,
  mark_done,
  save_item,
  search_units,
} from "./books.js";

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    key: BOOKS_KEY,
    main: null,
    filter: { open: false, street: "", typed: "" },
    form: { query: "", chosen: null, open: false },
    editing: null,

    init() {
      app.key = new URLSearchParams(location.search).get("store") || BOOKS_KEY;
      app.main = document.querySelector("#main");

      window.addEventListener("hashchange", () => {
        app.editing = null;
        app.form = { query: "", chosen: null, open: false };
        app.render();
      });
      app.main.addEventListener("click", app.on_click);
      app.main.addEventListener("mousedown", app.on_mousedown);
      app.main.addEventListener("mouseup", app.on_mouseup);
      app.main.addEventListener("input", app.on_input);
      app.main.addEventListener("keyup", app.on_keyup);
      app.main.addEventListener("keydown", app.on_keydown);
      app.main.addEventListener("focusout", app.on_focusout);
      app.main.addEventListener("change", app.on_change);
      app.main.addEventListener("submit", (event) => event.preventDefault());

      app.render();
    },

    async load() {
      const { [app.key]: books } = await chrome.storage.local.get(app.key);

      return books || empty_books();
    },

    async change(mutate) {
      const books = await app.load();
      const out = mutate(books);

      await chrome.storage.local.set({ [app.key]: books });

      return out;
    },

    route() {
      const hash = location.hash.replace(/^#/, "") || "/maintenance/inspections";
      const inspection = /^\/inspections\/(\d+)/.exec(hash);

      if (inspection) return { kind: "inspection", id: inspection[1] };
      if (/^\/maintenance\/inspections\/new/.test(hash)) return { kind: "new", id: null };

      return { kind: "list", id: null };
    },

    escape(text) {
      return String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    },

    async render() {
      const books = await app.load();

      if (books.signed_in === false) {
        document.title = "Sign In";
        app.main.innerHTML = `<h1>Sign in</h1><input type="password" name="password">`;

        return;
      }

      document.title = "Inspections";

      const here = app.route();

      if (here.kind === "new") return app.render_new(books);
      if (here.kind === "inspection") return app.render_inspection(books, by_id(books, here.id));

      return app.render_list(books);
    },

    // -- The list -------------------------------------------------------------

    render_list(books) {
      const rows = list(books, { street: app.filter.street })
        .map(
          (i) => `<tr data-open="${i.id}"><td><input type="checkbox" class="mx-1"></td><td class="cursor-pointer">${app.escape(i.date)}</td>
            <td class="cursor-pointer"><div class="ms-2"><span class="badge badge-secondary">${app.escape(i.status)}</span></div></td>
            <td class="cursor-pointer">${app.escape(i.name)}</td><td class="cursor-pointer">${app.escape(i.street)}</td>
            <td class="cursor-pointer">Inspection</td><td class="cursor-pointer"><span>${i.areas.flatMap((a) => a.items).filter((x) => x.result === "follow_up").length}</span></td></tr>`,
        )
        .join("");
      const options = app.filter.typed
        ? books.units
            .filter((u) => u.street.toLowerCase().includes(app.filter.typed.toLowerCase()))
            .map((u) => `<div class="Select-option" data-street="${app.escape(u.street)}">${app.escape(u.address)}</div>`)
            .join("")
        : "";
      const panel = app.filter.open
        ? `<div class="filter-panel">
            <label class="col-form-label">Properties</label>
            <div class="Select select-async is-clearable is-searchable Select--multi">
              <div class="Select-control"><span class="Select-multi-value-wrapper">${app.filter.street ? `<div class="Select-value">${app.escape(app.filter.street)}</div>` : '<div class="Select-placeholder">Search by property, group, or portfolio</div>'}<div class="Select-input"><input class="js-no-autofocus" role="combobox" value="${app.escape(app.filter.typed)}"></div></span></div>
              ${options ? `<div class="Select-menu-outer"><div class="Select-menu">${options}</div></div>` : ""}
            </div>
            <button type="button" class="btn btn-primary" data-action="search">Search</button>
          </div>`
        : "";

      app.main.innerHTML = `<h1>Inspections</h1>
        <button type="button" data-action="filter"><strong>Click here to search</strong></button>${panel}
        <table class="table table-sm table-bordered table-hover"><thead><tr><th></th><th>Inspection Date</th><th>Status</th><th>Name</th><th>Unit Name</th><th>Type</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table>`;

      const input = app.main.querySelector(".Select-input input");

      if (input && document.activeElement !== input && app.filter.typed) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    },

    // -- New inspection -------------------------------------------------------

    render_new(books) {
      const results = app.form.open
        ? search_units(books, app.form.query)
            .map(
              (u, i) => `<li class="select2-results-dept-0 select2-result select2-result-selectable" data-unit="${i}"><div class="select2-result-label"><i class="sprite ${u.kind === "resident" ? "sprite-resident" : u.kind === "property" ? "sprite-property" : "sprite-unit"}"></i>${app.escape(u.label)}</div></li>`,
            )
            .join("")
        : "";

      app.main.innerHTML = `<h1>New Inspection</h1>
        <form class="form js-new-inspection-form" action="/maintenance/inspections" method="post">
          <div class="js-name"><label>Name</label><input type="text" name="new_inspection[inspection][name]" id="new_inspection_inspection_name"></div>
          <div class="js-date"><label>Inspection Date</label><input type="date" class="js-datepicker" name="new_inspection[inspection][inspected_on]"></div>
          <div class="js-inspectable"><label>Address</label>
            <div class="select2-container js-select2-search-inspectable"><a class="select2-choice"><span class="select2-chosen">${app.escape(app.form.chosen?.label || "Search for property, unit or tenant")}</span></a></div>
            <input type="hidden" name="new_inspection[new_inspectable_id]" value="${app.form.chosen ? "1" : ""}">
            ${app.form.open ? `<div class="select2-drop select2-drop-active"><div class="select2-search"><input type="text" class="select2-input" value="${app.escape(app.form.query)}"></div><ul class="select2-results">${results}</ul></div>` : ""}
          </div>
          <label><input type="radio" class="js-layout-button" name="new_inspection[layout]" value="default" checked> Use default layout as starting point.</label>
          <label><input type="radio" class="js-layout-button" name="new_inspection[layout]" value="seed_inspection"> Use existing inspection or template.</label>
          <input type="submit" name="commit" value="Start Inspection" class="js-start-inspection btn btn-primary" data-action="start">
        </form>`;

      const search = app.main.querySelector(".select2-input");

      if (search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    },

    // -- An inspection --------------------------------------------------------

    render_inspection(books, inspection) {
      if (!inspection) {
        app.main.innerHTML = "<p>Not found</p>";

        return;
      }

      const item_html = (area, item) => {
        const editing = app.editing?.item_id === item.id ? app.editing : null;
        const result = editing ? editing.result : item.result;
        const buttons = `<div class="ms-4 d-flex align-items-center justify-content-end">
            <button type="button" class="js-check-circle me-2 btn btn-outline-link${result === "ok" ? " active" : ""}" data-action="ok" data-item="${item.id}">OK</button>
            <button type="button" class="js-flag btn btn-outline-link${result === "follow_up" ? " active" : ""}" data-action="flag" data-item="${item.id}">FOLLOW-UP</button>
            ${editing ? "" : `<button type="button" class="js-edit-item btn btn-link" data-action="edit" data-item="${item.id}">Edit</button>`}</div>`;
        const thumbs = Array.from({ length: item.photos }, () => `<div class="d-inline-block position-relative"><button class="me-2 my-1 rounded btn btn-outline-light"></button></div>`).join("");

        if (!editing)
          return `<li class="js-item p-4 list-group-item" id="${item.id}"><div class="js-item-header ps-0 d-flex align-items-center col" role="button"><div class="js-item-name me-auto"><span class="fw-bold">${app.escape(item.name)}</span></div>${buttons}</div>
            <div class="js-item-content"><span class="js-item-description">${app.escape(item.note)}</span><div class="my-4">${thumbs}</div></div></li>`;

        return `<li class="js-item p-4 list-group-item" id="${item.id}"><div class="js-item-header ps-0 d-flex align-items-center col" role="button"><div class="js-item-name me-auto"><label class="col-form-label">Name*</label><input class="js-item-name-input form-control" value="${app.escape(editing.name)}"></div>${buttons}</div>
          <div class="js-item-content mt-3 ps-0 col"><textarea class="js-item-notes form-control mb-1">${app.escape(editing.note)}</textarea>
            <button type="button" class="js-no-autofocus btn btn-secondary">Choose Photos to Add</button><input type="file" accept="image/*" multiple>
            <button type="button" class="js-item-save me-2 btn btn-primary" data-action="save" data-item="${item.id}">Save</button>
            <button type="button" class="js-item-cancel btn btn-secondary" data-action="cancel">Cancel</button>
            <button type="button" class="js-delete-item ms-auto text-danger btn btn-link" data-action="delete_item" data-item="${item.id}">Delete Item</button></div></li>`;
      };

      const cards = inspection.areas
        .map(
          (area) => `<div class="mb-4 card"><div class="py-3 card-header" role="button"><div class="align-items-center row"><div class="d-flex align-items-center col">
              <button type="button" class="js-area-name btn btn-link">${app.escape(area.name)}</button></div>
              <button type="button" class="js-delete-area btn btn-link text-danger" data-action="delete_area" data-area="${area.id}">Delete Area</button></div></div>
            <div class="card-body"><ul class="list-group">${area.items.map((item) => item_html(area, item)).join("")}${
              app.editing?.new_in === area.id ? item_html(area, { id: "new", name: app.editing.name, result: null, note: "", photos: 0 }) : ""
            }</ul>
            <button type="button" class="js-add-item w-100 btn btn-link" data-action="add_item" data-area="${area.id}">Add Item</button></div></div>`,
        )
        .join("");
      const new_area = app.editing?.new_area ? `<div class="mb-4 card"><div class="card-header"><div class="col-12"><input class="js-area-name-input form-control" placeholder="Enter an area name..."></div></div></div>` : "";

      app.main.innerHTML = `<header><h1 class="js-inspection-title">${app.escape(inspection.name)}</h1><span class="ms-4 me-1">${app.escape(inspection.status)}</span>
          <span class="js-inspection-date">Inspection Date: ${app.escape(inspection.date)}</span></header>
        <p>Property: <span class="js-inspection-address">${app.escape(inspection.address)}</span></p>
        <div class="js-actions-dropdown"><button type="button" class="js-mark-complete-dropdown dropdown-item" data-action="done">Mark Inspection Done</button></div>
        ${cards}${new_area}
        <button type="button" class="w-100 btn btn-secondary" data-action="add_area"><i class="js-add-area"></i>Add Area</button>
        <button type="button" class="w-100 mt-3 btn btn-primary" data-action="done"><i class="js-add-area"></i>Mark Inspection Done</button>`;
    },

    // -- What the controls do -------------------------------------------------

    async on_click(event) {
      const row = event.target.closest("tr[data-open]");

      if (row) {
        /* AppFolio opens an inspection from its list in a new tab. */
        window.open(`${location.pathname}${location.search}#/inspections/${row.dataset.open}`, "_blank");

        return undefined;
      }

      const control = event.target.closest("[data-action]");

      if (!control) return undefined;

      const here = app.route();
      const action = control.dataset.action;

      switch (action) {
        case "filter":
          app.filter.open = true;

          return app.render();

        case "search":
          return app.render();

        case "start": {
          event.preventDefault();

          const form = app.main.querySelector(".js-new-inspection-form");
          const name = form.querySelector("[name='new_inspection[inspection][name]']").value;
          const date = form.querySelector("[name='new_inspection[inspection][inspected_on]']").value;

          if (!name || !app.form.chosen) return undefined;

          const made = await app.change((books) => create(books, { name, date, unit_label: app.form.chosen.label }));

          location.hash = `/inspections/${made.id}`;

          return undefined;
        }

        case "edit": {
          const books = await app.load();
          const item = by_id(books, here.id).areas.flatMap((a) => a.items).find((i) => i.id === control.dataset.item);

          app.editing = { item_id: item.id, name: item.name, result: item.result, note: item.note, files: 0 };

          return app.render();
        }

        case "ok":
        case "flag":
          if (app.editing?.item_id !== control.dataset.item) return undefined;
          app.editing.result = action === "ok" ? "ok" : "follow_up";
          app.capture_fields();

          return app.render();

        case "cancel":
          app.editing = null;

          return app.render();

        case "save": {
          app.capture_fields();

          const editing = app.editing;

          app.editing = null;

          if (editing.new_in) {
            await app.change((books) => {
              const made = add_item(books, here.id, editing.new_in, editing.name);

              if (editing.result !== null || editing.note) save_item(books, here.id, made.id, { result: editing.result, note: editing.note });
            });
          } else {
            await app.change((books) => save_item(books, here.id, editing.item_id, { result: editing.result, note: editing.note, photos: editing.files }));
          }

          return app.render();
        }

        case "delete_item":
          if (app.editing?.new_in) app.editing = null;
          else {
            const item_id = app.editing?.item_id;

            app.editing = null;
            await app.change((books) => delete_item(books, here.id, item_id));
          }

          return app.render();

        case "delete_area":
          await app.change((books) => delete_area(books, here.id, control.dataset.area));

          return app.render();

        case "add_item":
          app.editing = { item_id: "new", new_in: control.dataset.area, name: "", result: null, note: "", files: 0 };

          return app.render();

        case "add_area":
          app.editing = { new_area: true };

          return app.render();

        case "done":
          await app.change((books) => mark_done(books, here.id));

          return app.render();

        default:
          return undefined;
      }
    },

    /** Keep what has been typed into an open item form across a redraw. */
    capture_fields() {
      if (!app.editing) return;

      const name = app.main.querySelector(".js-item-name-input");
      const note = app.main.querySelector(".js-item-notes");

      if (name) app.editing.name = name.value;
      if (note) app.editing.note = note.value;
    },

    on_mousedown(event) {
      if (event.target.closest(".select2-choice")) {
        app.form.open = true;

        return app.render();
      }

      const option = event.target.closest(".Select-option");

      if (option) {
        app.filter.street = option.dataset.street;
        app.filter.typed = "";

        return app.render();
      }

      return undefined;
    },

    async on_mouseup(event) {
      const result = event.target.closest("li.select2-result-selectable");

      if (!result) return undefined;

      const books = await app.load();

      app.form.chosen = search_units(books, app.form.query)[Number(result.dataset.unit)] || null;
      app.form.open = false;

      /* Keep the name and date typed before the search. */
      const name = app.main.querySelector("[name='new_inspection[inspection][name]']").value;
      const date = app.main.querySelector("[name='new_inspection[inspection][inspected_on]']").value;

      await app.render();
      app.main.querySelector("[name='new_inspection[inspection][name]']").value = name;
      app.main.querySelector("[name='new_inspection[inspection][inspected_on]']").value = date;

      return undefined;
    },

    on_input(event) {
      if (event.target.matches(".Select-input input")) {
        app.filter.typed = event.target.value;
        app.render();
      }
    },

    on_keyup(event) {
      if (event.target.matches(".select2-input")) {
        app.form.query = event.target.value;

        const name = app.main.querySelector("[name='new_inspection[inspection][name]']").value;
        const date = app.main.querySelector("[name='new_inspection[inspection][inspected_on]']").value;

        app.render().then(() => {
          app.main.querySelector("[name='new_inspection[inspection][name]']").value = name;
          app.main.querySelector("[name='new_inspection[inspection][inspected_on]']").value = date;
        });
      }
    },

    async keep_area(input) {
      const name = input.value.trim();

      if (!name || !app.editing?.new_area) return;

      app.editing = null;
      await app.change((books) => add_area(books, app.route().id, name));
      app.render();
    },

    on_keydown(event) {
      if (event.target.matches(".js-area-name-input") && event.key === "Enter") app.keep_area(event.target);
    },

    on_focusout(event) {
      if (event.target.matches(".js-area-name-input")) app.keep_area(event.target);
    },

    on_change(event) {
      if (event.target.matches(".js-item-content input[type='file']") && app.editing) app.editing.files = event.target.files.length;
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
});
