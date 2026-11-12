# Salesforce Integration Tracker

One row per company per day where the plan, active users, or Salesforce user ids changed. The page is a table with a filter on each column.

Deployable app lives at the **repository root** (Express + BigQuery + `public/index.html`).

## Railway

1. Connect this GitHub repo to a Railway service.
2. Leave **Root Directory** empty.
3. Set env vars (see `.env.example`):
   - For demo UI without BigQuery: `DEMO_MODE=1`
   - For production data: BigQuery credentials + `DASHBOARD_USER` / `DASHBOARD_PASSWORD`
4. Healthcheck path: `/api/health` (always returns HTTP 200 when the process is up).

## Local

```bash
cp .env.example .env   # DEMO_MODE=1
npm install
npm run dev            # http://localhost:3000
```

`copy_folder/` is an older dashboard scaffold and is not served.
