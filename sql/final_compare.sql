-- Joins company_day to the yesterday snapshot CTE (previous_sf) and adds
-- the comparison and flag columns. queries.js prepends previous_sf from the
-- rows returned by sql/sfinfo_previous.sql. No BigQuery session is used.

WITH compared AS (
  SELECT
    b.date,
    b.companyid,
    b.company_status,
    b.previous_day_plan,
    b.current_day_plan,
    CASE
      WHEN b.current_day_plan IS NOT NULL
       AND b.previous_day_plan IS NOT NULL
       AND b.current_day_plan <> b.previous_day_plan
      THEN 1
      ELSE 0
    END AS plan_change_flag,
    b.current_active_users,
    b.previous_day_active_users,
    b.active_users_difference,
    CASE
      WHEN b.active_users_difference <> 0 THEN 1
      ELSE 0
    END AS active_users_change_flag,
    b.current_active_salesforce_integrations,
    CASE
      WHEN b.is_latest_date = 1 THEN IFNULL(p.previous_day_active_sfuserids, 0)
    END AS previous_day_active_sfuserids,
    CASE
      WHEN b.is_latest_date = 1
      THEN IFNULL(b.latest_active_users_integrations, 0)
         - IFNULL(p.previous_day_active_sfuserids, 0)
    END AS active_sfuserids_difference,
    CASE
      WHEN b.is_latest_date = 1
       AND IFNULL(b.latest_active_users_integrations, 0)
         - IFNULL(p.previous_day_active_sfuserids, 0) <> 0
      THEN 1
      ELSE 0
    END AS active_sfuserids_change_flag,
    b.latest_integrations,
    b.latest_active_users_integrations,
    b.latest_inactive_users_integrations
  FROM company_day b
  LEFT JOIN previous_sf p
    ON b.companyid = p.companyid
   AND b.is_latest_date = 1
)

SELECT
  date,
  companyid,
  company_status,
  previous_day_plan,
  current_day_plan,
  plan_change_flag,
  current_active_users,
  previous_day_active_users,
  active_users_difference,
  active_users_change_flag,
  current_active_salesforce_integrations,
  previous_day_active_sfuserids,
  active_sfuserids_difference,
  active_sfuserids_change_flag,
  latest_integrations,
  latest_active_users_integrations,
  latest_inactive_users_integrations
FROM compared
WHERE plan_change_flag = 1
   OR active_users_change_flag = 1
   OR active_sfuserids_change_flag = 1
ORDER BY date DESC, companyid
