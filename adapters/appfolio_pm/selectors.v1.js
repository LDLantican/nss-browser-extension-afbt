/**
 * Everything the appfolio_pm adapter knows about AppFolio's inspection pages
 * (ADR-008). The only file that does: a change here bumps the adapter's
 * version in manifest.js, which is what lets the web app kill one version.
 *
 * Read off Camelot's AppFolio on 2026-10-20, structure only, on a throwaway
 * inspection nothing was saved to (docs/pm-adapter.md). Three different pages:
 *
 *   the list         /maintenance/inspections — a React table whose rows have
 *                    no links (a click opens the inspection in a new tab), and
 *                    a filter whose Properties box is a react-select
 *   the new form     /maintenance/inspections/new?inspection[template]=0 — an
 *                    ordinary Rails form with a select2 address search
 *   an inspection    /inspections/{id} — its own single-page app, hooked by
 *                    AppFolio's `js-*` classes
 *
 * Not seen live, because seeing them would have meant saving: the confirmation
 * (if any) after Delete Item, Delete Area and Mark Inspection Done (pressed by
 * hand on 2026-10-22, but whether it asked was not recorded). A new area's
 * name is saved by Enter, seen 2026-10-22: the card shows the name at once and
 * is replaced by the saved one, Add Item enabled, about 0.6 s later. Seen on 2026-10-22, on a test inspection: the
 * Follow-up button's chosen state is `active`, as OK's is, and OK and
 * FOLLOW-UP are two switches, each saved the moment it is pressed, which can
 * both be on (page.js's set_item).
 *
 * A classic script, not a module: content scripts cannot `import`, so this
 * sets `globalThis.ash_pm.SELECTORS` and page.js, listed after it, reads it.
 */

(() => {
  const pm = (globalThis.ash_pm = globalThis.ash_pm || {});

  pm.SELECTORS = {
    /* Signed out: AppFolio's sign-in form. */
    password: "input[type='password']",

    /* The list. */
    list_table: "table",
    list_row: "table tbody tr",
    list_search_open: "button",
    property_control: ".Select.select-async",
    property_input: ".Select-input input, input[role='combobox']",
    property_option: ".Select-option",
    search_button: "button.btn-primary",

    /* The new-inspection form. */
    new_form: "form.js-new-inspection-form",
    name_input: "input[name='new_inspection[inspection][name]']",
    date_input: "input[name='new_inspection[inspection][inspected_on]']",
    address_container: ".js-select2-search-inspectable",
    address_choice: ".select2-choice, a.select2-choice",
    address_search: ".select2-drop-active .select2-input, .select2-search .select2-input",
    address_result: ".select2-results li.select2-result-selectable",
    /* The results select2's highlight() counts, in its order (select2 3's
       findHighlightableChoices), and the input it is bound to, which holds the
       chosen place's id once one is picked. */
    address_pickable: ".select2-drop-active .select2-results li.select2-result-selectable:not(.select2-disabled):not(.select2-selected)",
    address_value: "input.js-inspectable-id",
    address_chosen: ".select2-chosen",
    address_kind_unit: ".sprite-unit",
    address_kind_property: ".sprite-property",
    layout_default: "input.js-layout-button[value='default']",
    start_button: "input.js-start-inspection, .js-start-inspection",

    /* An inspection. */
    title: ".js-inspection-title",
    address: ".js-inspection-address",
    area_card: ".card",
    area_name: ".js-area-name",
    area_name_input: "input.js-area-name-input",
    delete_area: ".js-delete-area",
    add_item: ".js-add-item",
    add_area_button: "button.btn-secondary",
    item: "li.js-item",
    item_name: ".js-item-name",
    item_name_input: "input.js-item-name-input",
    ok: ".js-check-circle",
    flag: ".js-flag",
    edit: ".js-edit-item",
    notes: "textarea.js-item-notes",
    file_input: "input[type='file']",
    save: ".js-item-save",
    cancel: ".js-item-cancel",
    delete_item: ".js-delete-item",
    description: ".js-item-description",
    photo_thumb: ".js-item-content button.rounded",
    mark_done: ".js-mark-complete-dropdown",
    /* A guess: a confirmation, if AppFolio asks for one. */
    dialog: ".modal.show, [role='dialog']",
    dialog_confirm: ".modal-footer .btn-primary, .modal-footer .btn-danger",
  };

  pm.TEXT = {
    signed_out_title: /sign in|log in/i,
    search_open: /click here to search/i,
    search: /^search$/i,
    add_area: /add area/i,
    mark_done: /mark inspection done/i,
    status_done: /^done$/i,
    chosen: /\bactive\b/,
    confirm: /^(yes|ok|confirm|delete|mark done|mark inspection done)$/i,
  };
})();
