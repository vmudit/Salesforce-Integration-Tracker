-- Yesterday's Salesforce userid snapshot.
-- This is its own BigQuery job. salesforce_info is referenced only with
-- FOR SYSTEM_TIME AS OF, never alongside a live read of the same table.
--
-- One row per company that had at least one status = 0 sfuserid
-- on the table as of CURRENT_TIMESTAMP() - 1 day.
-- {{SALESFORCE_INFO}} is replaced with the project-qualified table name.

SELECT
  companyid,
  previous_day_active_sfuserids
FROM (
  SELECT
    CAST(companyid AS INT64) AS companyid,
    COUNT(CASE WHEN status = 0 THEN sfuserid END) AS previous_day_active_sfuserids
  FROM (
    SELECT
      companyid,
      status,
      sfuserid,
      DATE(TIMESTAMP_MILLIS(CAST(issued_at AS INT64))) AS issued_at,
      instance_url,
      ROW_NUMBER() OVER (PARTITION BY userid ORDER BY issued_at DESC) AS rn
    FROM {{SALESFORCE_INFO}}
    FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
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
WHERE previous_day_active_sfuserids > 0
