const { runQuery, coerceNumber } = require("./bigquery");
const { buildProbeSql, salesforceInfoTable } = require("./queries");

/**
 * Connectivity probe for /api/debug/bigquery.
 * Returns an aggregate count only — never row-level customer data.
 */
async function runDiagnostics() {
  const { project, dataset, table } = salesforceInfoTable();
  const started = Date.now();
  const rows = await runQuery(buildProbeSql(), {});
  const r = rows[0] || {};

  return {
    target: { project, dataset, table },
    rowCount: coerceNumber(r.row_count),
    elapsedMs: Date.now() - started,
  };
}

module.exports = { runDiagnostics };
