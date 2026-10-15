/**
 * Credentials and the outbox, against the fake web app.
 */

import { ACCESS_KEY, check_base, create_client, IDENTITY_KEY } from "../../worker/client.js";
import { NotSignedIn } from "../../worker/errors.js";
import { create_journal } from "../../worker/journal.js";
import { create_outbox, OUTBOX_KEY } from "../../worker/outbox.js";
import { create_life } from "../support/fake_env.js";
import { tick, world_with_job } from "../support/scenario.js";

export default {
  async "only https, or plain http on this machine"(t) {
    t.equal(check_base("https://alabamasignaturehomes.com/").base, "https://alabamasignaturehomes.com");
    t.equal(check_base("http://localhost/projects/alabamasignaturehomes").base, "http://localhost/projects/alabamasignaturehomes");
    t.equal(check_base("http://127.0.0.1:6789").base, "http://127.0.0.1:6789");
    t.equal(check_base("http://alabamasignaturehomes.com").base, null);
    t.equal(check_base("http://localhost.evil.example").base, null);
    t.equal(check_base("").base, null);
  },

  async "the device token lives in local storage, the access token only in session"(t) {
    const { world } = await world_with_job();

    await tick(world);

    t.ok(world.local.get(IDENTITY_KEY)?.device_token, "no device token kept");
    t.equal(world.local.get(ACCESS_KEY) ?? null, null, "an access token was written to local storage");
    t.ok(world.session.get(ACCESS_KEY)?.token, "no access token in session storage");
  },

  async "an access token is reused while it lasts and renewed before it runs out"(t) {
    const { world } = await world_with_job();
    const exchanges = () => world.server.requests.filter((r) => r.path === "/api/worker/token").length;

    await tick(world);
    const first = exchanges();

    world.clock.ms += 30 * 60000;
    await tick(world);
    t.equal(exchanges(), first, "renewed a token with half an hour left");

    world.clock.ms += 29 * 60000;
    await tick(world);
    t.equal(exchanges(), first + 1, "kept a token with a minute left");
  },

  async "a refused access token is renewed once and the call repeated"(t) {
    const { world } = await world_with_job();

    await tick(world);
    world.server.tokens.forEach((token) => {
      if (token.kind === "access") token.expires_ms = 0;
    });

    const { env } = create_life(world);
    const answer = await create_client(env).heartbeat({ processing_enabled: true, sessions: [] });

    t.equal(answer.status, 200);
  },

  async "a retired device signs the browser out"(t) {
    const { world } = await world_with_job();

    await tick(world);
    world.server.workers.forEach((worker) => {
      worker.retired = true;
    });
    world.session.clear();

    const { env } = create_life(world);

    try {
      await create_client(env).claim();
      t.fail("a retired device was let in");
    } catch (error) {
      t.ok(error instanceof NotSignedIn, String(error));
      t.equal(error.reason, "retired");
    }

    t.equal(world.local.get(IDENTITY_KEY) ?? null, null, "the retired identity was kept");
  },

  async "a report survives an unreachable web app and is sent once it answers"(t) {
    const { world, delivery } = await world_with_job();
    const { env } = create_life(world);
    const client = create_client(env);
    const outbox = create_outbox(env, client, create_journal(env));
    const claimed = await client.heartbeat({ processing_enabled: true, adapter_versions: { fixture: "1.0.0" }, sessions: [{ connection: "fixture-test", state: "live" }] })
      .then(() => client.claim());
    const uuid = crypto.randomUUID();
    const report = { uuid, delivery_id: delivery.id, kind: "fail", body: { claim_token: claimed.body.claim_token, attempt_uuid: uuid, error_class: "transient", message: "x" } };

    await outbox.add(report);
    await outbox.add(report);
    t.equal(world.local.get(OUTBOX_KEY).length, 1, "the same report was queued twice");

    const reachable = world.server.handle;

    world.server.handle = () => {
      throw new Error("offline");
    };
    await outbox.flush();
    t.equal(world.local.get(OUTBOX_KEY).length, 1, "a report was dropped while the web app was unreachable");

    world.server.handle = reachable;
    await outbox.flush();
    t.equal(world.local.get(OUTBOX_KEY).length, 0);
    t.equal(delivery.status, "retry_scheduled");

    /* Sent again (a lost answer), it gets the same answer. */
    const again = await client.fail(delivery.id, report.body);

    t.equal(again.status, 200);
    t.equal(again.body.status, "retry_scheduled");
  },
};
