/**
 * TEMPLATE — turn BigQuery rows into the JSON your UI needs.
 *
 * data-service.js expects:
 *   buildPayload(rows) → { payload, checks: { ok, errors[], warnings[] } }
 * If checks.ok is false, the server refuses to cache/serve the payload.
 */
const { coerceNumber, coerceString } = require("./bigquery");

function buildPayload(rows) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(rows)) {
    return { payload: null, checks: { ok: false, errors: ["rows is not an array"], warnings } };
  }

  // Example: pass rows through with light coercion. Replace with your maths.
  const records = rows.map((r, i) => ({
    id: coerceString(r.id ?? r.company_id ?? i),
    // map columns you care about…
  }));

  const payload = {
    generatedAt: new Date().toISOString(),
    rowCount: records.length,
    records,
    // cards / meta / charts — shape this for public/index.html
  };

  if (records.length === 0) {
    warnings.push("Extract returned 0 rows");
  }

  return {
    payload,
    checks: { ok: errors.length === 0, errors, warnings },
  };
}

module.exports = { buildPayload };
