/**
 * The test page's runner. Extension pages cannot list a directory, so the
 * files are named here; tests/run.mjs finds the same ones by walking tests/.
 */

import { run_suites } from "./harness.js";

const FILES = [
  "adapters/chrome_env_test.js",
  "adapters/fixture_page_test.js",
  "worker/client_test.js",
  "worker/import_test.js",
  "worker/kill_loop_test.js",
  "worker/runtime_test.js",
];

document.addEventListener("DOMContentLoaded", () => {
  const app = {
    out: null,
    button: null,

    init() {
      app.out = document.getElementById("out");
      app.button = document.getElementById("run");
      app.button.addEventListener("click", app.run);
      app.run();
    },

    log(line) {
      app.out.textContent += `${line}\n`;
    },

    async run() {
      app.button.disabled = true;
      app.out.textContent = "";
      globalThis.__kill_loop_report = [];

      const suites = [];

      for (const file of FILES) suites.push({ file, tests: (await import(`./${file}`)).default });

      const { failed } = await run_suites(suites, { log: app.log });

      for (const { operation, total, runs, tally } of globalThis.__kill_loop_report)
        app.log(`kill loop, ${operation}: ${total} operations per job, ${runs} runs — ${JSON.stringify(tally)}`);

      document.title = failed === 0 ? "✓ ASH Helper tests" : "✗ ASH Helper tests";
      app.button.disabled = false;
    },
  };

  window.addEventListener("load", () => {
    app.init();
  });
});
