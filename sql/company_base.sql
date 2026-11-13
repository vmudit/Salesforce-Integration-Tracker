-- Company-day extract. Live salesforce_info for the latest_* columns is read
-- here. Per-date Salesforce userid counts come from sfinfo_by_date, which
-- final_compare joins on companyid and date.
--
-- The company list is companies with at least one status = 0 sfuserid
-- as of yesterday.
-- latest_active_users_integrations is the live status = 0 count.
-- latest_inactive_users_integrations is the live status = -3 count.
--
-- Defaults (override via BQ_*_DATASET / BQ_*_TABLE):
--   {{FACT_USER_MASTER}}   analytics_reporting.fact_user_master
--   {{JUSTCALL_USERS}}     analytics_intermediate.justcall_users
--   {{INTERNAL_EMAILS}}    analytics_intermediate.int_internal_emails
--   {{INT_LOGS_STATUS}}    justcall.int_logs_status
--   {{INT_CONNECT_JCLIVE}} justcall.int_connect_jclive
--   {{SALESFORCE_INFO}}    jclive.salesforce_info

WITH list_of_dates AS (
  SELECT date
  FROM UNNEST(GENERATE_DATE_ARRAY(
    DATE '2024-11-01',
    DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  )) AS date
)

, plan_status AS (
  SELECT
    CAST(company_id AS INT64) AS companyid,
    date,
    CASE
      WHEN subscription_plan_type = 'ProPlus' THEN 'Proplus'
      ELSE subscription_plan_type
    END AS plan_type,
    stripe_subscription_status AS company_status
  FROM {{FACT_USER_MASTER}}
  WHERE date_level = 'Day'
    AND date BETWEEN DATE '2024-10-31' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND company_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY company_id, date
    ORDER BY company_id
  ) = 1
)

, companies AS (
  SELECT
    companyid,
    MIN(date) AS first_date
  FROM plan_status
  WHERE date >= DATE '2024-11-01'
  GROUP BY 1
)

, company_dates AS (
  SELECT
    c.companyid,
    d.date
  FROM companies c
  INNER JOIN list_of_dates d
    ON d.date >= c.first_date
)

, jc_users_clean AS (
  SELECT
    CAST(userid AS INT64) AS userid,
    CAST(companyid AS INT64) AS companyid,
    status,
    inserted_at_time,
    LOWER(TRIM(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(SPLIT(
      email,
      '_removed2')[OFFSET(0)],
      '_removed')[OFFSET(0)],
      '__toberemoved')[OFFSET(0)],
      '-cancel')[OFFSET(0)],
      '_cancel')[OFFSET(0)],
      '_remove')[OFFSET(0)],
      '_remmoved')[OFFSET(0)],
      '_rem')[OFFSET(0)],
      '-rem')[OFFSET(0)],
      '-cancelled')[OFFSET(0)],
      '_cancelled')[OFFSET(0)],
      '_tobedelete')[OFFSET(0)],
      '_delete')[OFFSET(0)],
      '_duplicate')[OFFSET(0)])) AS email
  FROM {{JUSTCALL_USERS}}
  WHERE email IS NOT NULL
    AND DATE(inserted_at_time) >= DATE '2024-10-31'
    AND DATE(inserted_at_time) <= DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
)

, jc_users_kept AS (
  SELECT u.*
  FROM jc_users_clean u
  LEFT JOIN {{INTERNAL_EMAILS}} ie
    ON u.email = ie.email
   AND ie.email IS NOT NULL
  WHERE u.email IS NOT NULL
    AND TRIM(u.email) != ''
    AND ie.email IS NULL
)

, jc_users_daily AS (
  SELECT
    DATE(inserted_at_time) AS snapshot_date,
    userid,
    companyid,
    status
  FROM jc_users_kept
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY userid, DATE(inserted_at_time)
    ORDER BY inserted_at_time DESC
  ) = 1
)

, active_users_daily AS (
  SELECT
    companyid,
    snapshot_date,
    COUNT(DISTINCT userid) AS active_users
  FROM jc_users_daily
  WHERE status = 0
  GROUP BY 1, 2
)

, jc_latest_user AS (
  SELECT userid
  FROM jc_users_kept
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY userid
    ORDER BY inserted_at_time DESC
  ) = 1
)

, sf_events AS (
  SELECT
    CAST(userid AS INT64) AS userid,
    CAST(companyid AS INT64) AS companyid,
    LOWER(actiontype) AS actiontype,
    CAST(created_at AS DATETIME) AS created_at
  FROM {{INT_LOGS_STATUS}}
  WHERE LOWER(REGEXP_REPLACE(IFNULL(integration, ''), r'\s+', '')) = 'salesforce'
    AND userid IS NOT NULL

  UNION ALL

  SELECT
    CAST(userid AS INT64) AS userid,
    CAST(CASE WHEN managerid = 0 THEN userid ELSE managerid END AS INT64) AS companyid,
    CASE WHEN salesforce = 1 THEN 'active' ELSE 'disabled' END AS actiontype,
    DATETIME('2023-04-16') AS created_at
  FROM {{INT_CONNECT_JCLIVE}}
  WHERE inserted_at = '2023-04-16'
    AND salesforce = 1
    AND userid IS NOT NULL
)

, sf_versions AS (
  SELECT
    e.userid,
    e.companyid,
    DATE(e.created_at) AS version_date,
    e.actiontype
  FROM sf_events e
  INNER JOIN jc_latest_user u
    ON e.userid = u.userid
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY e.userid, DATE(e.created_at)
    ORDER BY e.created_at DESC
  ) = 1
)

, sf_spells AS (
  SELECT
    companyid,
    userid,
    version_date AS valid_from,
    DATE_SUB(
      LEAD(version_date) OVER (PARTITION BY userid ORDER BY version_date),
      INTERVAL 1 DAY
    ) AS valid_to,
    actiontype
  FROM sf_versions
)

, sf_active_spells AS (
  SELECT
    companyid,
    userid,
    valid_from,
    IFNULL(valid_to, DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) AS valid_to
  FROM sf_spells
  WHERE actiontype IN ('connected', 'active')
    AND IFNULL(valid_to, DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) >= DATE '2024-10-31'
)

, sf_running AS (
  SELECT
    companyid,
    date,
    SUM(delta) OVER (
      PARTITION BY companyid
      ORDER BY date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS active_salesforce_integrations
  FROM (
    SELECT companyid, date, SUM(delta) AS delta
    FROM (
      SELECT
        companyid,
        GREATEST(valid_from, DATE '2024-10-31') AS date,
        1 AS delta
      FROM sf_active_spells

      UNION ALL

      SELECT
        companyid,
        DATE_ADD(valid_to, INTERVAL 1 DAY) AS date,
        -1 AS delta
      FROM sf_active_spells
      WHERE valid_to < DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    )
    WHERE date BETWEEN DATE '2024-10-31' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    GROUP BY 1, 2
  )
)

, sf_companies AS (
  SELECT DISTINCT companyid
  FROM sf_running
)

, sf_filled AS (
  SELECT
    companyid,
    date,
    IFNULL(
      LAST_VALUE(active_salesforce_integrations IGNORE NULLS) OVER (
        PARTITION BY companyid
        ORDER BY date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      0
    ) AS active_salesforce_integrations
  FROM (
    SELECT
      d.companyid,
      d.date,
      r.active_salesforce_integrations
    FROM (
      SELECT cd.companyid, cd.date
      FROM company_dates cd
      INNER JOIN sf_companies s
        ON cd.companyid = s.companyid

      UNION DISTINCT

      SELECT c.companyid, DATE_SUB(c.first_date, INTERVAL 1 DAY) AS date
      FROM companies c
      INNER JOIN sf_companies s
        ON c.companyid = s.companyid

      UNION DISTINCT

      SELECT companyid, date
      FROM sf_running
    ) d
    LEFT JOIN sf_running r
      ON d.companyid = r.companyid
     AND d.date = r.date
  )
)

-- Live table. This is the current / today snapshot.
, sfinfo_current AS (
  SELECT
    CAST(companyid AS INT64) AS companyid,
    COUNT(CASE WHEN status = 0 OR status = 3 OR status = -3 THEN sfuserid END) AS latest_integrations,
    COUNT(CASE WHEN status = 0 THEN sfuserid END) AS latest_active_users_integrations,
    COUNT(CASE WHEN status = -3 THEN sfuserid END) AS latest_inactive_users_integrations
  FROM (
    SELECT
      companyid,
      status,
      sfuserid,
      DATE(TIMESTAMP_MILLIS(CAST(issued_at AS INT64))) AS issued_at,
      instance_url,
      ROW_NUMBER() OVER (PARTITION BY userid ORDER BY issued_at DESC) AS rn
    FROM {{SALESFORCE_INFO}}
    WHERE issued_at IS NOT NULL
      AND sfuserid IS NOT NULL
      AND userid IS NOT NULL
      AND companyid IS NOT NULL
  )
  WHERE rn = 1
    AND issued_at IS NOT NULL
    AND instance_url NOT LIKE '%sandbox.my.salesforce.com'
  GROUP BY 1
)

, company_day AS (
  SELECT
    cd.date,
    cd.companyid,
    curr.company_status,
    prev.plan_type AS previous_day_plan,
    curr.plan_type AS current_day_plan,
    IFNULL(ua.active_users, 0) AS current_active_users,
    IFNULL(up.active_users, 0) AS previous_day_active_users,
    IFNULL(ua.active_users, 0) - IFNULL(up.active_users, 0) AS active_users_difference,
    CASE
      WHEN UPPER(IFNULL(curr.company_status, '')) = 'CANCELED' THEN 0
      ELSE IFNULL(sf.active_salesforce_integrations, 0)
    END AS current_active_salesforce_integrations,
    CASE
      WHEN cd.date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) THEN 1
      ELSE 0
    END AS is_latest_date,
    CASE
      WHEN cd.date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      THEN IFNULL(sc.latest_integrations, 0)
    END AS latest_integrations,
    CASE
      WHEN cd.date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      THEN IFNULL(sc.latest_active_users_integrations, 0)
    END AS latest_active_users_integrations,
    CASE
      WHEN cd.date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      THEN IFNULL(sc.latest_inactive_users_integrations, 0)
    END AS latest_inactive_users_integrations
  FROM company_dates cd
  INNER JOIN (
    SELECT companyid
    FROM sfinfo_by_date
    WHERE date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      AND active_sfuserids > 0
  ) cur
    ON cd.companyid = cur.companyid
  LEFT JOIN plan_status curr
    ON cd.companyid = curr.companyid
   AND cd.date = curr.date
  LEFT JOIN plan_status prev
    ON cd.companyid = prev.companyid
   AND prev.date = DATE_SUB(cd.date, INTERVAL 1 DAY)
  LEFT JOIN active_users_daily ua
    ON cd.companyid = ua.companyid
   AND cd.date = ua.snapshot_date
  LEFT JOIN active_users_daily up
    ON cd.companyid = up.companyid
   AND up.snapshot_date = DATE_SUB(cd.date, INTERVAL 1 DAY)
  LEFT JOIN sf_filled sf
    ON cd.companyid = sf.companyid
   AND cd.date = sf.date
  LEFT JOIN sfinfo_current sc
    ON cd.companyid = sc.companyid
   AND cd.date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
)
