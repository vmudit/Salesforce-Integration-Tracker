/**
 * Salesforce Integration Tracker extract.
 * Loads sql/your_extract.sql and fills {{TABLE}} tokens with validated FQNs.
 */
const fs = require("fs");
const path = require("path");
const { getProjectId } = require("./bigquery");

const EXTRACT_SQL_PATH = path.join(__dirname, "..", "sql", "your_extract.sql");
const TABLE_TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,62}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

function checkIdent(value, pattern, label) {
  if (!value || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
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

function datasetTable(envDataset, envTable, defaultDataset, defaultTable) {
  const project = projectId();
  const dataset = checkIdent(process.env[envDataset] || defaultDataset, NAME_RE, envDataset);
  const table = checkIdent(process.env[envTable] || defaultTable, NAME_RE, envTable);
  return {
    fqn: `\`${project}.${dataset}.${table}\``,
    project,
    dataset,
    table,
  };
}

function factUserMasterTable() {
  return datasetTable(
    "BQ_FUM_DATASET",
    "BQ_FUM_TABLE",
    "analytics_reporting",
    "fact_user_master"
  );
}

function justcallUsersTable() {
  return datasetTable(
    "BQ_JC_USERS_DATASET",
    "BQ_JC_USERS_TABLE",
    "analytics_intermediate",
    "justcall_users"
  );
}

function internalEmailsTable() {
  return datasetTable(
    "BQ_INTERNAL_EMAILS_DATASET",
    "BQ_INTERNAL_EMAILS_TABLE",
    "analytics_intermediate",
    "int_internal_emails"
  );
}

function intLogsStatusTable() {
  return datasetTable(
    "BQ_INT_LOGS_DATASET",
    "BQ_INT_LOGS_TABLE",
    "justcall",
    "int_logs_status"
  );
}

function intConnectTable() {
  return datasetTable(
    "BQ_INT_CONNECT_DATASET",
    "BQ_INT_CONNECT_TABLE",
    "justcall",
    "int_connect_jclive"
  );
}

function salesforceInfoTable() {
  return datasetTable(
    "BQ_SF_INFO_DATASET",
    "BQ_SF_INFO_TABLE",
    "jclive",
    "salesforce_info"
  );
}

function extractTableTokens() {
  return {
    FACT_USER_MASTER: factUserMasterTable().fqn,
    JUSTCALL_USERS: justcallUsersTable().fqn,
    INTERNAL_EMAILS: internalEmailsTable().fqn,
    INT_LOGS_STATUS: intLogsStatusTable().fqn,
    INT_CONNECT_JCLIVE: intConnectTable().fqn,
    SALESFORCE_INFO: salesforceInfoTable().fqn,
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

/** No bound parameters — dates are computed inside BigQuery. */
function extractParams() {
  return {};
}

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
  const leftover = sql.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) {
    throw new Error(`Extract SQL still contains an unsubstituted token ${leftover[0]}`);
  }
  return sql;
}

/** Aggregate-only probe. Never returns customer rows. */
function buildProbeSql() {
  const info = salesforceInfoTable();
  return `
    SELECT COUNT(*) AS row_count
    FROM ${info.fqn}
    WHERE issued_at IS NOT NULL
      AND sfuserid IS NOT NULL
      AND userid IS NOT NULL
      AND companyid IS NOT NULL
  `;
}

module.exports = {
  buildExtractSql,
  buildProbeSql,
  extractParams,
  factUserMasterTable,
  salesforceInfoTable,
};
