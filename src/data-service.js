const { runQuery, isBigQueryConfigured, unwrapBqValue, getBigQueryClient } = require("./bigquery");
const {
  buildTrackerQueries,
  buildSheetEnsureSql,
  buildSheetStatusSql,
  buildSheetReadSql,
  buildYesterdaySql,
  buildSheetMergeSql,
  buildSheetMarkDaySql,
  sheetRowType,
} = require("./queries");
const { COLUMNS, buildPayload } = require("./transform");
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

async function ensureSheetTables() {
  for (const sql of buildSheetEnsureSql()) {
    try {
      await runQuery(sql);
    } catch (err) {
      throw prefixStep(err, "sheet_ensure");
    }
  }
}

async function yesterdayIsStored() {
  let rows;
  try {
    rows = await runQuery(buildSheetStatusSql());
  } catch (err) {
    throw prefixStep(err, "sheet_status");
  }
  const loaded = Number(unwrapBqValue(rows[0] && rows[0].loaded));
  return Number.isFinite(loaded) && loaded > 0;
}

function asDate(value) {
  const raw = unwrapBqValue(value);
  if (raw == null || raw === "") return null;
  const text = String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function toSheetValue(column, value, bq) {
  if (value == null || value === "") return null;
  if (column.type === "date") return bq.date(String(value).slice(0, 10));
  if (column.type === "string") return String(value);
  return String(value);
}

/**
 * Runs yesterday's extract once and appends that date to the sheet.
 * A later run on the same day finds the ledger row and does not append again.
 */
async function appendYesterday() {
  let dateRows;
  try {
    dateRows = await runQuery(buildYesterdaySql());
  } catch (err) {
    throw prefixStep(err, "sheet_date");
  }
  const snapshotDate = asDate(dateRows[0] && dateRows[0].snapshot_date);
  if (!snapshotDate) {
    const err = new Error("BigQuery did not return yesterday's date");
    err.code = "BIGQUERY_ERROR";
    throw prefixStep(err, "sheet_date");
  }

  const { previousSql, compareSql } = buildTrackerQueries();
  let previousRows;
  try {
    previousRows = await runQuery(previousSql);
  } catch (err) {
    throw prefixStep(err, "sfinfo_previous");
  }
  const previousSf = previousSnapshotParam(previousRows);
  console.log(`[sheet] sfinfo_previous companies=${previousSf.length} date=${snapshotDate}`);

  let dayRows = [];
  if (previousSf.length > 0) {
    let compareRows;
    try {
      compareRows = await runQuery(
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
    const { payload, checks } = buildPayload(compareRows);
    if (!checks.ok || !payload) {
      const err = new Error(`Self-check failed: ${checks.errors.join("; ")}`);
      err.code = "SELF_CHECK_FAILED";
      throw prefixStep(err, "final_compare");
    }
    dayRows = payload.records.filter((row) => row.date === snapshotDate);
  }

  const bq = getBigQueryClient();
  try {
    if (dayRows.length > 0) {
      await runQuery(
        buildSheetMergeSql(),
        {
          day_rows: dayRows.map((row) => {
            const out = {};
            for (const column of COLUMNS) out[column.key] = toSheetValue(column, row[column.key], bq);
            return out;
          }),
        },
        { day_rows: [sheetRowType()] }
      );
    }
    await runQuery(
      buildSheetMarkDaySql(),
      { snapshot_date: snapshotDate, row_count: String(dayRows.length) },
      { snapshot_date: "DATE", row_count: "INT64" }
    );
  } catch (err) {
    throw prefixStep(err, "sheet_append");
  }
  console.log(`[sheet] appended date=${snapshotDate} rows=${dayRows.length}`);
}

async function readSheet() {
  try {
    return await runQuery(buildSheetReadSql());
  } catch (err) {
    throw prefixStep(err, "sheet_read");
  }
}

/**
 * Serves the accumulated daily sheet.
 * On the first load of a day, appends yesterday's change rows, then reads
 * every stored day. Filters and sorting stay in the page.
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
    await ensureSheetTables();
    if (!(await yesterdayIsStored())) {
      await appendYesterday();
    } else {
      console.log("[sheet] yesterday already stored");
    }
    rows = await readSheet();
    console.log(`[sheet] rows=${rows.length}`);
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
