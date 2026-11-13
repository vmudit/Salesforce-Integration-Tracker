-- Review draft. company_base.sql and final_compare.sql are unchanged.
--
-- 1. list_of_dates is every date from 2024-11-01 through yesterday.
-- 2. Each companyid is counted on each of those dates, so the result has a date column.
-- 3. FOR SYSTEM_TIME AS OF is that date minus 1 day.
--    A row dated 2026-11-13 reads the table as of 2026-11-12.
--
-- The snapshot for a date is midnight UTC at the start of the previous day.
-- A company is kept on a date when it has at least one status = 0 sfuserid.
-- {{SALESFORCE_INFO}} is replaced with the project-qualified table name.
--
-- BigQuery accepts FOR SYSTEM_TIME AS OF only when the timestamp is a constant.
-- TIMESTAMP_SUB(TIMESTAMP(d.date), INTERVAL 1 DAY) still uses a column, so this statement fails with
-- "FOR SYSTEM_TIME AS OF expression must be constant".
-- Time travel also covers only the last 7 days. Dates older than that window
-- have no snapshot to read.

WITH list_of_dates AS (
  SELECT date
  FROM UNNEST(GENERATE_DATE_ARRAY(
    DATE '2024-11-01',
    DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  )) AS date
)

, snapshot_on_date AS (
  SELECT
    d.date,
    CAST(s.companyid AS INT64) AS companyid,
    s.status,
    s.sfuserid,
    DATE(TIMESTAMP_MILLIS(CAST(s.issued_at AS INT64))) AS issued_at,
    s.instance_url,
    ROW_NUMBER() OVER (
      PARTITION BY d.date, s.userid
      ORDER BY s.issued_at DESC
    ) AS rn
  FROM list_of_dates d
  CROSS JOIN {{SALESFORCE_INFO}} FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(TIMESTAMP(d.date), INTERVAL 1 DAY) AS s
  WHERE s.issued_at IS NOT NULL
    AND s.sfuserid IS NOT NULL
    AND s.userid IS NOT NULL
    AND s.companyid IS NOT NULL
)

SELECT
  date,
  companyid,
  previous_day_active_sfuserids
FROM (
  SELECT
    date,
    companyid,
    COUNT(CASE WHEN status = 0 THEN sfuserid END) AS previous_day_active_sfuserids
  FROM snapshot_on_date
  WHERE rn = 1
    AND issued_at IS NOT NULL
    AND instance_url NOT LIKE '%sandbox.my.salesforce.com'
  GROUP BY 1, 2
)
WHERE previous_day_active_sfuserids > 0
ORDER BY date, companyid
