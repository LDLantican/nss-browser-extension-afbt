/**
 * The extension's test harness: assertions and a runner, nothing else.
 *
 * A test file is an ES module whose default export maps a test's name to an
 * async function taking the assertions. The same files run in two places:
 * under Node (`node tests/run.mjs`) and in the extension's own test page
 * (tests/index.html), which also runs the files that need a DOM. No
 * dependencies, no build — the web app's tests/run.php is the model.
 */

export class AssertionFailed extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionFailed";
  }
}

function show(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const assertions = {
  ok(value, message = "expected a truthy value") {
    if (!value) throw new AssertionFailed(message);
  },

  equal(actual, expected, message = "values differ") {
    if (actual !== expected) throw new AssertionFailed(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  },

  deep(actual, expected, message = "values differ") {
    if (show(actual) !== show(expected)) throw new AssertionFailed(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  },

  fail(message) {
    throw new AssertionFailed(message);
  },
};

/**
 * Run `suites` — `[{ file, tests }]` — and report through `log(line)`.
 * Returns `{ passed, failed }`.
 */
export async function run_suites(suites, { log = console.log, filter = "" } = {}) {
  let passed = 0;
  let failed = 0;

  for (const { file, tests } of suites) {
    const names = Object.keys(tests).filter((name) => filter === "" || `${file} ${name}`.includes(filter));

    if (names.length === 0) continue;

    log(file);

    for (const name of names) {
      const started = performance.now();

      try {
        await tests[name](assertions);
        passed++;
        log(`  . ${name} (${((performance.now() - started) / 1000).toFixed(2)}s)`);
      } catch (error) {
        failed++;
        log(`  F ${name}`);
        log(`      ${error?.stack || error}`.split("\n").slice(0, 6).join("\n      "));
      }
    }
  }

  log("");
  log(`${passed} passed, ${failed} failed.`);

  return { passed, failed };
}
