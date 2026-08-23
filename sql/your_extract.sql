-- Source of truth for the Trial Extension extract.
-- src/queries.js reads this file at runtime:
--   • {{FUNNEL}} {{FUM}} {{UPGRADES}} {{SFDC}} {{LICENCE}} {{TRIAL_EXT}} {{ADMINPANEL}} → validated FQNs
--   • @rangeStart / @previousPlanId / @changedToPlanId stay bound params (not literals)
--
-- Console paste: replace tokens with `project.dataset.table` and declare the @params
-- (or inline 2026-01-01 / 1194 / 100).
--
-- Defaults (override via BQ_*_DATASET / BQ_*_TABLE env):
--   {{FUNNEL}}      hubspot_migration.reporting_user_funnel_new_hs
--   {{FUM}}         analytics_reporting.fact_user_master
--   {{UPGRADES}}    justcall.upgradeDowngradeLogs
--   {{SFDC}}        analytics_seed.hubspot_sfdc_user_role_hs
--   {{LICENCE}}     analytics_intermediate.int_licence_final_mrr
--   {{TRIAL_EXT}}   jc_mastermind.trial_extension
--   {{ADMINPANEL}}  justcall.adminpanel
--
-- Source query (stakeholder):
--   funnel + FUM (cust status as of current_date()-1)
--   + upgradeDowngradeLogs (1194 → 100 = Custom enterprise limit) + adminpanel.overriden_by_name
--   + sfdc_user_role_hs (SDR/BDR/PS/AE) on owner_id
--   + int_licence_final_mrr (is_contract as of current_date()-1, companyid = userid)
--   + trial_extension (latest extended_at per companyid) + adminpanel.extended_by_name
--
-- AE name precedence:
--   ae_owner_name → smp1.name → property_sales_team_owner → 'Self Serve'
-- plan_selected_new:
--   is_contract true  → COALESCE(property_c_plan_type, subscription_plan)
--   is_contract false → COALESCE(changeplan, property_c_plan_type, subscription_plan)

WITH cust_status AS (
  SELECT DISTINCT
    company_id,
    stripe_subscription_status,
    land_mrr,
    closed_by_motion
  FROM {{FUM}}
  WHERE date_level = 'Day'
    AND date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND stripe_subscription_status IS NOT NULL
),

plan_upgrade_flag AS (
  SELECT
    ud.companyid,
    ud.previousPlan,
    ud.changedToPlan,
    ud.previousPlanId,
    ud.changedToPlanId,
    DATE(ud.insertedAt) AS overriden_date,
    1 AS limit_overriden_flag,
    a.name AS overriden_by_name
  FROM {{UPGRADES}} ud
  LEFT JOIN (
    SELECT DISTINCT id, name
    FROM {{ADMINPANEL}}
  ) a
    ON CAST(ud.mmadminid AS STRING) = CAST(a.id AS STRING)
  WHERE ud.previousPlanId = @previousPlanId
    AND ud.changedToPlanId = @changedToPlanId
  QUALIFY ROW_NUMBER() OVER (PARTITION BY ud.companyid ORDER BY ud.insertedAt) = 1
),

contract_flag AS (
  SELECT DISTINCT
    userid,
    is_contract
  FROM {{LICENCE}}
  WHERE date_level = 'Day'
    AND mrr_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
),

extended_at_date AS (
  SELECT
    te.companyid,
    te.extended_by,
    a.name AS extended_by_name,
    DATE(te.extended_at) AS latest_extension_at_date
  FROM {{TRIAL_EXT}} te
  LEFT JOIN (
    SELECT DISTINCT id, name
    FROM {{ADMINPANEL}}
  ) a
    ON CAST(te.extended_by AS STRING) = CAST(a.id AS STRING)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY te.companyid ORDER BY te.extended_at DESC) = 1
),

latest_changeplan AS (
  SELECT
    companyid,
    changedToPlan AS changeplan
  FROM (
    SELECT *
    FROM {{UPGRADES}}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY companyid ORDER BY insertedAt DESC) = 1
  )
  WHERE changedToPlanId IN (@previousPlanId, @changedToPlanId)
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
    pu.overriden_date,
    pu.overriden_by_name,
    COALESCE(cf.is_contract, false) AS is_contract,
    ext.latest_extension_at_date,
    ext.extended_by_name,
    lp.changeplan,
    CASE
      WHEN COALESCE(cf.is_contract, false) THEN
        COALESCE(
          NULLIF(TRIM(CAST(a.property_c_plan_type AS STRING)), ''),
          NULLIF(TRIM(CAST(a.subscription_plan AS STRING)), '')
        )
      ELSE COALESCE(
        NULLIF(TRIM(CAST(lp.changeplan AS STRING)), ''),
        NULLIF(TRIM(CAST(a.property_c_plan_type AS STRING)), ''),
        NULLIF(TRIM(CAST(a.subscription_plan AS STRING)), '')
      )
    END AS plan_selected_new
  FROM {{FUNNEL}} a
  LEFT JOIN (
    SELECT *
    FROM {{SFDC}}
    WHERE profile_name_c IN ('SDR', 'BDR', 'PS', 'AE')
  ) smp1
    ON CAST(smp1.id AS STRING) = CAST(a.owner_id AS STRING)
  LEFT JOIN cust_status cs
    ON a.companyid = cs.company_id
  LEFT JOIN plan_upgrade_flag pu
    ON a.companyid = pu.companyid
  LEFT JOIN contract_flag cf
    ON CAST(a.companyid AS STRING) = CAST(cf.userid AS STRING)
  LEFT JOIN extended_at_date ext
    ON CAST(a.companyid AS STRING) = CAST(ext.companyid AS STRING)
  LEFT JOIN latest_changeplan lp
    ON CAST(a.companyid AS STRING) = CAST(lp.companyid AS STRING)
  WHERE a.TrialTime IS NOT NULL
    AND DATE(a.TrialTime) >= @rangeStart
)

SELECT
  * EXCEPT (ae_owner_name),
  COALESCE(
    NULLIF(TRIM(CAST(ae_owner_name AS STRING)), ''),
    NULLIF(TRIM(CAST(sfdc_owner_name AS STRING)), ''),
    NULLIF(TRIM(CAST(property_sales_team_owner AS STRING)), ''),
    'Self Serve'
  ) AS ae_owner_name
FROM (
  SELECT *
  FROM base
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY COALESCE(CAST(companyid AS STRING), CONCAT('email:', CAST(email AS STRING)))
    ORDER BY
      CASE WHEN CustomerTime IS NOT NULL THEN 0 ELSE 1 END,
      TrialTime DESC,
      CASE
        WHEN NULLIF(TRIM(CAST(ae_owner_name AS STRING)), '') IS NOT NULL THEN 0
        WHEN NULLIF(TRIM(CAST(sfdc_owner_name AS STRING)), '') IS NOT NULL THEN 0
        WHEN NULLIF(TRIM(CAST(property_sales_team_owner AS STRING)), '') IS NOT NULL THEN 0
        ELSE 1
      END,
      email
  ) = 1
)
ORDER BY TrialTime DESC, email
;