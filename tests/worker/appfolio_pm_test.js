/**
 * The appfolio_pm adapter (roadmap phase 12), against the fake web app and a
 * pretend property-manager AppFolio kept in the same books the pretend pages
 * use (adapters/appfolio_pm/site/books.js).
 *
 * Two halves. The rules: a create is searched for before it is made and made
 * once, on the right property, with ASH's number in its name; a fill makes
 * AppFolio's areas and items ASH's — adding what was added on site, removing
 * only what is blank, answering and noting every item — and does nothing a
 * second time; photographs are counted before and after, never uploaded
 * twice; Mark Inspection Done is pressed once. And the refusals: a live
 * inspection on a test connection, a page whose title does not carry ASH's
 * number or the test mark, a count of photographs nobody can account for.
 *
 * Then the acceptance: the kill loop over all four operations, at least 100
 * runs each — killed after every single operation of a job, then twice at
 * random — and with the browser closed instead. Every run must end succeeded
 * with AppFolio holding each thing exactly once: every one of these
 * operations trusts its negative, so none may need a person.
 */

import { reconcile, SESSION_KEY } from "../../adapters/appfolio_pm/adapter.js";
import { by_id, DONE, find_area, find_item, save_item } from "../../adapters/appfolio_pm/site/books.js";
import { leftovers, PM_HEADER, PM_TAG, pm_areas, pm_world, reports, seeded, settle, tick } from "../support/scenario.js";

const OPERATIONS = ["create", "fill_areas", "post_photos", "mark_done"];
const RUNS = 100;

/** The inspection a create made, or the one the step worked on. */
function target(world, inspection) {
  return inspection ? by_id(world.pm, inspection.id) : Object.values(world.pm.inspections).find((i) => i.name.includes(PM_TAG)) || null;
}

function sheet(found) {
  return { status: found.status, areas: found.areas.map((a) => ({ name: a.name, items: a.items.map(({ name, result, note, photos }) => ({ name, result, note, photos })) })) };
}

async function operations_in_a_job(operation) {
  const { world } = await pm_world({ operation });
  const { life } = await tick(world);

  return life.ops;
}

/** Did AppFolio end up holding the thing once, and only once? */
function judge(t, world, inspection, delivery, operation, label) {
  const left = leftovers(world);
  const found = target(world, inspection);

  t.equal(left.job, false, `${label}: a job was left in hand`);
  t.equal(left.outbox, 0, `${label}: reports were left unsent`);
  t.equal(delivery.status, "succeeded", `${label}: ended ${delivery.status} (${delivery.last_error})`);

  switch (operation) {
    case "create": {
      const made = Object.values(world.pm.inspections).filter((i) => i.name.includes(PM_TAG));

      t.equal(world.pm.creates, 1, `${label}: AppFolio was made to create ${world.pm.creates} inspections`);
      t.equal(made.length, 1, `${label}: ${made.length} inspections carry ${PM_TAG}`);
      t.equal(reports(world, delivery).at(-1)?.identity?.id, made[0]?.id, `${label}: the identity reported is not the inspection`);
      break;
    }

    case "fill_areas":
      t.equal(reconcile(sheet(found), pm_areas()).length, 0, `${label}: AppFolio still differs from ASH`);
      t.equal(found.areas.filter((a) => a.name === "Exterior").length, 1, `${label}: Exterior added ${found.areas.filter((a) => a.name === "Exterior").length} times`);
      t.equal(found.area_adds, 1, `${label}: ${found.area_adds} areas added`);
      t.equal(found.item_adds, 2, `${label}: ${found.item_adds} items added`);
      break;

    case "post_photos":
      t.equal(found.uploads, 1, `${label}: the photographs were uploaded ${found.uploads} times`);
      t.equal(find_item(find_area(found, "Kitchen"), "Sink").photos, 3, `${label}: the sink shows the wrong number of photographs`);
      break;

    case "mark_done":
      t.ok(found.done_presses <= 1, `${label}: Mark Inspection Done was pressed ${found.done_presses} times`);
      t.equal(found.status, DONE, `${label}: not done`);
      break;

    default:
      t.fail(`${label}: unknown operation`);
  }

  return delivery.history.some((h) => h.endsWith("->outcome_unknown")) ? "succeeded after verification" : "succeeded";
}

async function kill_loop(t, operation) {
  const total = await operations_in_a_job(operation);
  const random = seeded(29 + operation.length);
  const tally = {};
  let runs = 0;

  const run = async (kills, label) => {
    const { world, delivery, inspection } = await pm_world({ operation });

    for (const after of kills) {
      const { outcome } = await tick(world, { kill_after: after });

      if (outcome !== "killed") break;
    }

    await settle(world, delivery, 20);

    const ended = judge(t, world, inspection, delivery, operation, label);

    tally[ended] = (tally[ended] || 0) + 1;
    runs++;
  };

  for (let k = 1; k <= total; k++) await run([k], `${operation}, killed after operation ${k}`);

  while (runs < RUNS) {
    const first = 1 + Math.floor(random() * total);
    const second = 1 + Math.floor(random() * total);

    await run([first, second], `${operation}, killed after ${first} then ${second}`);
  }

  return { total, runs, tally };
}

export default {
  // -- create ---------------------------------------------------------------------

  async "a create is searched for, then made once on the property, named with ASH's number"(t) {
    const { world, delivery } = await pm_world();

    const run = await tick(world);
    const made = Object.values(world.pm.inspections);

    t.equal(delivery.status, "succeeded");
    t.equal(world.pm.creates, 1);
    t.equal(made[0].name, PM_HEADER.name);
    t.equal(made[0].date, PM_HEADER.inspected_on);
    t.equal(made[0].street, "415 Boyce", "chosen at the unit, not a resident");
    t.deep(reports(world, delivery)[0].identity, { id: made[0].id, url: `https://camelotproperties.appfolio.com/inspections/${made[0].id}` });
    t.ok(run.life.trace.indexOf("page.send:find_in_list") < run.life.trace.indexOf("page.send:start"), "the list was not searched before Start Inspection");
  },

  async "an inspection already in AppFolio is found on the list, linked, and not made again"(t) {
    const { world, delivery } = await pm_world();

    await tick(world);

    const first = Object.values(world.pm.inspections)[0];

    /* The same delivery again, as a create whose answer was lost would come back. */
    world.pm.creates = 0;
    delivery.status = "pending";
    delivery.committed_at = null;
    delivery.attempt_count = 0;

    const run = await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(world.pm.creates, 0, "made a second inspection");
    t.equal(run.life.trace.includes("page.send:start"), false);
    t.equal(reports(world, delivery).at(-1).identity.id, first.id, "the one found is not the one linked");
    t.equal([...world.tabs.values()].filter((tab) => tab.opener !== null).length, 0, "the tab the list opened was left open");
  },

  async "a live inspection on a test connection is refused before anything is typed"(t) {
    const { world, delivery } = await pm_world({ payload: { inspection: { ...PM_HEADER, is_test: false, name: `415 Boyce · ${PM_TAG}` } } });

    const run = await tick(world);

    t.equal(delivery.status, "needs_manual");
    t.equal(delivery.last_error, "permanent");
    t.equal(world.pm.creates, 0);
    t.equal(run.life.trace.includes("page.send:fill_new"), false);
  },

  async "a property AppFolio cannot find goes to a person, and nothing is made"(t) {
    const { world, delivery } = await pm_world({ payload: { inspection: { ...PM_HEADER, street: "1 Nowhere Lane" } } });

    await settle(world, delivery, 30);

    t.equal(world.pm.creates, 0);
    t.equal(delivery.status, "needs_manual");
  },

  // -- fill_areas -----------------------------------------------------------------

  async "a fill makes AppFolio's areas ASH's: added, removed only while blank, every item answered"(t) {
    const { world, delivery, inspection } = await pm_world({ operation: "fill_areas" });

    await tick(world);

    const found = by_id(world.pm, inspection.id);

    t.equal(delivery.status, "succeeded");
    t.deep(found.areas.map((a) => a.name), ["Kitchen", "Living Room", "Bedroom 1", "Bathroom 1", "Compliance", "Exterior"]);
    t.deep(find_item(find_area(found, "Kitchen"), "Sink"), { ...find_item(find_area(found, "Kitchen"), "Sink"), result: "follow_up", note: "Drips under the trap" });
    t.equal(find_item(find_area(found, "Bathroom 1"), "Shower/Tub"), null, "a blank item ASH does not have was left");
    t.equal(find_item(find_area(found, "Exterior"), "Siding").result, "follow_up");
    t.equal(reconcile(sheet(found), pm_areas()).length, 0);
  },

  async "a fill that is already done changes nothing"(t) {
    const first = await pm_world({ operation: "fill_areas" });

    await tick(first.world);

    const found = by_id(first.world.pm, first.inspection.id);
    const saves = found.saves;

    first.delivery.status = "pending";
    first.delivery.committed_at = null;

    const run = await tick(first.world);

    t.equal(first.delivery.status, "succeeded");
    t.equal(found.saves, saves, "saved again");
    t.equal(run.life.trace.some((name) => /page\.send:(set_item|add_item|add_area)/.test(name)), false);
  },

  async "an item with something in it that ASH does not have is left alone"(t) {
    const { world, delivery, inspection } = await pm_world({ operation: "fill_areas" });
    const found = by_id(world.pm, inspection.id);

    /* A person flagged the second bedroom's window in AppFolio by hand. */
    save_item(world.pm, inspection.id, find_item(find_area(found, "Bedroom 2"), "Windows").id, { result: "follow_up", note: "Cracked" });

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.ok(find_area(found, "Bedroom 2"), "an area with an answer in it was deleted");
    t.equal(find_item(find_area(found, "Bedroom 2"), "Windows").note, "Cracked");
  },

  // -- post_photos ----------------------------------------------------------------

  async "photographs are attached to their item and saved once"(t) {
    const { world, delivery, inspection } = await pm_world({ operation: "post_photos" });

    await tick(world);

    const found = by_id(world.pm, inspection.id);

    t.equal(delivery.status, "succeeded");
    t.equal(found.uploads, 1);
    t.equal(find_item(find_area(found, "Kitchen"), "Sink").photos, 3);
    t.equal(world.server.photos_served, 3);
  },

  async "photographs already on the item are found by their count, not uploaded twice"(t) {
    const { world, delivery, inspection } = await pm_world({ operation: "post_photos" });
    const found = by_id(world.pm, inspection.id);

    save_item(world.pm, inspection.id, find_item(find_area(found, "Kitchen"), "Sink").id, { photos: 3 });

    await tick(world);

    t.equal(delivery.status, "succeeded");
    t.equal(found.uploads, 1);
    t.equal(world.server.photos_served || 0, 0);
  },

  async "a count of photographs nobody can account for goes to a person"(t) {
    const { world, delivery, inspection } = await pm_world({ operation: "post_photos" });
    const found = by_id(world.pm, inspection.id);

    save_item(world.pm, inspection.id, find_item(find_area(found, "Kitchen"), "Sink").id, { photos: 1 });

    await tick(world);

    t.equal(delivery.status, "needs_manual");
    t.equal(found.uploads, 1, "uploaded on top of an unexplained photograph");
  },

  // -- mark_done ------------------------------------------------------------------

  async "Mark Inspection Done is pressed once, and a done inspection is left alone"(t) {
    const first = await pm_world({ operation: "mark_done" });

    await tick(first.world);

    t.equal(first.delivery.status, "succeeded");
    t.equal(by_id(first.world.pm, first.inspection.id).done_presses, 1);
    t.equal(by_id(first.world.pm, first.inspection.id).status, DONE);

    const second = await pm_world({ operation: "mark_done" });

    by_id(second.world.pm, second.inspection.id).status = DONE;
    await tick(second.world);

    t.equal(second.delivery.status, "succeeded");
    t.equal(by_id(second.world.pm, second.inspection.id).done_presses, 0);
  },

  async "a page whose title lacks ASH's number or the test mark is refused"(t) {
    const unmarked = await pm_world({ operation: "mark_done" });

    by_id(unmarked.world.pm, unmarked.inspection.id).name = `415 Boyce · ${PM_TAG}`;
    await tick(unmarked.world);

    t.equal(unmarked.delivery.status, "needs_manual");
    t.equal(by_id(unmarked.world.pm, unmarked.inspection.id).done_presses, 0);

    const other = await pm_world({ operation: "mark_done" });

    by_id(other.world.pm, other.inspection.id).name = "415 Boyce · INS-000099 · TEST";
    await tick(other.world);

    t.equal(other.delivery.status, "needs_manual");
    t.equal(by_id(other.world.pm, other.inspection.id).done_presses, 0);
  },

  // -- The session ----------------------------------------------------------------

  async "the session is probed on the connection's own AppFolio, and a signed-out one is reported expired"(t) {
    const { world } = await pm_world({ operation: "mark_done" });

    world.pm.signed_in = false;
    world.local.delete(SESSION_KEY);
    world.clock.ms += 5 * 60 * 1000;

    await tick(world);

    const beats = world.server.requests.filter((r) => r.path === "/api/worker/heartbeat");
    const last = beats.at(-1).body.sessions.find((s) => s.connection === "appfolio-camelot-pm-test");

    t.equal(last?.state, "expired");
  },

  // -- The acceptance -------------------------------------------------------------

  async "killing the worker after any operation never creates, adds, uploads or marks done twice"(t) {
    for (const operation of OPERATIONS) {
      const { total, runs, tally } = await kill_loop(t, operation);

      t.ok(runs >= RUNS, `${operation}: only ${runs} runs`);
      t.ok(total >= 10, `${operation}: a job should take more than ${total} operations`);

      globalThis.__kill_loop_report?.push({ operation: `appfolio_pm ${operation}`, total, runs, tally });
    }
  },

  async "closing the browser at any point of any operation is recovered when the lease runs out"(t) {
    for (const operation of OPERATIONS) {
      const total = await operations_in_a_job(operation);

      for (let k = 1; k <= total; k++) {
        const { world, delivery, inspection } = await pm_world({ operation });
        const { outcome } = await tick(world, { kill_after: k });

        if (outcome === "killed") {
          world.close_browser();
          world.clock.ms += 121000;
        }

        await settle(world, delivery, 20);
        judge(t, world, inspection, delivery, operation, `${operation}, browser closed after operation ${k}`);
      }
    }
  },
};
