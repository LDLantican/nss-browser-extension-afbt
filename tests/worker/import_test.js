/**
 * The AppFolio import (3.1.0, the web app's roadmap phase 8; 3.3.0, phase 10),
 * against the fake web app: which connection, what is sent, and what a refusal
 * looks like. Since 3.3.0 the page picks the connection — its host — and
 * names its company, which the web app checks. The
 * import's own rules are the web app's, proven in its
 * tests/integration/import_test.php; the page's scrape is in the browser-only
 * tests, except the one piece that is plain string work.
 */

import "../../content/appfolio_scrape.js";
import { create_imports, MAX_RECORDS, scope_of } from "../../worker/imports.js";
import { create_runtime } from "../../worker/runtime.js";
import { create_life, create_world } from "../support/fake_env.js";
import { create_fake_server } from "../support/fake_server.js";
import { registry, world_with_job } from "../support/scenario.js";

const MARKER = "This is a test work order approved by Dustin.";

/** Camelot's work-order list, as worker/index.js describes the page a message came from. */
const PAGE = { host: "camelotproperties.appfolio.com", company: "Camelot Properties, LLC" };

function record(i, extra = {}) {
  return {
    number: `1800${i}-1`,
    native_id: String(18000 + i),
    url: `https://camelot.appfolio.com/maintenance/service_requests/1800${i}/work_orders/${18000 + i}`,
    street: `${i} Elm St`,
    unit: "",
    city: "Huntsville",
    state: "AL",
    zip: "35801",
    description: `${MARKER} Job ${i}.`,
    ...extra,
  };
}

/** A signed-in browser's import, the way worker/index.js builds it. */
function imports_for(world) {
  const { env } = create_life(world);
  const runtime = create_runtime(env, registry());

  return create_imports({ client: runtime.rt.client });
}

export default {
  async "the page's host and company go with every request, and the web app picks the connection"(t) {
    const { world } = await world_with_job();
    const imports = imports_for(world);

    const answer = await imports.lookup(["18001-1"], { host: "CamelotProperties.AppFolio.com", company: "  Camelot   Properties, LLC " });
    t.ok(answer.ok, `the lookup failed: ${answer.error}`);
    t.equal(answer.connection, world.server.pm.slug);
    t.deep(
      { host: world.server.requests.at(-1).body.host, company: world.server.requests.at(-1).body.company },
      { host: "camelotproperties.appfolio.com", company: "Camelot Properties, LLC" },
      "the host was not lower-cased, or the company not tidied",
    );
    t.equal("connection" in world.server.requests.at(-1).body, false, "a connection the browser chose was sent");

    await imports.send([record(1)], PAGE);
    const sent = world.server.requests.find((r) => r.path === "/api/worker/imports").body;
    t.deep([sent.host, sent.company], [PAGE.host, PAGE.company], "the import did not carry the page");
    t.equal(world.server.requests.filter((r) => r.path === "/api/worker/claim").length, 0, "it claimed work to import");
  },

  async "a page on another AppFolio, or signed in to another company, is refused and says why"(t) {
    const { world } = await world_with_job();
    const imports = imports_for(world);

    const elsewhere = await imports.send([record(1)], { host: "otherpm.appfolio.com", company: PAGE.company });
    t.equal(elsewhere.reason, "unknown_host");

    const wrong = await imports.lookup(["18001-1"], { host: PAGE.host, company: "Somebody Else Properties" });
    t.equal(wrong.reason, "wrong_account");
    t.ok(wrong.error.includes("Somebody Else Properties"), wrong.error);

    const unread = await imports.lookup(["18001-1"], { host: PAGE.host, company: "" });
    t.equal(unread.reason, "account_unreadable");
    t.equal(world.server.imported.size, 0, "something was imported anyway");

    const before = world.server.requests.length;
    const nowhere = await imports.lookup(["18001-1"], { host: "", company: PAGE.company });
    t.equal(nowhere.reason, "unknown_host");
    t.equal(world.server.requests.length, before, "a page with no host was asked about anyway");
  },

  async "the lookup hands back the connection's mode, the jobs and legacy's open numbers"(t) {
    const { world } = await world_with_job();
    world.server.legacy.set("18002-1", true);

    const imports = imports_for(world);
    const sent = await imports.send([record(1)], PAGE);
    t.equal(sent.results[0].status, "created");

    const answer = await imports.lookup(["18001-1", "18002-1", "18003-1", "18001-1", " "], PAGE);

    t.deep(answer.scope, { mode: "sample", marker: MARKER }, "a test connection reads as sample mode to the page");
    t.equal(answer.work_orders["18001-1"].public_id, "WO-000001");
    t.equal(answer.legacy["18002-1"].status, "assigned");
    t.equal(answer.work_orders["18003-1"] ?? null, null);
    t.deep(world.server.requests.at(-1).body.numbers, ["18001-1", "18002-1", "18003-1"], "duplicates and blanks were sent");
  },

  async "records go a hundred at a time and every result names its record"(t) {
    const { world } = await world_with_job();
    const records = Array.from({ length: 150 }, (_, i) => record(i + 1));

    const answer = await imports_for(world).send(records, PAGE);

    t.ok(answer.ok);
    t.equal(world.server.requests.filter((r) => r.path === "/api/worker/imports").length, 2, "not two batches");
    t.equal(world.server.requests.filter((r) => r.path === "/api/worker/imports")[0].body.records.length, MAX_RECORDS);
    t.deep(answer.results.map((r) => r.index), records.map((_, i) => i), "results out of order, or missing");
    t.deep(answer.counts, { created: 150 });

    const again = await imports_for(world).send(records.slice(0, 3), PAGE);
    t.deep(again.counts, { unchanged: 3 }, "a second import made new jobs");
  },

  async "only the fields the web app reads are sent"(t) {
    const { world } = await world_with_job();

    await imports_for(world).send([record(1, { title: "ours", secret: "page state", unit: null })], PAGE);

    const sent = world.server.requests.find((r) => r.path === "/api/worker/imports").body.records[0];
    t.deep(Object.keys(sent).sort(), ["city", "description", "native_id", "number", "state", "street", "unit", "url", "zip"]);
    t.equal(sent.unit, "", "a null became something other than blank");
  },

  async "a connection that refuses says why, and nothing is reported as imported"(t) {
    const { world } = await world_with_job();
    world.server.pm.import_enabled = false;

    const answer = await imports_for(world).send([record(1), record(2)], PAGE);

    t.equal(answer.ok, false);
    t.equal(answer.reason, "import_disabled");
    t.ok(answer.error.includes("switched off"), answer.error);
    t.deep(answer.results, []);
    t.equal(answer.unsent, 2);
  },

  async "an outdated extension is told so"(t) {
    const { world } = await world_with_job();
    world.server.version = "9.9.9";

    const answer = await imports_for(world).lookup(["18001-1"], PAGE);

    t.equal(answer.reason, "outdated");
  },

  async "a browser that is not signed in is told to sign in"(t) {
    const world = create_world();
    world.server = create_fake_server(world, { version: world.version });

    const answer = await imports_for(world).lookup(["18001-1"], PAGE);

    t.equal(answer.ok, false);
    t.equal(answer.reason, "signed_out");
    t.equal(world.server.requests.length, 0, "it asked the web app anyway");
  },

  async "the page's scope shape: test is sample, live is live, anything else nothing"(t) {
    t.deep(scope_of({ scope: "test", marker: MARKER }), { mode: "sample", marker: MARKER });
    t.deep(scope_of({ scope: "live", marker: MARKER }), { mode: "live", marker: MARKER });
    t.equal(scope_of({ scope: "sample" }), null);
    t.equal(scope_of({}), null);
  },

  async "AppFolio's own id is read off the work order's address"(t) {
    const { native_id_of } = globalThis.nss;

    t.equal(native_id_of("https://camelot.appfolio.com/maintenance/service_requests/18094/work_orders/18662"), "18662");
    t.equal(native_id_of("https://camelot.appfolio.com/maintenance/service_requests/18094/work_orders/18662?tab=notes#x"), "18662");
    t.equal(native_id_of("https://camelot.appfolio.com/maintenance/service_requests/work_orders"), "");
    t.equal(native_id_of(""), "");
  },
};
