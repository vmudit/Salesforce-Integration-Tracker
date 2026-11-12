const { BigQuery } = require("@google-cloud/bigquery");

let client = null;
let configured = false;
let credentialsCache = null;

function parseCredentials() {
  if (credentialsCache) return credentialsCache;
  const json =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.Google_Credentials_JSON ||
    process.env.GOOGLE_CREDENTIALS_JSON;
  if (!json) return null;
  try {
    credentialsCache = JSON.parse(json);
    return credentialsCache;
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON");
  }
}

function getProjectId() {
  const credentials = parseCredentials();
  return process.env.BQ_PROJECT_ID || credentials?.project_id || null;
}

function getBigQueryClient() {
  if (client) return client;

  const credentials = parseCredentials();
  const projectId = getProjectId();

  if (!credentials || !projectId) {
    return null;
  }

  client = new BigQuery({ projectId, credentials });
  configured = true;
  return client;
}

function isBigQueryConfigured() {
  if (configured) return true;
  return Boolean(parseCredentials() && getProjectId() && getBigQueryClient());
}

function buildParamTypes(params) {
  const types = {};
  Object.keys(params).forEach((key) => {
    if (key === "periodDates") {
      types[key] = ["DATE"];
    } else if (
      key === "rangeStart" ||
      key === "rangeEnd" ||
      key === "periodDate" ||
      key.endsWith("Date")
    ) {
      types[key] = "DATE";
    }
  });
  return types;
}

// DATE/TIME/DATETIME param values must be wrapped (e.g. bq.date()) whenever an
// explicit type is declared — a plain string silently serializes to an empty
// parameter, i.e. SQL NULL, with no error. Still true as of v8.3.1: passing
// '2026-05-25' with type DATE yields parameterValue {}, while bq.date() yields
// parameterValue { value: '2026-05-25' }. Do not "simplify" this away.
function wrapParamsForTypes(bq, params, types) {
  const wrapped = {};
  Object.keys(params).forEach((key) => {
    const value = params[key];
    const type = types[key];
    if (type === "DATE" && typeof value === "string") {
      wrapped[key] = bq.date(value);
    } else if (Array.isArray(type) && type[0] === "DATE" && Array.isArray(value)) {
      wrapped[key] = value.map((v) => (typeof v === "string" ? bq.date(v) : v));
    } else {
      wrapped[key] = value;
    }
  });
  return wrapped;
}

function unwrapBqValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return value.value;
  }
  return value;
}

function coerceNumber(value) {
  value = unwrapBqValue(value);
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === "object" && typeof value.toString === "function") {
    const n = Number(value.toString());
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

// BigQuery hands back DATE/TIMESTAMP as { value: "..." } wrappers. Everything
// downstream wants a plain string.
function coerceString(value) {
  value = unwrapBqValue(value);
  if (value === null || value === undefined) return "";
  return String(value);
}

// This extract is the single largest cost in the app, so a runaway scan fails
// the job rather than the invoice. Deviates from the reference guide, which
// has no ceiling.
function maxBytesBilled() {
  const raw = process.env.BQ_MAX_BYTES_BILLED;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null;
}

async function runQuery(sql, params = {}) {
  const bq = getBigQueryClient();
  if (!bq) {
    const err = new Error("BigQuery is not configured");
    err.code = "BIGQUERY_NOT_CONFIGURED";
    throw err;
  }

  const types = buildParamTypes(params);
  const options = {
    query: sql,
    // Must match the dataset's region exactly. `US` (multi-region) and
    // `us-central1` (single region) are different locations to BigQuery, and a
    // mismatch fails with a misleading "Not found: Dataset". Defaulting to
    // us-central1 to match the sibling project that already queries this
    // warehouse; override with BQ_LOCATION if your dataset lives elsewhere.
    location: process.env.BQ_LOCATION || "us-central1",
  };
  if (Object.keys(params).length > 0) {
    options.params = wrapParamsForTypes(bq, params, types);
  }
  if (Object.keys(types).length > 0) {
    options.types = types;
  }
  const ceiling = maxBytesBilled();
  if (ceiling) {
    options.maximumBytesBilled = ceiling;
  }

  try {
    const [rows] = await bq.query(options);
    return rows;
  } catch (err) {
    // Surface BigQuery's specific message, not the generic wrapper. The SQL is
    // attached for server-side logging only and must never reach a response
    // body in production.
    const detail = err?.errors?.[0]?.message || err.message;
    const wrapped = new Error(detail);
    wrapped.code = "BIGQUERY_ERROR";
    wrapped.sql = sql;
    throw wrapped;
  }
}

function queryLocation() {
  return process.env.BQ_LOCATION || "us-central1";
}

function sessionIdFrom(metadata) {
  return metadata?.statistics?.query?.sessionInfo?.sessionId || null;
}

function wrapJobError(err, step) {
  const detail = err?.errors?.[0]?.message || err?.status?.errorResult?.message || err.message;
  const wrapped = new Error(`${step.name}: ${detail}`);
  wrapped.code = "BIGQUERY_ERROR";
  wrapped.sql = step.sql;
  wrapped.step = step.name;
  return wrapped;
}

function waitForComplete(job) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      job.removeAllListeners();
      fn(value);
    };
    job.on("complete", (metadata) => finish(resolve, metadata));
    job.on("error", (err) => finish(reject, err));
  });
}

// SELECT jobs are fetched. CREATE TEMP TABLE jobs are only waited on, so the
// company-day temp table is not pulled back to the server.
async function finishJob(job, fetchRows) {
  if (!fetchRows) {
    const metadata = await waitForComplete(job);
    if (metadata?.status?.errorResult) {
      const wrapped = new Error(metadata.status.errorResult.message);
      wrapped.errors = metadata.status.errors;
      throw wrapped;
    }
    return { rows: [], metadata };
  }
  try {
    const [rows] = await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    return { rows, metadata };
  } catch (err) {
    const [metadata] = await job.getMetadata();
    if (metadata?.status?.errorResult) {
      const wrapped = new Error(metadata.status.errorResult.message);
      wrapped.errors = metadata.status.errors;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * Runs statements in one BigQuery session so later statements can read
 * TEMP tables created by earlier ones. Each statement is its own job, which
 * is what lets a time-travel read and a live read of the same table coexist.
 */
async function runSessionQueries(steps, options = {}) {
  const bq = getBigQueryClient();
  if (!bq) {
    const err = new Error("BigQuery is not configured");
    err.code = "BIGQUERY_NOT_CONFIGURED";
    throw err;
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("runSessionQueries requires at least one statement");
  }

  const location = queryLocation();
  const ceiling = maxBytesBilled();
  let sessionId = null;
  let lastRows = [];

  try {
    for (const step of steps) {
      const started = Date.now();
      const jobOptions = {
        query: step.sql,
        location,
        useLegacySql: false,
      };
      if (ceiling) jobOptions.maximumBytesBilled = ceiling;
      if (!sessionId) jobOptions.createSession = true;
      else jobOptions.connectionProperties = [{ key: "session_id", value: sessionId }];

      let job;
      let metadata;
      try {
        [job] = await bq.createQueryJob(jobOptions);
        const finished = await finishJob(job, step.fetchRows === true);
        lastRows = finished.rows;
        metadata = finished.metadata;
      } catch (err) {
        throw wrapJobError(err, step);
      }

      if (!sessionId) {
        sessionId = sessionIdFrom(metadata);
        if (!sessionId && job) {
          const [fresh] = await job.getMetadata();
          sessionId = sessionIdFrom(fresh);
        }
        if (!sessionId) {
          const err = new Error("BigQuery did not open a session for the snapshot query");
          err.code = "BIGQUERY_ERROR";
          err.sql = step.sql;
          err.step = step.name;
          throw err;
        }
      }

      console.log(`[tracker] ${step.name} ${Date.now() - started}ms rows=${lastRows.length}`);

      if (typeof options.onStep === "function") {
        const action = options.onStep(step, lastRows);
        if (action && action.stop) return action.rows || [];
      }
    }
    return lastRows;
  } finally {
    if (sessionId) {
      try {
        const [job] = await bq.createQueryJob({
          query: "CALL BQ.ABORT_SESSION()",
          location,
          useLegacySql: false,
          connectionProperties: [{ key: "session_id", value: sessionId }],
        });
        await finishJob(job, false);
      } catch (abortErr) {
        console.warn(`[tracker] session close failed: ${abortErr.message}`);
      }
    }
  }
}

module.exports = {
  getBigQueryClient,
  getProjectId,
  isBigQueryConfigured,
  runQuery,
  runSessionQueries,
  coerceNumber,
  coerceString,
  unwrapBqValue,
};
