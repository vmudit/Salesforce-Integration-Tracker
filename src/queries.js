/**
 * Trial Extension extract — loads sql/your_extract.sql and fills table tokens.
 *
 * Table identifiers are validated before interpolation (BQ cannot bind them).
 * Filter values are bound as @params.
 */
const fs = require("fs");
const path = require("path");
const { getProjectId } = require("./bigquery");

const EXTRACT_SQL_PATH = path.join(__dirname, "..", "sql", "your_extract.sql");
const TABLE_TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;

const DEFAULT_RANGE_START = "2026-01-01";

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

function projectId() {
  const project = getProjectId();
  if (!project) {
    const err = new Error("BQ_PROJECT_ID is required");
    err.code = "BIGQUERY_NOT_CONFIGURED";
    throw err;
  }
  return checkIdent(project, PROJECT_RE, "BQ_PROJECT_ID");
}

function datasetTable(envDataset, envTable, defaultDataset, defaultTable, label) {
  const project = projectId();
  const dataset = checkIdent(
    process.env[envDataset] || defaultDataset,
    NAME_RE,
    envDataset
  );
  const table = checkIdent(process.env[envTable] || defaultTable, NAME_RE, envTable);
  return {
    fqn: `\`${project}.${dataset}.${table}\``,
    project,
    dataset,
    table,
    label,
  };
}

/** Primary funnel grain — one row per trial-related contact/company. */
function funnelTable() {
  return datasetTable(
    "BQ_FUNNEL_DATASET",
    "BQ_FUNNEL_TABLE",
    "hubspot_migration",
    "reporting_user_funnel_new_hs",
    "funnel"
  );
}

function factUserMasterTable() {
  return datasetTable(
    "BQ_FUM_DATASET",
    "BQ_FUM_TABLE",
    "analytics_reporting",
    "fact_user_master",
    "fact_user_master"
  );
}

function upgradeLogsTable() {
  return datasetTable(
    "BQ_UPGRADE_DATASET",
    "BQ_UPGRADE_TABLE",
    "justcall",
    "upgradeDowngradeLogs",
    "upgrade_logs"
  );
}

/** Former dbt ref('sfdc_user_role_hs') — override via env if FQN differs. */
function sfdcUserRoleTable() {
  return datasetTable(
    "BQ_SFDC_DATASET",
    "BQ_SFDC_TABLE",
    "analytics_seed",
    "hubspot_sfdc_user_role_hs",
    "sfdc_user_role"
  );
}

function licenceMrrTable() {
  return datasetTable(
    "BQ_LICENCE_DATASET",
    "BQ_LICENCE_TABLE",
    "analytics_intermediate",
    "int_licence_final_mrr",
    "licence_mrr"
  );
}

/** Kept for diagnostics.js compatibility (points at funnel). */
function factTable() {
  const t = funnelTable();
  return { fqn: t.fqn, project: t.project, dataset: t.dataset, table: t.table };
}

function extractParams() {
  return {
    rangeStart: checkDate(process.env.BQ_RANGE_START, DEFAULT_RANGE_START, "BQ_RANGE_START"),
    previousPlanId: Number(process.env.BQ_PREVIOUS_PLAN_ID || 1194),
    changedToPlanId: Number(process.env.BQ_CHANGED_TO_PLAN_ID || 100),
  };
}

function extractTableTokens() {
  return {
    FUNNEL: funnelTable().fqn,
    FUM: factUserMasterTable().fqn,
    UPGRADES: upgradeLogsTable().fqn,
    SFDC: sfdcUserRoleTable().fqn,
    LICENCE: licenceMrrTable().fqn,
  };
}

function applyTableTokens(sql, tables) {
  return sql.replace(TABLE_TOKEN_RE, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(tables, name)) {
      throw new Error(`Unknown SQL table token {{${name}}} in ${EXTRACT_SQL_PATH}`);
    }
    return tables[name];
  });
}

/**
 * Trial base extract — query text lives in sql/your_extract.sql (single source).
 * Assumptions baked into SQL (confirm with stakeholders):
 * - Limit override / Custom = first upgrade from previousPlanId (1194) → changedToPlanId (100)
 * - Default limit type is derived in transform for Enterprise trials without that upgrade
 * - Only rows with TrialTime IS NOT NULL
 * - cust_status from FUM as of current_date()-1
 * - is_contract from int_licence_final_mrr as of current_date()-1 (joined on companyid = userid)
 */
function buildExtractSql() {
  let sql;
  try {
    sql = fs.readFileSync(EXTRACT_SQL_PATH, "utf8");
  } catch (err) {
    const wrapped = new Error(`Failed to read extract SQL at ${EXTRACT_SQL_PATH}`);
    wrapped.cause = err;
    throw wrapped;
  }

  sql = applyTableTokens(sql, extractTableTokens()).replace(/;\s*$/, "").trim();
  return sql;
}

function buildProbeSql() {
  const funnel = funnelTable().fqn;
  return `
    SELECT
      COUNT(*) AS row_count,
      MIN(DATE(TrialTime)) AS min_date,
      MAX(DATE(TrialTime)) AS max_date
    FROM ${funnel}
    WHERE TrialTime IS NOT NULL
      AND DATE(TrialTime) >= @rangeStart
  `;
}

module.exports = {
  buildExtractSql,
  buildProbeSql,
  extractParams,
  factTable,
  funnelTable,
  factUserMasterTable,
  upgradeLogsTable,
  sfdcUserRoleTable,
  licenceMrrTable,
};
