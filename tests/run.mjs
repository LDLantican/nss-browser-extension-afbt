/**
 * Run the extension's tests under Node: `node tests/run.mjs [filter]`.
 *
 * Node is only the place they run — nothing is installed, there is no
 * package.json, and the files are the same ones tests/index.html runs inside
 * the extension. Files that need a DOM or Chrome itself run only there
 * (BROWSER_ONLY below).
 *
 * Exits 0 when everything passes and 1 otherwise.
 */

import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run_suites } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Need a DOM or Chrome's own APIs, so they run in the extension's test page only. */
const BROWSER_ONLY = new Set(["adapters/chrome_env_test.js", "adapters/fixture_page_test.js"]);

function test_files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "support" ? [] : test_files(path);

    return entry.name.endsWith("_test.js") ? [path] : [];
  });
}

const filter = process.argv[2] || "";
const suites = [];

for (const path of test_files(here).sort()) {
  const file = relative(here, path).replace(/\\/g, "/");

  if (BROWSER_ONLY.has(file)) continue;

  suites.push({ file, tests: (await import(pathToFileURL(path).href)).default });
}

globalThis.__kill_loop_report = [];

const { failed } = await run_suites(suites, { filter });

for (const { operation, total, runs, tally } of globalThis.__kill_loop_report)
  console.log(`kill loop, ${operation}: ${total} operations per job, ${runs} runs — ${JSON.stringify(tally)}`);

process.exit(failed === 0 ? 0 : 1);
