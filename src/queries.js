/**
 * Salesforce Integration Tracker extract, split into three jobs so
 * salesforce_info is never read both live and with FOR SYSTEM_TIME AS OF
 * in the same query.
 *
 *   sql/sfinfo_previous.sql  yesterday snapshot (time travel only)
 *   sql/company_base.sql     company-day rows (live salesforce_info only)
 *   sql/final_compare.sql    join + comparison flags
 */
const fs = require("fs");
const path = require("path");
const { getProjectId } = require("./bigquery");

const SQL_DIR = path.join(__dirname, "..", "sql");

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

function applyTableTokens(sql, tables, filePath) {
  return sql.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(tables, name)) {
      throw new Error(`Unknown SQL table token {{${name}}} in ${filePath}`);
    }
    return tables[name];
  });
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

function loadSqlFile(fileName) {
  const filePath = path.join(SQL_DIR, fileName);
  let sql;
  try {
    sql = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const wrapped = new Error(`Failed to read SQL at ${filePath}`);
    wrapped.cause = err;
    throw wrapped;
  }
  sql = applyTableTokens(sql, extractTableTokens(), filePath).replace(/;\s*$/, "").trim();
  const leftover = sql.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) {
    throw new Error(`${fileName} still contains an unsubstituted token ${leftover[0]}`);
  }
  return sql;
}

function asTempTable(name, sql) {
  if (!/^_tracker_[a-z_]+$/.test(name)) {
    throw new Error(`Refusing temp table name ${JSON.stringify(name)}`);
  }
  const body = sql.replace(/^(?:\s|--[^\n]*\n)+/, "").trim();
  return `CREATE TEMP TABLE ${name} AS\n${body}`;
}

/**
 * Three statements, run in order inside one BigQuery session.
 * The first two land in temp tables. The third joins them.
 */
function buildTrackerSteps() {
  const previous = loadSqlFile("sfinfo_previous.sql");
  const base = loadSqlFile("company_base.sql");
  const finalSql = loadSqlFile("final_compare.sql");

  const previousCode = stripComments(previous);
  const baseCode = stripComments(base);
  const finalCode = stripComments(finalSql);

  if (!previousCode.includes("FOR SYSTEM_TIME AS OF")) {
    throw new Error("sfinfo_previous.sql is missing FOR SYSTEM_TIME AS OF");
  }
  if ((previousCode.match(/FOR SYSTEM_TIME AS OF/g) || []).length !== 1) {
    throw new Error("sfinfo_previous.sql must reference FOR SYSTEM_TIME AS OF exactly once");
  }
  if (baseCode.includes("FOR SYSTEM_TIME")) {
    throw new Error("company_base.sql must not use FOR SYSTEM_TIME");
  }
  if (!baseCode.includes("_tracker_sfinfo_previous")) {
    throw new Error("company_base.sql must read _tracker_sfinfo_previous");
  }
  if (finalCode.includes("FOR SYSTEM_TIME") || /salesforce_info/i.test(finalCode)) {
    throw new Error("final_compare.sql must not read salesforce_info");
  }

  return {
    previousSql: asTempTable("_tracker_sfinfo_previous", previous),
    baseSql: asTempTable("_tracker_company_base", base),
    finalSql,
  };
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
  buildTrackerSteps,
  buildProbeSql,
  factUserMasterTable,
  salesforceInfoTable,
};
