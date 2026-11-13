-- One active Salesforce userid count per company per date.
--
-- FOR SYSTEM_TIME AS OF cannot do this. Its timestamp has to be a constant,
-- and BigQuery only keeps that history for 7 days, so it cannot fill previous
-- months. This reads the live table once and rebuilds each date from the
-- issued_at version that was current on that date.
--
-- date is the tracker row date.
-- active_sfuserids is the status = 0 count as of that date.
-- previous_day_active_sfuserids is the status = 0 count as of the day before.
-- Sandbox instance URLs are excluded.
-- {{SALESFORCE_INFO}} is replaced with the project-qualified table name.

WITH sfinfo_versions AS (
  SELECT
    CAST(userid AS INT64) AS userid,
    CAST(companyid AS INT64) AS companyid,
    status,
    sfuserid,
    issued_at_raw,
    DATE(TIMESTAMP_MILLIS(CAST(issued_at_raw AS INT64))) AS valid_from,
    instance_url
  FROM (
    SELECT
      userid,
      companyid,
      status,
      sfuserid,
      issued_at AS issued_at_raw,
      instance_url,
      ROW_NUMBER() OVER (
        PARTITION BY userid, DATE(TIMESTAMP_MILLIS(CAST(issued_at AS INT64)))
        ORDER BY issued_at DESC
      ) AS rn
    FROM {{SALESFORCE_INFO}}
    WHERE issued_at IS NOT NULL
      AND sfuserid IS NOT NULL
      AND userid IS NOT NULL
      AND companyid IS NOT NULL
      AND instance_url NOT LIKE '%sandbox.my.salesforce.com'
  )
  WHERE rn = 1
)

, sfinfo_spells AS (
  SELECT
    userid,
    companyid,
    status,
    sfuserid,
    valid_from,
    DATE_SUB(
      LEAD(valid_from) OVER (
        PARTITION BY userid
        ORDER BY valid_from, issued_at_raw
      ),
      INTERVAL 1 DAY
    ) AS valid_to
  FROM sfinfo_versions
)

, list_of_dates AS (
  SELECT date
  FROM UNNEST(GENERATE_DATE_ARRAY(
    DATE '2024-10-31',
    DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  )) AS date
)

, as_of AS (
  SELECT
    d.date,
    s.companyid,
    s.status,
    s.sfuserid
  FROM list_of_dates d
  INNER JOIN sfinfo_spells s
    ON d.date >= s.valid_from
   AND d.date <= IFNULL(s.valid_to, DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))
)

, daily_counts AS (
  SELECT
    date,
    companyid,
    COUNT(CASE WHEN status = 0 THEN sfuserid END) AS active_sfuserids
  FROM as_of
  GROUP BY 1, 2
)

SELECT
  date,
  companyid,
  active_sfuserids,
  IFNULL(
    LAG(active_sfuserids) OVER (PARTITION BY companyid ORDER BY date),
    0
  ) AS previous_day_active_sfuserids
FROM daily_counts
