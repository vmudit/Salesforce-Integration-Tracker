/**
 * salesforce_integration_log.csv is the dashboard sheet.
 * Each closed day is appended once. The page reads the whole file.
 */
const fs = require("fs");
const path = require("path");
const { COLUMNS } = require("./transform");

const LOG_PATH = path.join(__dirname, "..", "salesforce_integration_log.csv");
const DATES_PATH = path.join(__dirname, "..", "salesforce_integration_log.dates");

function csvEscape(column, value) {
  if (value == null || value === "") return "";
  let text = String(value);
  if (column.type === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

function unescapeCell(value) {
  if (typeof value !== "string") return value;
  if (value.length > 1 && value[0] === "'" && /^[=+\-@\t\r]/.test(value.slice(1))) {
    return value.slice(1);
  }
  return value;
}

function headerLine() {
  return COLUMNS.map((column) => column.key).join(",");
}

function recordsFromCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const header = table[0];
  const expected = COLUMNS.map((column) => column.key);
  if (header.length !== expected.length || header.some((key, index) => key !== expected[index])) {
    const err = new Error("salesforce_integration_log.csv header does not match the dashboard columns");
    err.code = "SHEET_LOG_INVALID";
    throw err;
  }
  return table.slice(1).map((cells) => {
    const record = {};
    COLUMNS.forEach((column, index) => {
      const raw = cells[index] == null ? "" : cells[index];
      record[column.key] = raw === "" ? null : unescapeCell(raw);
    });
    return record;
  });
}

function formatLog(records) {
  const lines = [headerLine()];
  for (const record of records) {
    lines.push(COLUMNS.map((column) => csvEscape(column, record[column.key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function readLoadedDates() {
  try {
    const text = fs.readFileSync(DATES_PATH, "utf8");
    return new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line))
    );
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

function readLog() {
  let text = "";
  try {
    text = fs.readFileSync(LOG_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const records = recordsFromCsv(text);
  records.sort((a, b) => {
    const byDate = String(b.date || "").localeCompare(String(a.date || ""));
    if (byDate !== 0) return byDate;
    return String(a.companyid || "").localeCompare(String(b.companyid || ""), undefined, {
      numeric: true,
    });
  });
  return records;
}

function dateIsStored(snapshotDate) {
  if (readLoadedDates().has(snapshotDate)) return true;
  return readLog().some((row) => row.date === snapshotDate);
}

function writeAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

/**
 * Appends one closed day. A date already present is left unchanged.
 * Returns the number of rows written.
 */
function appendDay(snapshotDate, records) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    const err = new Error("snapshot date must be YYYY-MM-DD");
    err.code = "SHEET_LOG_INVALID";
    throw err;
  }
  if (dateIsStored(snapshotDate)) return 0;

  const existing = readLog();
  const dayRows = (Array.isArray(records) ? records : []).filter((row) => row && row.date === snapshotDate);
  writeAtomic(LOG_PATH, formatLog(existing.concat(dayRows)));

  const loaded = readLoadedDates();
  loaded.add(snapshotDate);
  const dates = Array.from(loaded).sort().join("\n");
  writeAtomic(DATES_PATH, dates ? `${dates}\n` : "");
  return dayRows.length;
}

module.exports = {
  LOG_PATH,
  DATES_PATH,
  parseCsv,
  formatLog,
  recordsFromCsv,
  readLog,
  dateIsStored,
  appendDay,
};
