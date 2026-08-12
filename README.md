# Trial Extension Dashboard

Account-level visibility into every trial — original setup, extensions/limit overrides, status, and post-conversion MRR.

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

## Spec

See `project_input.md` and `context.md`. `copy_folder/` is the generic BigQuery dashboard scaffold used as a reference.
