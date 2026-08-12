-- Analyst reference copy of the Trial Extension extract.
-- Runtime SQL lives in src/queries.js → buildExtractSql().
--
-- Source query (stakeholder):
--   hubspot_migration.reporting_user_funnel_new_hs
--   + fact_user_master (cust status as of current_date()-1)
--   + upgradeDowngradeLogs (1194 → 100 = limit override)
--   + sfdc_user_role_hs (SDR/BDR/PS/AE) on owner_id
--
-- AE name precedence in the app:
--   ae_owner_name → smp1.name → property_sales_team_owner

WITH cust_status AS (
  SELECT DISTINCT
    company_id,
    stripe_subscription_status,
    land_mrr,
    closed_by_motion
  FROM `PROJECT.analytics_reporting.fact_user_master`
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
  FROM `PROJECT.justcall.upgradeDowngradeLogs`
  WHERE previousPlanId = 1194
    AND changedToPlanId = 100
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
  FROM `PROJECT.hubspot_migration.reporting_user_funnel_new_hs` a
  LEFT JOIN (
    SELECT *
    FROM `PROJECT.hubspot_migration.sfdc_user_role_hs`
    WHERE profile_name_c IN ('SDR', 'BDR', 'PS', 'AE')
  ) smp1
    ON CAST(smp1.id AS STRING) = CAST(a.owner_id AS STRING)
  LEFT JOIN cust_status cs
    ON a.companyid = cs.company_id
  LEFT JOIN plan_upgrade_flag pu
    ON a.companyid = pu.companyid
  WHERE a.TrialTime IS NOT NULL
    AND DATE(a.TrialTime) >= '2026-01-01'
)

SELECT *
FROM base
ORDER BY TrialTime DESC, email
;