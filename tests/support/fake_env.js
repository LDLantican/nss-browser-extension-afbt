/**
 * A fake Chrome for the worker, that can be killed at any point.
 *
 * The runtime touches the outside only through `env` (worker/chrome_env.js).
 * This one keeps that outside in a **world** that outlives any one service
 * worker — the two storage areas, the tabs, the fixture site's books, the
 * clock, and either the fake web app or the real one — and hands out an `env`
 * per worker life.
 *
 * ## Killing a service worker
 *
 * Every call the runtime makes through `env` is an operation, and a life can
 * be told to die after its k-th. The k-th operation **completes** — the write
 * lands, the request reaches the server, the button is pressed — and then
 * neither it nor anything after it ever returns: every promise the runtime is
 * awaiting stays pending for ever, exactly as code in a terminated worker
 * never resumes. A test then starts a new life on the same world. Dying after
 * an operation rather than before covers both: "before op k+1" is "after op k".
 *
 * Storage values are cloned going in and coming out, as chrome.storage
 * serializes them, so a job the runtime mutates after saving is not quietly
 * saved for it.
 *
 * `close_browser()` is the other kind of death: `storage.session` and every
 * tab are gone, `storage.local` stays.
 */

import { empty_site } from "../../adapters/fixture/site/ledger.js";
import { fake_page_command } from "./fake_page.js";
import { TabGone } from "../../worker/errors.js";

const clone = (value) => (value === undefined || value === null ? null : structuredClone(value));

export function create_world({ base = "https://ash.example.test", version = "test", server = null, fetch = null } = {}) {
  return {
    base,
    version,
    server,
    real_fetch: fetch,
    local: new Map(),
    session: new Map(),
    tabs: new Map(),
    next_tab: 1,
    clock: { ms: Date.UTC(2026, 9, 15, 12, 0, 0) },
    site: empty_site(),
    lives: 0,

    close_browser() {
      this.session.clear();
      this.tabs.clear();
    },
  };
}

/**
 * One service worker's life. `kill_after` is the operation after which it
 * dies, or null for a life that never does.
 */
export function create_life(world, { kill_after = null } = {}) {
  world.lives++;

  let resolve_death;
  const life = {
    ops: 0,
    dead: false,
    died: new Promise((resolve) => {
      resolve_death = resolve;
    }),
    trace: [],
  };

  const never = () => new Promise(() => {});

  /** Wrap one effect so it counts, and so a dead life never comes back from it. */
  const op = (name, effect) => async (...args) => {
    if (life.dead) return never();

    const result = await effect(...args);

    life.ops++;
    life.trace.push(typeof name === "function" ? name(...args) : name);

    if (kill_after !== null && life.ops >= kill_after) {
      life.dead = true;
      resolve_death(name);

      return never();
    }

    return result;
  };

  const area = (map, label) => ({
    get: op(`${label}.get`, async (key) => clone(map.get(key))),
    set: op(`${label}.set`, async (key, value) => {
      map.set(key, clone(value));
    }),
    remove: op(`${label}.remove`, async (key) => {
      map.delete(key);
    }),
  });

  const env = {
    version: world.version,
    base_url: op("base_url", async () => world.base),
    local: area(world.local, "local"),
    session: area(world.session, "session"),

    fetch: op("fetch", async (url, init) => {
      if (world.real_fetch) return world.real_fetch(url, init);

      const path = new URL(url).pathname;
      const answer = world.server.handle(init.method, path, init.headers || {}, init.body || "");

      return { status: answer.status, text: async () => JSON.stringify(answer.body) };
    }),

    now: () => world.clock.ms,
    sleep: op("sleep", async (ms) => {
      world.clock.ms += ms;
    }),
    uuid: () => crypto.randomUUID(),
    extension_url: (path) => `chrome-extension://fixture/${path}`,

    tabs: {
      open: op("tabs.open", async (url) => {
        const id = world.next_tab++;

        world.tabs.set(id, { url, form: [] });

        return id;
      }),
      navigate: op("tabs.navigate", async (id, url) => {
        if (!world.tabs.has(id)) return false;

        world.tabs.set(id, { url, form: [] });

        return true;
      }),
      exists: op("tabs.exists", async (id) => world.tabs.has(id)),
      close: op("tabs.close", async (id) => {
        world.tabs.delete(id);
      }),
      reveal: op("tabs.reveal", async () => {}),
      close_strays: op("tabs.close_strays", async (keep) => {
        for (const id of [...world.tabs.keys()]) if (id !== keep) world.tabs.delete(id);
      }),
    },

    page: {
      send: op((tab_id, command) => `page.send:${command}`, async (tab_id, command, args = {}) => {
        const tab = world.tabs.get(tab_id);

        if (!tab) throw new TabGone();

        return fake_page_command(world.site, tab, command, args);
      }),
    },
  };

  return { env, life };
}
