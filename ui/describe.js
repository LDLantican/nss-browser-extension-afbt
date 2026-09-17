/**
 * Wording shared by the popup and the Troubleshooting card in Settings.
 *
 * Two audiences read the same runs. The popup is for whoever is doing the
 * day's work and says one sentence; Settings is for whoever is working out why
 * something went wrong and prints everything the run knew. Both halves live
 * here so a refusal is never worded one way in one place and another way in
 * the other.
 *
 * The describe_* functions return plain text on purpose. Their whole reason for
 * existing is to be sent to whoever can compare them against what the content
 * scripts look for, and a flat list survives a screenshot or a chat message
 * intact.
 */

const NEWLINE = String.fromCharCode(10);

/**
 * Refusals a run can come back with, by error code.
 *
 * Three different sign-ins can fail and they have three different fixes, so
 * none of them may be worded as another. `scope_unknown` is not a sign-in
 * problem at all: the web app did not say which work orders may be billed, and
 * guessing between a test job and a real client's invoice is not something a
 * retry should do quietly.
 */
export const REASONS = {
  vendor_signed_out:
    "You are signed out of the AppFolio vendor portal. Sign in on the tab just opened, then try again.",
  buildertrend_signed_out:
    "You are signed out of Buildertrend. Sign in on the tab just opened, then try again.",
  signed_out: "This browser is no longer signed in to the web app. Open Settings and sign in again.",
  not_permitted: "Your account is not allowed to send invoices or estimates.",
  scope_unknown: "The web app did not say which work orders it may send, so nothing was sent.",
};

/**
 * " (test work orders)", or nothing at all.
 *
 * Only said for `sample`. Appending "real work orders" to every ordinary notice
 * would be noise on the line a manager reads a hundred times a day.
 */
export function scope_note(summary) {
  return summary?.scope === "sample" ? " (test work orders)" : "";
}

/**
 * Everything an invoice run counted, as short parts.
 *
 * `held back` matches config/work_orders.php's label for the same state. A run
 * that refused five jobs and delivered none must not read as "nothing was
 * waiting". `left_open` and `photos_missing` are billed-and-correct jobs that
 * still want tidying, reported because a delivered row's last_error is nulled
 * and the server has nowhere to keep them.
 */
export function delivery_details(summary = {}) {
  return [
    summary.delivered ? `${summary.delivered} delivered` : "",
    summary.unconfirmed ? `${summary.unconfirmed} need checking` : "",
    summary.blocked ? `${summary.blocked} held back` : "",
    summary.failed ? `${summary.failed} failed` : "",
    summary.left_open ? `${summary.left_open} still In Progress` : "",
    summary.photos_missing ? `${summary.photos_missing} photos not attached` : "",
  ].filter(Boolean);
}

/**
 * The page probe's answer.
 *
 * Only the hooks that *should* be on this page are checked, because every page
 * holds about a quarter of the selector map and a reader cannot tell an expected
 * zero from a broken selector.
 */
export function describe_probe(report) {
  const lines = [];
  const money = (cents) =>
    cents === null || cents === undefined ? "none" : `$${(cents / 100).toFixed(2)}`;

  lines.push(`page    : ${report.page || "?"}${report.state === "signed_out" ? "  (SIGNED OUT)" : ""}`);
  if (report.tab_title) lines.push(`tab     : ${report.tab_title}`);

  /* First, and unmissable. Every reading under it is taken from the DOM as it
     stands, and on a half-rendered page that means "" and null and 0 — which
     is exactly how a blank page used to read as a healthy one. */
  if (report.loading) lines.push(`loading : YES — readings below are unreliable`);
  if (report.list_state) lines.push(`list    : ${report.list_state}`);
  if (report.number) lines.push(`number  : ${report.number}`);
  if (report.status) lines.push(`status  : ${report.status}`);
  lines.push(`limit   : ${money(report.maintenance_limit_cents)}`);
  lines.push(`invoiced: ${report.already_invoiced ? "YES" : "no"}`);

  const expected = report.expected || [];
  const found = report.found || {};

  if (expected.length > 0) {
    lines.push("");
    lines.push("hooks this page should have");

    for (const key of expected)
      lines.push(
        `  ${found[key] > 0 ? "found  " : "MISSING"}  ${key.replace(/_/g, " ")}  (${found[key] ?? 0})`,
      );

    if ((report.missing || []).length === 0) {
      lines.push("");
      lines.push("all present.");
    }
  }

  /* The tab walk. `no status badges` against a tab that has rows means
     js-summary-status has moved, and that is the single selector the delivery
     gate classifies on; a state of `loading` means that tab never finished. */
  if (report.list) {
    lines.push("");
    lines.push(`tabs (started on ${report.list.started_on || "?"})`);

    for (const tab of report.list.tabs || []) {
      const badges = Object.entries(tab.statuses || {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => `${label} ${count}`)
        .join(", ");

      const state = (tab.state || (tab.confirmed ? "loaded" : "loading")).padEnd(8);

      lines.push(`  ${state}  ${tab.label}  ${tab.rows} rows`);

      if (tab.state === "loaded") lines.push(`      ${badges || "NO STATUS BADGES FOUND"}`);
      else if (tab.state === "filtered") lines.push("      a status filter is excluding every row");
      else if (tab.state === "loading") lines.push("      never finished loading; nothing was read");
    }
  }

  if (report.hint) {
    lines.push("");
    lines.push(report.hint);
  }

  return lines.join(NEWLINE);
}

/** What a rehearsal saw, per job. */
export function describe_reports(reports) {
  if (reports.length === 0) return "Nothing was waiting to be rehearsed.";

  return reports
    .map((entry) => {
      const head = `${entry.number}: ${entry.ok ? "OK" : "STOPPED"}`;

      if (entry.ok)
        return `${head}${NEWLINE}  expected  ${entry.expected}${NEWLINE}  page said ${entry.read_back}`;

      return `${head}${NEWLINE}  ${entry.error || "no reason given"}`;
    })
    .join(NEWLINE + NEWLINE);
}

/**
 * What the last Buildertrend job-creation run did.
 *
 * It leads with the step that failed and the page's own words for it. Three
 * separate faults in this leg were diagnosed by inference from the web server's
 * access log because the extension knew exactly what went wrong and told
 * nobody; every line here is something it already computed.
 */
export function describe_bt_run(run) {
  if (!run) return "";

  const lines = [];
  const when = new Date(run.finished_at || run.started_at || Date.now());
  const seconds = Math.round(((run.finished_at || 0) - (run.started_at || 0)) / 1000);

  lines.push(`run     : ${when.toLocaleString()}  (${seconds}s)`);

  const summary = run.summary || {};

  lines.push(
    `result  : ${summary.created || 0} linked · ${summary.already || 0} already there · ${summary.unidentified || 0} unidentified · `
    + `${summary.failed || 0} failed · ${summary.skipped || 0} not attempted`,
  );

  if (summary.stopped && summary.reason) lines.push(`stopped : ${summary.reason}`);

  for (const job of run.jobs || []) {
    lines.push("");
    lines.push(`${job.number}`);
    lines.push(`  created : ${job.existing ? "no, already in Buildertrend" : job.created ? "yes" : "NO"}`);

    if (job.url) lines.push(`  url     : ${job.url}`);
    if (job.error) lines.push(`  problem : ${job.error}`);

    const detail = job.detail || {};

    /* The two that separate "the page never ran" from "the page ran and said
       no" — which need opposite fixes and used to read identically. */
    if (detail.stage) {
      lines.push(
        `  lookup  : stage=${detail.stage} answered=${detail.answered ? "yes" : "NO"}`
        + ` attempts=${detail.attempts ?? "?"} reloaded=${detail.reloaded ? "yes" : "no"}`,
      );
    }

    if (detail.searched !== undefined) lines.push(`  searched: "${detail.searched}"`);
    if (detail.wanted !== undefined) lines.push(`  wanted  : "${detail.wanted}"`);

    if (detail.row_count !== undefined) {
      lines.push(`  rows    : ${detail.row_count}`);

      /* The title is matched exactly, so seeing what the rows actually said
         settles the commonest failure at a glance. */
      for (const row of detail.sample || []) lines.push(`    ${row.id}  "${row.title}"`);
    }

    if (job.link) {
      lines.push(
        `  link    : ${job.link.ok ? "recorded" : "REFUSED"} `
        + `status=${job.link.status || 0}${job.link.error ? ` — ${job.link.error}` : ""}`,
      );
    } else if (job.created && !job.url) {
      lines.push(`  link    : not attempted — no id to record`);
    }
  }

  return lines.join(NEWLINE);
}

/** What the last estimate run did. */
export function describe_estimate_run(run) {
  if (!run) return "";

  const lines = [];
  const summary = run.summary || {};

  lines.push(`estimates : ${new Date(run.at || Date.now()).toLocaleString()}`);
  lines.push(
    `result    : ${summary.delivered || 0} written · ${summary.rehearsed || 0} rehearsed · `
    + `${summary.blocked || 0} blocked · ${summary.unconfirmed || 0} unconfirmed · ${summary.failed || 0} failed`,
  );

  if (run.error) lines.push(`problem   : ${run.error}`);
  if (summary.reason) lines.push(`reason    : ${summary.reason}`);

  for (const report of run.reports || []) {
    lines.push("");
    lines.push(`${report.number}  ${report.ok ? "ok" : "NOT DONE"}`);
    if (report.expected) lines.push(`  expected: ${report.expected}`);
    /* A rehearsal's whole product. It sends nothing, so the payload it *would*
       have sent is the only thing there is to check. */
    if (report.note) lines.push(`  would do: ${report.note}`);
    if (report.error) lines.push(`  problem : ${report.error}`);
  }

  return lines.join(NEWLINE);
}

export { NEWLINE };
