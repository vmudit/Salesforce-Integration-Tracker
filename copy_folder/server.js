require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const compression = require("compression");

const { isBigQueryConfigured, getProjectId } = require("./src/bigquery");
const { fetchData, getLastRefresh } = require("./src/data-service");
const { startScheduler, DEFAULT_TIME, DEFAULT_TZ } = require("./src/scheduler");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Fallback only. With a daily schedule running, the cache is held until that
// schedule replaces it, so this TTL applies only when REFRESH_AT is off or
// misconfigured. Each expiry is exactly one BigQuery query.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const REFRESH_AT = process.env.REFRESH_AT ?? DEFAULT_TIME;
const REFRESH_TZ = process.env.REFRESH_TZ || DEFAULT_TZ;

// ?refresh=1 deliberately bypasses the cache, so without a floor between runs
// it is a lever anyone with the dashboard password can pull repeatedly, one
// BigQuery job per press. In-flight collapsing only merges *concurrent* calls;
// sequential ones each bill. 0 disables.
const MANUAL_COOLDOWN_MS = Number(process.env.CACHE_MANUAL_COOLDOWN_MS ?? 60 * 1000);
const DEBUG_ENABLED = process.env.ENABLE_DEBUG_ENDPOINTS === "1";
const IS_PROD = process.env.NODE_ENV === "production";

const DASHBOARD_USER = process.env.DASHBOARD_USER || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const API_TOKEN = process.env.API_TOKEN || "";
const AUTH_ENABLED = Boolean(DASHBOARD_USER && DASHBOARD_PASSWORD);

// The serialized payload is cached alongside the object so a 7 MB response is
// not re-stringified on every request.
let cacheBody = null;
let cacheAt = 0;
let inFlight = null;
let scheduler = null;
let lastManualAt = 0;

/**
 * Runs the extract and replaces the cache. Concurrent callers — a scheduled run
 * and a request arriving at the same moment — collapse into one BigQuery job.
 */
async function loadFresh() {
  if (!inFlight) {
    inFlight = fetchData().finally(() => {
      inFlight = null;
    });
  }
  const result = await inFlight;

  // Never cache an empty result — a transient upstream problem would otherwise
  // be frozen in until the next scheduled run.
  if (!result.isEmpty) {
    cacheBody = JSON.stringify(result.payload);
    cacheAt = Date.now();
  }
  return result;
}

// With a schedule active the cached copy stays authoritative until the next
// scheduled run replaces it. Letting the TTL expire underneath would trigger an
// unscheduled query at whatever time a visitor happened to show up, which is
// the behaviour the schedule exists to remove.
function cacheIsCurrent() {
  if (!cacheBody) return false;
  if (scheduler) return true;
  return Date.now() - cacheAt < CACHE_TTL_MS;
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(compression());

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    // The dashboard is a single file with inline <style> and <script>, so
    // 'unsafe-inline' is unavoidable. The value of the policy here is that it
    // pins every other fetch to same-origin, so injected markup cannot ship
    // customer data to a third-party host.
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "font-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "form-action 'none'; " +
      "frame-ancestors 'none'"
  );
  next();
});

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hasValidToken(req) {
  if (!API_TOKEN) return false;
  const provided = req.get("x-api-token");
  return Boolean(provided) && safeEqual(provided, API_TOKEN);
}

function hasValidBasic(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, DASHBOARD_USER) && safeEqual(pass, DASHBOARD_PASSWORD);
}

// Gate everything — page and API alike. A header-only gate would leave the
// dashboard HTML itself readable by anyone with the Railway URL.
// /api/health stays open so the Railway healthcheck can reach it; it never
// returns customer data.
app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  if (!AUTH_ENABLED) return next();
  if (hasValidBasic(req) || hasValidToken(req)) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="Retention Pulse", charset="UTF-8"');
  return res.status(401).json({ error: "Unauthorized" });
});

// Railway healthcheck target. Returns 503 when unconfigured so a bad deploy
// fails the healthcheck instead of silently serving an empty dashboard.
app.get("/api/health", (_req, res) => {
  const configured = isBigQueryConfigured();
  const last = getLastRefresh();
  res.status(configured ? 200 : 503).json({
    status: configured ? "ok" : "unavailable",
    bigqueryConfigured: configured,
    projectId: configured ? getProjectId() : null,
    authEnabled: AUTH_ENABLED,
    cacheAgeMs: cacheBody ? Date.now() - cacheAt : null,
    lastRefresh: last ? { at: last.at, rowCount: last.rowCount } : null,
    schedule: scheduler
      ? { at: REFRESH_AT, timeZone: REFRESH_TZ, nextRunAt: scheduler.nextRunAt() }
      : { at: null, timeZone: null, nextRunAt: null },
    timestamp: new Date().toISOString(),
    ...(configured ? {} : { error: "BigQuery credentials are not configured" }),
  });
});

app.get("/api/data", async (req, res) => {
  const forceRefresh = req.query.refresh === "1";

  // Cold start has no cache to fall back on, so the first load is never blocked.
  if (forceRefresh && cacheBody && Date.now() - lastManualAt < MANUAL_COOLDOWN_MS) {
    res.setHeader("X-Refresh-Cooldown", "1");
    return sendPayload(res, cacheBody);
  }

  if (!forceRefresh && cacheIsCurrent()) {
    return sendPayload(res, cacheBody);
  }

  try {
    if (forceRefresh) lastManualAt = Date.now();
    const result = await loadFresh();
    return sendPayload(res, JSON.stringify(result.payload));
  } catch (err) {
    console.error(`[/api/data] ${err.code || "ERROR"}: ${err.message}`);
    if (err.sql) console.error(`[/api/data] failing SQL:\n${err.sql}`);

    // Serve stale data rather than nothing if we have any — a refresh failure
    // should not blank the dashboard.
    if (cacheBody) {
      res.setHeader("X-Data-Stale", "1");
      return sendPayload(res, cacheBody);
    }

    const status = err.code === "BIGQUERY_NOT_CONFIGURED" ? 503 : 502;
    return res.status(status).json({
      code: err.code || "BIGQUERY_ERROR",
      // BigQuery messages can name datasets, tables and columns. Only surface
      // them outside production.
      error: IS_PROD ? "Failed to load dashboard data." : err.message,
    });
  }
});

function sendPayload(res, body) {
  // Contains named customer revenue: keep it out of shared and disk caches.
  res.setHeader("Cache-Control", "private, no-store");
  res.type("application/json").send(body);
}

if (DEBUG_ENABLED) {
  const { runDiagnostics } = require("./src/diagnostics");
  app.get("/api/debug/bigquery", async (_req, res) => {
    if (!isBigQueryConfigured()) {
      return res.status(503).json({ error: "BigQuery is not configured" });
    }
    try {
      res.json(await runDiagnostics());
    } catch (err) {
      res.status(502).json({ error: IS_PROD ? "Diagnostics failed." : err.message });
    }
  });
}

// Unmatched API paths must answer as an API. Without this they fall through to
// the SPA catch-all below and return HTML with a 200, which hides typos and
// makes a disabled debug endpoint look like it succeeded.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "private, max-age=300"),
  })
);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  if (!isBigQueryConfigured()) {
    console.error(
      "BigQuery is NOT configured. Set GOOGLE_APPLICATION_CREDENTIALS_JSON and BQ_PROJECT_ID."
    );
  } else {
    console.log(`Listening on port ${PORT} (BigQuery project: ${getProjectId()})`);
  }
  if (!AUTH_ENABLED) {
    console.warn(
      "WARNING: DASHBOARD_USER / DASHBOARD_PASSWORD are not set. This dashboard " +
        "exposes named customer accounts and their revenue history, and is currently " +
        "readable by anyone who can reach this URL."
    );
  }

  if (!isBigQueryConfigured()) return;

  scheduler = startScheduler({
    time: REFRESH_AT,
    timeZone: REFRESH_TZ,
    onFire: async () => {
      console.log("[scheduler] running daily refresh");
      await loadFresh();
    },
  });

  // Warm the cache now so the first visitor after a deploy gets an instant
  // response instead of waiting out a full extract, and so a broken query is
  // visible in the deploy logs rather than on someone's screen.
  loadFresh().catch((err) => {
    console.error(`[startup] initial load failed: ${err.code || "ERROR"}: ${err.message}`);
  });
});

module.exports = app;
