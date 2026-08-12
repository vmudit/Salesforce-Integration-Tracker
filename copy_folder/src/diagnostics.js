const { runQuery, unwrapBqValue, coerceNumber } = require("./bigquery");
const { buildProbeSql, extractParams, factTable } = require("./queries");

/**
 * Connectivity probe for /api/debug/bigquery.
 * Return aggregates only — never row-level customer data.
 */
async function runDiagnostics() {
  const { project, dataset, table } = factTable();
  const params = extractParams();

  const started = Date.now();
  const rows = await runQuery(buildProbeSql(), params);
  const r = rows[0] || {};

  return {
    target: { project, dataset, table },
    window: params,
    rowCount: coerceNumber(r.row_count),
    minDate: unwrapBqValue(r.min_date),
    maxDate: unwrapBqValue(r.max_date),
    elapsedMs: Date.now() - started,
  };
}

module.exports = { runDiagnostics };
