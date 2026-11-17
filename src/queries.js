/**
 * Salesforce Integration Tracker extract, split so salesforce_info is never
 * read both live and with FOR SYSTEM_TIME AS OF in the same query.
 *
 *   sql/sfinfo_previous.sql  yesterday snapshot (its own job, time travel only)
 *   sql/company_base.sql     company-day CTEs (live salesforce_info only)
 *   sql/final_compare.sql    join + comparison flags
 *
 * The snapshot rows are passed into the compare job as @previous_sf.
 * BigQuery sessions are not used.
 */
const fs = require("fs");
const path = require("path");
const { getProjectId } = require("./bigquery");
const { COLUMNS } = require("./transform");

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
 * Two statements. The first is the time-travel snapshot. The second joins
 * those rows, via @previous_sf, to the live company-day extract and adds flags.
 */
function buildTrackerQueries() {
  const previousSql = loadSqlFile("sfinfo_previous.sql");
  const baseSql = loadSqlFile("company_base.sql");
  const finalSql = loadSqlFile("final_compare.sql");

  const previousCode = stripComments(previousSql);
  const baseCode = stripComments(baseSql);
  const finalCode = stripComments(finalSql);

  if ((previousCode.match(/FOR SYSTEM_TIME AS OF/g) || []).length !== 1) {
    throw new Error("sfinfo_previous.sql must reference FOR SYSTEM_TIME AS OF exactly once");
  }
  if (baseCode.includes("FOR SYSTEM_TIME") || finalCode.includes("FOR SYSTEM_TIME")) {
    throw new Error("company_base.sql and final_compare.sql must not use FOR SYSTEM_TIME");
  }
  if (!baseCode.includes("previous_sf") || !finalCode.includes("previous_sf")) {
    throw new Error("The compare query must read the previous_sf snapshot");
  }
  if (/salesforce_info/i.test(finalCode)) {
    throw new Error("final_compare.sql must not read salesforce_info");
  }

  const baseBody = stripLeadingComments(baseSql).replace(/^WITH\s+/i, "").trim();
  const finalBody = stripLeadingComments(finalSql).replace(/^WITH\s+/i, "").trim();
  const compareSql = `WITH previous_sf AS (
  SELECT
    companyid,
    previous_day_active_sfuserids
  FROM UNNEST(@previous_sf)
),
${baseBody},
${finalBody}`;

  if (stripComments(compareSql).includes("FOR SYSTEM_TIME")) {
    throw new Error("The compare query must not use FOR SYSTEM_TIME");
  }
  return { previousSql, compareSql };
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

function sheetColumnType(column) {
  if (column.type === "date") return "DATE";
  if (column.type === "string") return "STRING";
  return "INT64";
}

function sheetTable() {
  return datasetTable(
    "BQ_SHEET_DATASET",
    "BQ_SHEET_TABLE",
    "analytics_reporting",
    "salesforce_integration_sheet"
  );
}

function sheetDaysTable() {
  const sheet = sheetTable();
  const table = checkIdent(`${sheet.table}_days`, NAME_RE, "sheet days table");
  return {
    fqn: `\`${sheet.project}.${sheet.dataset}.${table}\``,
    project: sheet.project,
    dataset: sheet.dataset,
    table,
  };
}

function yesterdayDateSql() {
  return "DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)";
}

/** Creates the append-only sheet and the one-row-per-day ledger. */
function buildSheetEnsureSql() {
  const columns = COLUMNS.map((column) => `${column.key} ${sheetColumnType(column)}`).join(",\n  ");
  return [
    `CREATE TABLE IF NOT EXISTS ${sheetTable().fqn} (
  ${columns},
  appended_at TIMESTAMP
)`,
    `CREATE TABLE IF NOT EXISTS ${sheetDaysTable().fqn} (
  snapshot_date DATE NOT NULL,
  row_count INT64,
  appended_at TIMESTAMP
)`,
  ];
}

/** 1 when yesterday's rows are already stored, including a day with no changes. */
function buildSheetStatusSql() {
  return `
    SELECT COUNT(*) AS loaded
    FROM ${sheetDaysTable().fqn}
    WHERE snapshot_date = ${yesterdayDateSql()}
  `;
}

/** Every stored day, in the same column order the dashboard already renders. */
function buildSheetReadSql() {
  const columns = COLUMNS.map((column) => column.key).join(",\n  ");
  return `
    SELECT
      ${columns}
    FROM ${sheetTable().fqn}
    ORDER BY date DESC, companyid
  `;
}

/** The calendar date the live extract treats as yesterday. */
function buildYesterdaySql() {
  return `SELECT ${yesterdayDateSql()} AS snapshot_date`;
}

/**
 * Inserts yesterday's rows. Matching company/date rows are left as they are,
 * so a retry cannot append the same day twice.
 */
function buildSheetMergeSql() {
  const insertColumns = COLUMNS.map((column) => column.key).join(", ");
  const values = COLUMNS.map((column) => `S.${column.key}`).join(", ");
  return `
    MERGE ${sheetTable().fqn} AS T
    USING UNNEST(@day_rows) AS S
    ON T.date = S.date AND T.companyid = S.companyid
    WHEN NOT MATCHED THEN
      INSERT (${insertColumns}, appended_at)
      VALUES (${values}, CURRENT_TIMESTAMP())
  `;
}

/** Closes a date after its rows are stored. A second close the same day inserts nothing. */
function buildSheetMarkDaySql() {
  const days = sheetDaysTable().fqn;
  return `
    INSERT INTO ${days} (snapshot_date, row_count, appended_at)
    SELECT @snapshot_date, @row_count, CURRENT_TIMESTAMP()
    FROM UNNEST([1])
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${days}
      WHERE snapshot_date = @snapshot_date
    )
  `;
}

function sheetRowType() {
  const type = {};
  for (const column of COLUMNS) {
    if (column.type === "date") type[column.key] = "DATE";
    else if (column.type === "string") type[column.key] = "STRING";
    else type[column.key] = "INT64";
  }
  return type;
}

module.exports = {
  buildTrackerQueries,
  buildProbeSql,
  buildSheetEnsureSql,
  buildSheetStatusSql,
  buildSheetReadSql,
  buildYesterdaySql,
  buildSheetMergeSql,
  buildSheetMarkDaySql,
  sheetRowType,
  factUserMasterTable,
  salesforceInfoTable,
  sheetTable,
};
