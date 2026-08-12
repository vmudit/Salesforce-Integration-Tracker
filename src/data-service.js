const { runQuery, isBigQueryConfigured } = require("./bigquery");
const { buildExtractSql, extractParams } = require("./queries");
const { buildPayload } = require("./transform");
const { buildDemoRows } = require("./demo-data");

let lastRefresh = null;

function demoModeEnabled() {
  const raw =
    process.env.DEMO_MODE ??
    process.env.Demo_Mode ??
    process.env.demo_mode ??
    "";
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function notConfigured() {
  const err = new Error("BigQuery is not configured");
  err.code = "BIGQUERY_NOT_CONFIGURED";
  return err;
}

/**
 * Runs the extract and builds the dashboard payload.
 * Throws when the self-check fails so a bad payload is never cached or served.
 *
 * When DEMO_MODE=1, returns synthetic rows (no BigQuery call) for local UI review.
 */
async function fetchData() {
  const startedAt = Date.now();
  let rows;
  let queryMs;
  const isDemo = demoModeEnabled();

  if (isDemo) {
    rows = buildDemoRows();
    queryMs = Date.now() - startedAt;
  } else {
    if (!isBigQueryConfigured()) throw notConfigured();
    rows = await runQuery(buildExtractSql(), extractParams());
    queryMs = Date.now() - startedAt;
  }

  const { payload, checks } = buildPayload(rows, { demoMode: isDemo });

  if (!checks.ok || !payload) {
    const err = new Error(`Self-check failed: ${checks.errors.join("; ")}`);
    err.code = "SELF_CHECK_FAILED";
    err.checks = checks;
    throw err;
  }

  checks.warnings.forEach((w) => console.warn(`[self-check warning] ${w}`));

  const buildMs = Date.now() - startedAt - queryMs;
  lastRefresh = {
    at: new Date().toISOString(),
    queryMs,
    buildMs,
    rowCount: rows.length,
    warnings: checks.warnings,
    demoMode: isDemo,
  };

  console.log(
    `[self-check OK] demo=${isDemo} rows=${rows.length} query=${queryMs}ms build=${buildMs}ms`
  );

  const isEmpty =
    (Array.isArray(payload.records) && payload.records.length === 0) ||
    rows.length === 0;

  return { payload, checks, isEmpty };
}

function getLastRefresh() {
  return lastRefresh;
}

module.exports = { fetchData, getLastRefresh, demoModeEnabled };
