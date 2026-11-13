/**
 * Salesforce Integration Tracker extract.
 *
 *   sql/sfinfo_previous.sql  one Salesforce userid count per company per date
 *   sql/company_base.sql     company-day CTEs, including the live latest_* snapshot
 *   sql/final_compare.sql    joins sfinfo_by_date on companyid and date, then flags
 *
 * sfinfo_previous is inlined. It does not use FOR SYSTEM_TIME, because that
 * timestamp cannot vary by row date and cannot see previous months.
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

function stripLeadingComments(sql) {
  return sql.replace(/^(?:\s|--[^\n]*\n)+/, "").trim();
}

/**
 * One BigQuery job. sql/sfinfo_previous.sql is inlined as sfinfo_by_date.
 * It is a live read of salesforce_info, same as the latest_* snapshot, so it
 * can share the query. FOR SYSTEM_TIME is not used: that timestamp cannot
 * vary by row date and cannot see previous months.
 */
function buildTrackerQueries() {
  const previousSql = loadSqlFile("sfinfo_previous.sql");
  const baseSql = loadSqlFile("company_base.sql");
  const finalSql = loadSqlFile("final_compare.sql");

  const previousCode = stripComments(previousSql);
  const baseCode = stripComments(baseSql);
  const finalCode = stripComments(finalSql);

  if (previousCode.includes("FOR SYSTEM_TIME") || baseCode.includes("FOR SYSTEM_TIME") || finalCode.includes("FOR SYSTEM_TIME")) {
    throw new Error("Tracker SQL must not use FOR SYSTEM_TIME");
  }
  if (!previousCode.includes("list_of_dates") || !previousCode.includes("previous_day_active_sfuserids")) {
    throw new Error("sfinfo_previous.sql must build a date list and a previous-day count");
  }
  if (!baseCode.includes("sfinfo_by_date")) {
    throw new Error("company_base.sql must filter companies from sfinfo_by_date");
  }
  if (!finalCode.includes("b.date = p.date")) {
    throw new Error("final_compare.sql must join sfinfo_by_date on date");
  }

  const previousBody = stripLeadingComments(previousSql).trim();
  const baseBody = stripLeadingComments(baseSql).replace(/^WITH\s+/i, "").trim();
  const finalBody = stripLeadingComments(finalSql).replace(/^WITH\s+/i, "").trim();
  const compareSql = `WITH sfinfo_by_date AS (
${previousBody}
),
${baseBody},
${finalBody}`;

  if (stripComments(compareSql).includes("FOR SYSTEM_TIME")) {
    throw new Error("The compare query must not use FOR SYSTEM_TIME");
  }
  if (stripComments(compareSql).includes("@previous_sf")) {
    throw new Error("The compare query must not take a snapshot parameter");
  }
  return { compareSql };
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
  buildTrackerQueries,
  buildProbeSql,
  factUserMasterTable,
  salesforceInfoTable,
};
