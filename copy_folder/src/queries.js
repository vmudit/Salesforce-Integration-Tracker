/**
 * TEMPLATE — replace buildExtractSql() with YOUR SQL.
 *
 * Pattern from customer-segment-nrr:
 * - Validate project/dataset/table identifiers before interpolating (BQ cannot
 *   parameterize table names).
 * - Bind filter values as @params (never string-concatenate user/env dates).
 */
const { getProjectId } = require("./bigquery");

const DEFAULT_DATASET = "your_dataset";
const DEFAULT_TABLE = "your_table";
const DEFAULT_RANGE_START = "2024-01-01";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,62}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkIdent(value, pattern, label) {
  if (!value || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function checkDate(value, fallback, label) {
  const v = value || fallback;
  if (!DATE_RE.test(v)) {
    throw new Error(`Invalid ${label}, expected YYYY-MM-DD: ${JSON.stringify(value)}`);
  }
  return v;
}

function factTable() {
  const project = getProjectId();
  if (!project) {
    const err = new Error("BQ_PROJECT_ID is required");
    err.code = "BIGQUERY_NOT_CONFIGURED";
    throw err;
  }
  checkIdent(project, PROJECT_RE, "BQ_PROJECT_ID");
  const dataset = checkIdent(
    process.env.BQ_DATASET || DEFAULT_DATASET,
    NAME_RE,
    "BQ_DATASET"
  );
  const table = checkIdent(process.env.BQ_TABLE || DEFAULT_TABLE, NAME_RE, "BQ_TABLE");
  return { fqn: `\`${project}.${dataset}.${table}\``, project, dataset, table };
}

function extractParams() {
  return {
    rangeStart: checkDate(process.env.BQ_RANGE_START, DEFAULT_RANGE_START, "BQ_RANGE_START"),
  };
}

/**
 * Paste your SQL here. Use ${factTable().fqn} for the table and @rangeStart
 * (or other keys from extractParams) for filters.
 */
function buildExtractSql() {
  const { fqn } = factTable();
  return `
    SELECT *
    FROM ${fqn}
    WHERE date_col >= @rangeStart
    LIMIT 1000
  `;
}

/** Optional aggregate-only probe for /api/debug/bigquery */
function buildProbeSql() {
  const { fqn } = factTable();
  return `
    SELECT
      COUNT(*) AS row_count,
      MIN(date_col) AS min_date,
      MAX(date_col) AS max_date
    FROM ${fqn}
    WHERE date_col >= @rangeStart
  `;
}

module.exports = {
  buildExtractSql,
  buildProbeSql,
  extractParams,
  factTable,
};
