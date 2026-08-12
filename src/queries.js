/**
 * Trial Extension extract — multi-table BigQuery SQL.
 *
 * Table identifiers are validated before interpolation (BQ cannot bind them).
 * Filter values are bound as @params.
 */
const { getProjectId } = require("./bigquery");

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
    "hubspot_migration",
    "sfdc_user_role_hs",
    "sfdc_user_role"
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

/**
 * Trial base extract.
 * Assumptions baked into SQL (confirm with stakeholders):
 * - Limit override = first upgrade from previousPlanId → changedToPlanId
 * - Only rows with TrialTime IS NOT NULL
 * - cust_status from FUM as of current_date()-1
 */
function buildExtractSql() {
  const funnel = funnelTable().fqn;
  const fum = factUserMasterTable().fqn;
  const upgrades = upgradeLogsTable().fqn;
  const sfdc = sfdcUserRoleTable().fqn;

  return `
WITH cust_status AS (
  SELECT DISTINCT
    company_id,
    stripe_subscription_status,
    land_mrr,
    closed_by_motion
  FROM ${fum}
  WHERE date_level = 'Day'
    AND date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND stripe_subscription_status IS NOT NULL
),

plan_upgrade_flag AS (
  SELECT
    companyid,
    previousPlan,
    changedToPlan,
    previousPlanId,
    changedToPlanId,
    DATE(insertedAt) AS overriden_date,
    1 AS limit_overriden_flag
  FROM ${upgrades}
  WHERE previousPlanId = @previousPlanId
    AND changedToPlanId = @changedToPlanId
  QUALIFY ROW_NUMBER() OVER (PARTITION BY companyid ORDER BY insertedAt) = 1
),

base AS (
  SELECT DISTINCT
    a.email,
    a.companyid,
    a.opportunity_id,
    a.TrialTime,
    a.TrialEndTime,
    a.property_returning_trial_user_flag,
    a.property_trial_reactivation,
    a.property_c_plan_type,
    a.subscription_plan,
    a.property_sales_team_owner,
    a.owner_id,
    smp1.name AS sfdc_owner_name,
    a.ae_owner_name,
    a.opp_created_owner_profile,
    a.opp_created_owner_profile_new,
    DATE_DIFF(DATE(a.TrialEndTime), DATE(a.TrialTime), DAY) AS trial_days_given,
    DATE_DIFF(DATE(a.CustomerTime), DATE(a.TrialTime), DAY) AS trial_to_cust_days,
    a.CustomerTime,
    COALESCE(a.land_mrr, cs.land_mrr) AS land_mrr,
    a.subscription_mrr,
    cs.stripe_subscription_status AS subscription_status,
    cs.closed_by_motion,
    pu.limit_overriden_flag,
    pu.overriden_date
  FROM ${funnel} a
  LEFT JOIN (
    SELECT *
    FROM ${sfdc}
    WHERE profile_name_c IN ('SDR', 'BDR', 'PS', 'AE')
  ) smp1
    ON CAST(smp1.id AS STRING) = CAST(a.owner_id AS STRING)
  LEFT JOIN cust_status cs
    ON a.companyid = cs.company_id
  LEFT JOIN plan_upgrade_flag pu
    ON a.companyid = pu.companyid
  WHERE a.TrialTime IS NOT NULL
    AND DATE(a.TrialTime) >= @rangeStart
)

SELECT *
FROM base
ORDER BY TrialTime DESC, email
`;
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
};
