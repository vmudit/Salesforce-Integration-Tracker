const { runQuery, isBigQueryConfigured } = require("./bigquery");
const { buildExtractSql, extractParams } = require("./queries");
const { buildPayload } = require("./transform");

let lastRefresh = null;

function notConfigured() {
  const err = new Error("BigQuery is not configured");
  err.code = "BIGQUERY_NOT_CONFIGURED";
  return err;
}

/**
 * Runs the extract and builds the dashboard payload.
 * Throws when the self-check fails so a bad payload is never cached or served.
 */
async function fetchData() {
  if (!isBigQueryConfigured()) throw notConfigured();

  const startedAt = Date.now();
  const rows = await runQuery(buildExtractSql(), extractParams());
  const queryMs = Date.now() - startedAt;

  const { payload, checks } = buildPayload(rows);

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
  };

  console.log(
    `[self-check OK] rows=${rows.length} query=${queryMs}ms build=${buildMs}ms`
  );

  const isEmpty =
    (Array.isArray(payload.records) && payload.records.length === 0) ||
    (Array.isArray(payload.accounts) && payload.accounts.length === 0) ||
    rows.length === 0;

  return { payload, checks, isEmpty };
}

function getLastRefresh() {
  return lastRefresh;
}

module.exports = { fetchData, getLastRefresh };
