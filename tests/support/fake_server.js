/**
 * The worker API, in memory, for tests that cannot reach a web app.
 *
 * It follows the contract in the web app's docs/worker-api.md — the claim and
 * its lease, the commit point, verification, the reaper, idempotent reports,
 * and decide()'s table of what each failure leads to — closely enough that the
 * runtime cannot tell it from the real thing on the paths it uses. It is not
 * the real thing: tests/e2e.mjs runs the same kill loop against the web app
 * itself, and that run is the one that proves acceptance. This one makes every
 * kill point cheap enough to try every time the tests run, in Node and in the
 * extension's own test page.
 */

const FLAGS = {
  accept: { idempotent: true, verifiable: true, negative_verify_trusted: true },
  post_photos: { idempotent: false, verifiable: true, negative_verify_trusted: true },
  submit_invoice: { idempotent: false, verifiable: true, negative_verify_trusted: false },
  mark_work_done: { idempotent: true, verifiable: true, negative_verify_trusted: true },
};

/** A photograph's bytes, made up from its id, so a test can see which one went where. */
export function photo_bytes(file_id) {
  return new Uint8Array([0xff, 0xd8, 0xff, Number(file_id) % 256, 0xff, 0xd9]);
}

export function create_fake_server(world, { version = "test", lease_s = 120, user = {} } = {}) {
  const person = { id: 1, name: "Test Worker", email: "worker@example.test", password: "secret", can_deliver: true, ...user };

  const server = {
    person,
    version,
    lease_ms: lease_s * 1000,
    tokens: new Map(),
    workers: new Map(),
    connection: {
      id: 1,
      slug: "fixture-test",
      name: "Fixture (test)",
      platform: "appfolio",
      role: "vendor",
      adapter: "fixture",
      enabled: true,
      paused: false,
      scope: "test",
      dry_run: false,
      auto_submit: true,
      on_over_limit: "block",
      cap: 2,
    },
    /**
     * The property manager's AppFolio, for the import (phase 8). It is listed
     * by the heartbeat like any connection and never claimable (no delivery
     * runs on it); imports and their lookup go through it.
     */
    pm: {
      id: 2,
      slug: "camelot-pm-test",
      name: "Camelot AppFolio (test)",
      platform: "appfolio",
      role: "pm",
      adapter: "appfolio_pm",
      enabled: true,
      paused: false,
      import_enabled: true,
      scope: "test",
    },
    marker: "This is a test work order approved by Dustin.",
    /** number => the job an import made, and numbers legacy still has open. */
    imported: new Map(),
    legacy: new Map(),
    next_job: 1,
    killed_adapters: [],
    deliveries: [],
    reports: new Map(),
    requests: [],
    next_worker: 1,
    next_delivery: 1,

    now: () => world.clock.ms,

    /** A waiting delivery, as Approve would queue it. */
    enqueue({ operation = "submit_invoice", public_id = "WO-000001", payload = null, expected_total_cents = null, depends_on = null, part = 1, link = null } = {}) {
      const delivery = {
        id: server.next_delivery++,
        entity: { type: "work_order", id: server.next_delivery, public_id, version: 1 },
        operation,
        status: "pending",
        attempt_count: 0,
        max_attempts: 5,
        committed_at: null,
        worker_id: null,
        token: null,
        lease_ms: null,
        next_ms: server.now(),
        payload,
        snapshot: null,
        expected_total_cents,
        depends_on,
        part,
        link,
        history: [],
      };

      server.deliveries.push(delivery);

      return delivery;
    },

    delivery: (id) => server.deliveries.find((delivery) => delivery.id === id) || null,

    /** The reaper (docs/worker-api.md, "The reaper"). */
    sweep() {
      for (const d of server.deliveries) {
        if (!["claimed", "committing"].includes(d.status) || d.lease_ms >= server.now()) continue;

        const spent = d.attempt_count >= d.max_attempts;

        if (d.status === "committing") move(d, "outcome_unknown");
        else if (d.committed_at !== null) move(d, spent ? "needs_manual" : "outcome_unknown");
        /* Backed off, as the web app's reaper does: a random wait up to 30 s
           on the first attempt. */
        else move(d, spent ? "needs_manual" : "retry_scheduled", { next_ms: server.now() + Math.floor(Math.random() * 30000) });
      }
    },

    handle(method, path, headers, text) {
      const body = text && method !== "GET" ? JSON.parse(text) : {};

      server.requests.push({ method, path, body });

      const answer = route(path, headers, body);

      if (answer[1]?.bytes) return { status: answer[0], ...answer[1] };

      return { status: answer[0], body: answer[1] ?? {} };
    },
  };

  function move(d, status, fields = {}) {
    d.history.push(`${d.status}->${status}`);
    d.status = status;
    d.token = null;
    d.worker_id = ["claimed", "committing"].includes(status) ? d.worker_id : null;
    Object.assign(d, fields);
  }

  /**
   * The import's two endpoints (docs/worker-api.md, "Importing"): the
   * connection's gates, its scope by the marker, created or unchanged by
   * number, legacy refused. Enough of the web app's rules for the extension
   * to be unable to tell; the rules themselves are proven in the web app's
   * tests/integration/import_test.php.
   */
  function imports(path, body) {
    const pm = server.pm;

    if (body.connection !== pm.slug) return [422, { error: `There is no connection called “${body.connection}”.` }];
    if (!pm.enabled) return [409, { error: `${pm.name} is switched off.`, reason: "connection_disabled" }];
    if (!pm.import_enabled) return [409, { error: `Importing is switched off for ${pm.name}.`, reason: "import_disabled" }];

    const job = (number) => server.imported.get(number);

    if (path.endsWith("/lookup")) {
      const work_orders = {};
      const legacy = {};

      for (const number of body.numbers || []) {
        if (job(number)) work_orders[number] = job(number);
        else if (server.legacy.has(number)) legacy[number] = { status: "assigned", status_label: "Assigned" };
      }

      return [200, { connection: pm.slug, scope: pm.scope, marker: server.marker, work_orders, legacy }];
    }

    if (!Array.isArray(body.records)) return [400, { error: "Send the work orders as a list." }];
    if (body.records.length > 100) return [413, { error: "Send at most 100.", max: 100 }];

    const counts = {};
    const results = body.records.map((record, index) => {
      const number = String(record?.number || "");
      const marked = String(record?.description || "").includes(server.marker);
      let result;

      if (number === "" || String(record?.street || "") === "") result = { status: "invalid", errors: ["Number and Street are required."] };
      else if (marked !== (pm.scope === "test")) result = { status: "out_of_scope", errors: ["Not this connection's mode."] };
      else if (job(number)) result = { status: "unchanged", work_order: job(number) };
      else if (server.legacy.has(number)) result = { status: "legacy", errors: [`Work order ${number} is still open in the legacy system.`] };
      else {
        const public_id = `WO-${String(server.next_job++).padStart(6, "0")}`;

        server.imported.set(number, { id: server.next_job, public_id, status: "unassigned", status_label: "Unassigned", subcontractor: null, lines: 0, record });
        result = { status: "created", work_order: job(number) };
      }

      counts[result.status] = (counts[result.status] || 0) + 1;

      return { index, number, ...result };
    });

    return [200, { connection: pm.slug, scope: pm.scope, results, counts }];
  }

  function bearer(headers) {
    const value = headers.Authorization || headers.authorization || "";

    return value.startsWith("Bearer ") ? value.slice(7) : "";
  }

  function token(kind, worker_id, ttl_ms) {
    const value = `${kind}-${crypto.randomUUID()}`;

    server.tokens.set(value, { kind, worker_id, expires_ms: ttl_ms === null ? null : server.now() + ttl_ms });

    return value;
  }

  function worker_of(headers) {
    const held = server.tokens.get(bearer(headers));

    if (!held || held.kind !== "access") return null;
    if (held.expires_ms !== null && held.expires_ms < server.now()) return null;

    const worker = server.workers.get(held.worker_id);

    return worker && !worker.retired ? worker : null;
  }

  function reason_for(worker) {
    const c = server.connection;

    if (!worker.processing) return "processing_off";
    if (!person.can_deliver) return "not_permitted";
    if (!c.enabled) return "connection_disabled";
    if (c.paused) return "connection_paused";
    if (worker.sessions[c.slug] !== "live") return "session_not_live";

    const version = worker.adapters[c.adapter];

    if (!version) return "adapter_not_reported";
    if (server.killed_adapters.some((k) => k.adapter === c.adapter && k.version === version)) return "adapter_killed";

    return null;
  }

  function held(worker, d, claim_token) {
    return d && d.worker_id === worker.id && d.token === claim_token && ["claimed", "committing"].includes(d.status);
  }

  function claim(worker) {
    server.sweep();

    if (reason_for(worker) !== null) return [204];

    const running = server.deliveries.filter((d) => ["claimed", "committing"].includes(d.status)).length;

    if (running >= server.connection.cap) return [204];

    const due = server.deliveries
      .filter((d) => ["pending", "retry_scheduled", "outcome_unknown"].includes(d.status) && d.next_ms <= server.now())
      .filter((d) => d.depends_on === null || server.delivery(d.depends_on)?.status === "succeeded")
      .sort((a, b) => a.next_ms - b.next_ms || a.id - b.id);

    for (const d of due) {
      if (d.attempt_count >= d.max_attempts) {
        move(d, "needs_manual");
        continue;
      }

      const verify = d.committed_at !== null;
      const claim_token = crypto.randomUUID().replace(/-/g, "");

      d.attempt_count++;
      move(d, "claimed", { worker_id: worker.id, token: claim_token, lease_ms: server.now() + server.lease_ms });
      d.worker_id = worker.id;
      d.token = claim_token;

      if (!verify) d.snapshot = d.payload;

      const c = server.connection;

      return [
        200,
        {
          delivery_id: d.id,
          claim_token,
          mode: verify ? "verify" : "execute",
          operation: d.operation,
          part: d.part,
          attempt: d.attempt_count,
          max_attempts: d.max_attempts,
          flags: FLAGS[d.operation] || {},
          entity: { ...d.entity },
          connection: {
            id: c.id, slug: c.slug, platform: c.platform, role: c.role, adapter: c.adapter, scope: c.scope,
            dry_run: c.dry_run, auto_submit: c.auto_submit, on_over_limit: c.on_over_limit,
          },
          link: d.link || { id: d.id, namespace: "", external_id: null, number: d.entity.public_id, url: null, status: "pending" },
          payload: verify ? d.snapshot : d.payload,
          payload_hash: `hash-${d.id}`,
          expected_total_cents: d.expected_total_cents,
          lease_expires_at: "(database clock)",
          lease_s: server.lease_ms / 1000,
        },
      ];
    }

    return [204];
  }

  /** decide(), as the web app's WorkerQueue has it. */
  function decide(d, error_class) {
    const verify = d.status === "claimed" && d.committed_at !== null;
    const trusted = (FLAGS[d.operation] || {}).negative_verify_trusted === true;
    const left = d.attempt_count < d.max_attempts;
    const refund = ["permission", "session_expired"].includes(error_class);

    if (d.status === "committing") return { to: "outcome_unknown", refund: false };

    if (verify)
      switch (error_class) {
        case "verified_absent":
          return trusted && left ? { to: "retry_scheduled", refund, clear: true } : { to: "needs_manual", refund };
        case "permission":
        case "session_expired":
          return { to: "outcome_unknown", refund };
        case "transient":
        case "unknown_outcome":
          return left ? { to: "outcome_unknown", refund, backoff: true } : { to: "needs_manual", refund };
        default:
          return { to: "needs_manual", refund };
      }

    switch (error_class) {
      case "transient":
        return left ? { to: "retry_scheduled", refund, backoff: true } : { to: "needs_manual", refund };
      case "permission":
      case "session_expired":
        return { to: "retry_scheduled", refund };
      case "unknown_outcome":
        return { to: "outcome_unknown", refund, set: true };
      default:
        return { to: "needs_manual", refund };
    }
  }

  function report(worker, d, body, kind) {
    const uuid = body.attempt_uuid;
    const replay = server.reports.get(uuid);

    if (replay) return replay.delivery_id === d?.id ? replay.answer : [409, { reason: "uuid_reused" }];

    if (!held(worker, d, body.claim_token)) return [409, { reason: "not_held", error: "Not held." }];

    let answer;

    if (kind === "complete") {
      move(d, "succeeded");
      answer = [200, { delivery_id: d.id, status: "succeeded", outcome: "succeeded", note: null }];
    } else {
      const verify = d.status === "claimed" && d.committed_at !== null;

      if (body.error_class === "verified_absent" && !verify) return [422, { error: "verified_absent is only for a verification." }];

      const decision = decide(d, body.error_class);

      if (decision.refund) d.attempt_count = Math.max(0, d.attempt_count - 1);

      const fields = {};

      if (decision.clear) fields.committed_at = null;
      if (decision.set) fields.committed_at = server.now();
      if (decision.backoff) fields.next_ms = server.now() + 30000;
      else if (decision.to !== "needs_manual") fields.next_ms = server.now();

      move(d, decision.to, fields);
      d.last_error = body.error_class;
      answer = [200, { delivery_id: d.id, status: decision.to, outcome: body.error_class, note: null }];
    }

    server.reports.set(uuid, { delivery_id: d.id, answer });

    return answer;
  }

  function route(path, headers, body) {
    const gated = () => (headers["X-Extension-Version"] !== server.version ? [426, { error: "Update the extension." }] : null);

    if (path === "/api/worker/register") {
      if (body.email !== person.email || body.password !== person.password) return [401, { error: "Those details are not right." }];

      const worker = { id: server.next_worker++, processing: true, sessions: {}, adapters: {}, retired: false };

      server.workers.set(worker.id, worker);

      return [
        201,
        {
          worker_id: worker.id,
          worker_uuid: crypto.randomUUID(),
          device_name: body.device_name || "",
          device_token: token("device", worker.id, null),
          user: { id: person.id, name: person.name, email: person.email },
        },
      ];
    }

    if (path === "/api/worker/token") {
      const held_token = server.tokens.get(bearer(headers));
      const worker = held_token?.kind === "device" ? server.workers.get(held_token.worker_id) : null;

      if (!worker || worker.retired) return [401, { error: "Unauthorized." }];

      return [200, { access_token: token("access", worker.id, 3600000), expires_in: 3600, worker_id: worker.id }];
    }

    const worker = worker_of(headers);

    if (!worker) return [401, { error: "Unauthorized." }];

    if (path === "/api/worker/heartbeat") {
      if (typeof body.processing_enabled === "boolean") worker.processing = body.processing_enabled;

      worker.adapters = body.adapter_versions || {};

      for (const s of body.sessions || []) worker.sessions[s.connection] = ["live", "expired"].includes(s.state) ? s.state : "unknown";

      const c = server.connection;
      const reason = reason_for(worker);

      return [
        200,
        {
          worker_id: worker.id,
          processing_enabled: worker.processing,
          poll_interval_s: 60,
          killed_adapters: server.killed_adapters,
          unknown_connections: [],
          connections: [
            {
              id: c.id, slug: c.slug, name: c.name, adapter: c.adapter, enabled: c.enabled, paused: c.paused,
              scope: c.scope, dry_run: c.dry_run, auto_submit: c.auto_submit, claimable: reason === null, reason,
            },
            {
              id: server.pm.id, slug: server.pm.slug, name: server.pm.name, adapter: server.pm.adapter,
              enabled: server.pm.enabled, paused: server.pm.paused, scope: server.pm.scope,
              dry_run: true, auto_submit: false, claimable: false, reason: "adapter_not_reported",
            },
          ],
        },
      ];
    }

    if (path === "/api/worker/claim") return gated() || (person.can_deliver ? claim(worker) : [403, {}]);

    if (path === "/api/worker/imports" || path === "/api/worker/imports/lookup")
      return gated() || (person.can_create === false ? [403, { error: "No." }] : imports(path, body));

    /* A held note's photograph (phase 9): bytes, to the holder only. */
    const photo = /^\/api\/worker\/deliveries\/(\d+)\/photos\/(\d+)$/.exec(path);

    if (photo) {
      const refused = gated();

      if (refused) return refused;

      const d = server.delivery(Number(photo[1]));
      const file_id = Number(photo[2]);
      const named = (d?.snapshot?.photos || []).some((p) => p.id === file_id);

      if (!held(worker, d, headers["X-Claim-Token"]) || d.lease_ms < server.now() || d.operation !== "post_photos" || !named)
        return [404, { error: "No such file." }];

      server.photos_served = (server.photos_served || 0) + 1;

      return [200, { bytes: photo_bytes(file_id), mime_type: "image/jpeg", name: `photo-${file_id}.jpg` }];
    }

    const match = /^\/api\/worker\/deliveries\/(\d+)\/(\w+)$/.exec(path);

    if (!match) return [404, { error: "Not found." }];

    const d = server.delivery(Number(match[1]));
    const action = match[2];

    if (action === "touch") {
      const refused = gated();

      if (refused) return refused;
      if (!held(worker, d, body.claim_token) || d.lease_ms < server.now()) return [409, { reason: "not_held" }];

      d.lease_ms = server.now() + server.lease_ms;

      return [200, { delivery_id: d.id, lease_expires_at: "(database clock)" }];
    }

    if (action === "commit") {
      const refused = gated();

      if (refused) return refused;
      if (!held(worker, d, body.claim_token)) return [409, { reason: "not_held" }];
      if (d.status === "committing") return [200, { delivery_id: d.id, status: "committing" }];
      if (d.committed_at !== null) return [409, { reason: "verify_mode" }];
      if (d.lease_ms < server.now()) return [409, { reason: "lease_expired" }];
      if (!server.connection.enabled || server.connection.paused) return [409, { reason: "connection_paused", error: "Paused." }];

      d.history.push("claimed->committing");
      d.status = "committing";
      d.committed_at = server.now();
      d.lease_ms = server.now() + server.lease_ms;

      return [200, { delivery_id: d.id, status: "committing" }];
    }

    if (action === "complete") return report(worker, d, body, "complete");

    if (action === "fail") return report(worker, d, body, "fail");

    if (action === "release") {
      if (!held(worker, d, body.claim_token)) return [409, { reason: "not_held" }];
      if (d.status === "committing") return [409, { reason: "committed", error: "Report instead." }];

      d.attempt_count = Math.max(0, d.attempt_count - 1);
      move(d, d.committed_at !== null ? "outcome_unknown" : "retry_scheduled", { next_ms: server.now() });

      return [200, { delivery_id: d.id, status: d.status }];
    }

    return [404, { error: "Not found." }];
  }

  return server;
}
