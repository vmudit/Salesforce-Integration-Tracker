-- Joins each company-day to sfinfo_by_date on companyid and date.
-- previous_day_active_sfuserids is the status = 0 count on the day before
-- that row's date, including previous months.
-- The difference is that date's count minus the day before.
-- latest_* stays the live snapshot and is still only filled on yesterday.

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
    IFNULL(p.previous_day_active_sfuserids, 0) AS previous_day_active_sfuserids,
    IFNULL(p.active_sfuserids, 0) - IFNULL(p.previous_day_active_sfuserids, 0) AS active_sfuserids_difference,
    CASE
      WHEN IFNULL(p.active_sfuserids, 0) - IFNULL(p.previous_day_active_sfuserids, 0) <> 0
      THEN 1
      ELSE 0
    END AS active_sfuserids_change_flag,
    b.latest_integrations,
    b.latest_active_users_integrations,
    b.latest_inactive_users_integrations
  FROM company_day b
  LEFT JOIN sfinfo_by_date p
    ON b.companyid = p.companyid
   AND b.date = p.date
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
