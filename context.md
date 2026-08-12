# Context: How this web app is set up (reuse for a new SQL dashboard)

Use this document + the `copy_folder/` directory to spin up a **similar** app when you only have a SQL query.

Source project: **JustCall Retention Pulse** (`customer-segment-nrr`) — a BigQuery-backed retention dashboard.

---

## 1. One-sentence architecture

**Node/Express serves a single HTML page; the page fetches one JSON blob from `/api/data`; the server runs your BigQuery SQL (cached, auth-gated), transforms rows in Node, and returns the payload.**

No React, no Vite/Next, no local database, no ETL, no Docker. Deploy on Railway with Nixpacks.

```
Browser  →  public/index.html
              GET /api/health
              GET /api/data
                ↓
           server.js  (Basic auth, in-memory cache, static files)
                ↓
           src/data-service.js
                ↓
           src/queries.js  (YOUR SQL)  →  src/bigquery.js  →  BigQuery
                ↓
           src/transform.js  (rows → JSON for the UI)
                ↓
           cached JSON → browser renders KPIs / tables / charts
```

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 20 (CommonJS) |
| Server | Express 4 |
| Frontend | One file: `public/index.html` (vanilla HTML/CSS/JS) |
| Data | Google BigQuery via `@google-cloud/bigquery` |
| Auth | HTTP Basic (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`) |
| Optional API access | `x-api-token` header (`API_TOKEN`) |
| Config | `dotenv` + env vars |
| Hosting | Railway (`railway.toml`, Nixpacks) |
| Cache | In-memory JSON string; daily scheduler refresh |

**Dependencies only:**

```json
{
  "@google-cloud/bigquery": "^8.3.1",
  "compression": "^1.7.5",
  "dotenv": "^16.4.7",
  "express": "^4.21.2"
}
```

---

## 3. File roles (what to keep vs replace)

### Copy as-is (scaffolding) — already in `copy_folder/`

| File | Role |
|---|---|
| `package.json` | Scripts + deps |
| `server.js` | Auth, CSP headers, `/api/health`, `/api/data`, cache, static, scheduler boot |
| `src/bigquery.js` | SA credentials from env, `runQuery`, DATE param wrapping, coercion helpers |
| `src/scheduler.js` | Daily refresh at `HH:MM` in an IANA timezone |
| `src/data-service.js` | `runQuery` → `buildPayload` → refuse bad self-check |
| `src/diagnostics.js` | Optional `/api/debug/bigquery` (aggregates only) |
| `.env.example` | Env contract (empty values) |
| `railway.toml` | Deploy: `npm start`, healthcheck `/api/health` |
| `.gitignore` | Blocks `.env`, SA JSON, data dumps |

### You must customize (templates included in `copy_folder/`)

| File | What you do |
|---|---|
| `src/queries.js` | Paste **your SQL** into `buildExtractSql()`; set params in `extractParams()` |
| `sql/your_extract.sql` | Analyst-facing reference copy (server does **not** read this file) |
| `src/transform.js` | Map BigQuery rows → JSON shape your UI needs + optional self-checks |
| `public/index.html` | `fetch('/api/data')` and render (starter table UI included) |

---

## 4. Recipe: new app from “just a SQL query”

### Step A — scaffold

```bash
cp -R copy_folder /path/to/my-new-dashboard
cd /path/to/my-new-dashboard
npm install
cp .env.example .env
```

### Step B — env

Minimum:

```bash
GOOGLE_APPLICATION_CREDENTIALS_JSON=   # one-line SA JSON: jq -c . key.json
BQ_PROJECT_ID=
BQ_DATASET=
BQ_TABLE=
BQ_LOCATION=us-central1                # must match dataset region exactly
DASHBOARD_USER=
DASHBOARD_PASSWORD=                    # openssl rand -base64 32
```

Flatten the service account key:

```bash
jq -c . path/to/service-account.json
# paste into GOOGLE_APPLICATION_CREDENTIALS_JSON
```

IAM: **BigQuery Data Viewer** (dataset) + **BigQuery Job User** (project).

### Step C — put your SQL in `src/queries.js`

Rules this project follows (keep them):

1. **Table FQN** (`project.dataset.table`) is interpolated after strict regex validation — BigQuery cannot bind identifiers as params.
2. **Filter values** (dates, ids, etc.) are **bound params** (`@rangeStart`, …), never concatenated.
3. Prefer aggregating / collapsing in SQL when the raw grain is huge (this app collapses ~600k rows → ~22k in BigQuery).
4. Keep a readable copy in `sql/*.sql` for analysts; runtime source of truth is `buildExtractSql()`.

Example shape:

```js
function buildExtractSql() {
  const { fqn } = factTable();
  return `
    SELECT col_a, col_b, ...
    FROM ${fqn}
    WHERE some_date >= @rangeStart
  `;
}

function extractParams() {
  return { rangeStart: process.env.BQ_RANGE_START || "2024-01-01" };
}
```

### Step D — shape the payload in `src/transform.js`

Contract expected by `data-service.js`:

```js
function buildPayload(rows) {
  // ... compute ...
  return {
    payload: { /* whatever index.html needs */ },
    checks: { ok: true, errors: [], warnings: [] },
  };
}
```

If `checks.ok` is false, the server **will not** cache or serve that payload.

### Step E — render in `public/index.html`

Pattern:

```js
const health = await fetch("/api/health");
const res = await fetch("/api/data", { credentials: "same-origin" });
const D = await res.json();
// render D
```

Charts in the original app are hand-drawn SVG (no Chart.js). You can keep that or add a CDN library if CSP is updated.

### Step F — run & deploy

```bash
npm run dev          # http://localhost:3000
curl -s localhost:3000/api/health | jq
```

Railway:

1. Connect the repo / deploy from `copy_folder` contents as the app root.
2. Set the same env vars in Railway UI (do **not** set `PORT`).
3. `railway.toml` already points healthcheck at `/api/health` (returns **503** if BigQuery is missing).

---

## 5. API surface (keep this contract)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | Open | Config / cache / schedule status; 503 if BQ missing |
| `GET /api/data` | Basic (if set) | Full JSON payload |
| `GET /api/data?refresh=1` | Basic | Force refresh (cooldown via `CACHE_MANUAL_COOLDOWN_MS`) |
| `GET /api/debug/bigquery` | Basic + `ENABLE_DEBUG_ENDPOINTS=1` | Aggregate probe only |
| `GET *` | Basic | Serves `public/index.html` |

---

## 6. Caching & refresh model

- On boot: warm cache with one BigQuery job.
- Daily schedule: `REFRESH_AT` (default `10:00`) in `REFRESH_TZ` (default `Asia/Kolkata`).
- Concurrent refreshes collapse into one in-flight promise.
- Failed refresh: serve last good payload with header `X-Data-Stale: 1`.
- If schedule is `off`, fall back to TTL (`CACHE_TTL_MS`, default 6h).
- Cost guard: `BQ_MAX_BYTES_BILLED` (default 2 GiB) fails runaway scans.

---

## 7. Security patterns (do not drop when copying)

- **No secrets in repo.** SA JSON only via `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
- **Basic auth in production** if the payload has customer/revenue data.
- **Never echo** credentials, tokens, or full SQL to API clients in production (`NODE_ENV=production` → generic errors).
- **Parameterized filters**; validated identifiers for table names.
- Debug endpoint **off** by default.
- Response `Cache-Control: private, no-store` for `/api/data`.
- CSP pins fetches to same-origin (inline script/style allowed because the UI is one HTML file).

---

## 8. What this original app does (for orientation only)

Business-specific — **do not copy** unless you need the same product:

- Trailing-12-month **NRR / GRR / Logo** retention from `fact_user_master`
- Segment mix, cohort decay, account journeys, TV mode
- Heavy logic in `src/transform.js` + rich UI in `public/index.html`
- Docs: `docs/METRICS.md`, `docs/SEGMENTATION_LOGIC.md`

For a new project you only need the **plumbing** in `copy_folder/` plus your SQL + a thinner UI.

---

## 9. Minimal mental model for your next project

```
1. You have a SQL query that returns the rows you care about.
2. Put it in src/queries.js (buildExtractSql + extractParams).
3. Decide the JSON shape the browser should receive → src/transform.js.
4. Render that JSON in public/index.html.
5. Everything else (auth, cache, BigQuery client, Railway, health) stays the same.
```

That is the whole pattern.

---

## 10. `copy_folder/` contents checklist

```
copy_folder/
├── package.json          # generic name; same deps (run npm install)
├── server.js             # ready to run
├── railway.toml
├── .env.example
├── .gitignore
├── public/
│   └── index.html        # starter table UI
├── sql/
│   └── your_extract.sql  # paste analyst copy of your query
└── src/
    ├── bigquery.js       # keep
    ├── scheduler.js      # keep
    ├── data-service.js   # keep
    ├── diagnostics.js    # keep (needs buildProbeSql in queries.js)
    ├── queries.js        # TEMPLATE — paste your SQL
    └── transform.js      # TEMPLATE — shape your payload
```

After copying out of this repo, treat `copy_folder` as the **root** of the new project (not a nested subfolder of another app).
