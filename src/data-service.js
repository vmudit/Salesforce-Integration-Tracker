const { runQuery, isBigQueryConfigured, unwrapBqValue } = require("./bigquery");
const { buildTrackerQueries } = require("./queries");
const { buildPayload } = require("./transform");
const { buildDemoRows } = require("./demo-data");

let lastRefresh = null;

function demoModeEnabled() {
  const raw =
    process.env.DEMO_MODE ??
    process.env.Demo_Mode ??
    process.env.demo_mode ??
    "";
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function notConfigured() {
  const err = new Error("BigQuery is not configured");
  err.code = "BIGQUERY_NOT_CONFIGURED";
  return err;
}

function asQueryInt(value) {
  const raw = unwrapBqValue(value);
  if (raw == null || raw === "") return null;
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) ? String(raw) : null;
  }
  if (typeof raw === "object" && raw !== null && typeof raw.valueOf === "function") {
    const unwrapped = raw.valueOf();
    if (typeof unwrapped === "string" && /^-?\d+$/.test(unwrapped)) return unwrapped;
    if (typeof unwrapped === "number" && Number.isSafeInteger(unwrapped)) return String(unwrapped);
  }
  const text = String(raw).trim();
  return /^-?\d+$/.test(text) ? text : null;
}

function previousSnapshotParam(rows) {
  const byCompany = new Map();
  for (const row of rows) {
    const companyid = asQueryInt(row.companyid);
    const previous = asQueryInt(row.previous_day_active_sfuserids);
    if (companyid == null || previous == null) continue;
    byCompany.set(companyid, {
      companyid,
      previous_day_active_sfuserids: previous,
    });
  }
  return Array.from(byCompany.values());
}

function prefixStep(err, step) {
  err.message = `${step}: ${err.message}`;
  err.step = step;
  return err;
}

/**
 * Runs the Salesforce tracker extract and builds the table payload.
 * Throws when the self-check fails so a bad payload is never cached or served.
 *
 * When DEMO_MODE=1, returns synthetic rows (no BigQuery call) for local UI review.
 */
async function fetchData() {
  const startedAt = Date.now();
  let rows;
  let queryMs;
  const isDemo = demoModeEnabled();

  if (isDemo) {
    rows = buildDemoRows();
    queryMs = Date.now() - startedAt;
  } else {
    if (!isBigQueryConfigured()) throw notConfigured();
    const { previousSql, compareSql } = buildTrackerQueries();
    let previousRows;
    try {
      previousRows = await runQuery(previousSql);
    } catch (err) {
      throw prefixStep(err, "sfinfo_previous");
    }
    const previousSf = previousSnapshotParam(previousRows);
    console.log(`[tracker] sfinfo_previous companies=${previousSf.length}`);
    if (previousSf.length === 0) {
      rows = [];
    } else {
      try {
        rows = await runQuery(
          compareSql,
          { previous_sf: previousSf },
          {
            previous_sf: [
              { companyid: "INT64", previous_day_active_sfuserids: "INT64" },
            ],
          }
        );
      } catch (err) {
        throw prefixStep(err, "final_compare");
      }
      console.log(`[tracker] final_compare rows=${rows.length}`);
    }
    queryMs = Date.now() - startedAt;
  }

  const { payload, checks } = buildPayload(rows, { demoMode: isDemo });

  if (!checks.ok || !payload) {
    const err = new Error(`Self-check failed: ${checks.errors.join("; ")}`);
    err.code = "SELF_CHECK_FAILED";
    err.checks = checks;
    throw err;
  }

  checks.warnings.forEach((w) => console.warn(`[self-check warning] ${w}`));

  const buildMs = Date.now() - startedAt - queryMs;
  lastRefresh = {
    at: new Date().toISOString(),
    queryMs,
    buildMs,
    rowCount: rows.length,
    warnings: checks.warnings,
    demoMode: isDemo,
  };

  console.log(
    `[self-check OK] demo=${isDemo} rows=${rows.length} query=${queryMs}ms build=${buildMs}ms`
  );

  const isEmpty =
    (Array.isArray(payload.records) && payload.records.length === 0) ||
    rows.length === 0;

  return { payload, checks, isEmpty };
}

function getLastRefresh() {
  return lastRefresh;
}

module.exports = { fetchData, getLastRefresh, demoModeEnabled };
