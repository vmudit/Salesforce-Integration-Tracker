/**
 * Maps BigQuery tracker rows to a plain JSON payload.
 * Null stays null — several measures exist only on the latest date row.
 */
const { unwrapBqValue } = require("./bigquery");

const COLUMNS = [
  { key: "date", label: "Date", type: "date" },
  { key: "companyid", label: "Company ID", type: "id" },
  { key: "company_status", label: "Company Status", type: "string" },
  { key: "previous_day_plan", label: "Previous Day Plan", type: "string" },
  { key: "current_day_plan", label: "Current Day Plan", type: "string" },
  { key: "plan_change_flag", label: "Plan Change", type: "flag" },
  { key: "current_active_users", label: "Current Active Users", type: "number" },
  { key: "previous_day_active_users", label: "Previous Day Active Users", type: "number" },
  { key: "active_users_difference", label: "Active Users Difference", type: "number" },
  { key: "active_users_change_flag", label: "Active Users Change", type: "flag" },
  {
    key: "current_active_salesforce_integrations",
    label: "Current Active Salesforce Integrations",
    type: "number",
  },
  {
    key: "previous_day_active_sfuserids",
    label: "Previous Day Active SF User IDs",
    type: "number",
  },
  { key: "active_sfuserids_difference", label: "Active SF User IDs Difference", type: "number" },
  { key: "active_sfuserids_change_flag", label: "Active SF User IDs Change", type: "flag" },
  { key: "latest_integrations", label: "Latest Integrations", type: "number" },
  {
    key: "latest_active_users_integrations",
    label: "Latest Active Users Integrations",
    type: "number",
  },
  {
    key: "latest_inactive_users_integrations",
    label: "Latest Inactive Users Integrations",
    type: "number",
  },
];

function toDateStr(value) {
  const raw = unwrapBqValue(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toId(value) {
  const raw = unwrapBqValue(value);
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s) && s.replace("-", "").length <= 15) return Number(s);
  return s;
}

function toNumber(value) {
  const raw = unwrapBqValue(value);
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "object" && typeof raw.toNumber === "function") {
    const n = raw.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toText(value) {
  const raw = unwrapBqValue(value);
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

function normalizeRow(row) {
  const out = {};
  for (const col of COLUMNS) {
    const value = row[col.key];
    if (col.type === "date") out[col.key] = toDateStr(value);
    else if (col.type === "id") out[col.key] = toId(value);
    else if (col.type === "string") out[col.key] = toText(value);
    else out[col.key] = toNumber(value);
  }
  return out;
}

function buildPayload(rows, options = {}) {
  const errors = [];
  if (!Array.isArray(rows)) errors.push("extract did not return an array");

  const records = errors.length ? [] : rows.map(normalizeRow);
  const missingKey = records.find((row) => row.date == null || row.companyid == null);
  if (missingKey) errors.push("a row is missing date or companyid");

  return {
    payload: {
      columns: COLUMNS,
      records: errors.length ? [] : records,
      rowCount: errors.length ? 0 : records.length,
      demoMode: Boolean(options.demoMode),
      generatedAt: new Date().toISOString(),
    },
    checks: {
      ok: errors.length === 0,
      errors,
      warnings: [],
    },
  };
}

module.exports = { COLUMNS, buildPayload };
