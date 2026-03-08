# Deployment

## Supported Topology

This repo is currently designed around:

- Frontend static hosting for the React app
- Supabase for auth, Postgres, storage, and Edge Functions
- A separate Python ML API container

The checked-in deployment hints are real:

- ML API container: [`../Dockerfile`](../Dockerfile)
- Railway runtime: [`../railway.toml`](../railway.toml)
- SPA redirect rule: [`../public/_redirects`](../public/_redirects)

## 1. Supabase

Create a Supabase project first, then apply a curated SQL baseline from `sql/migrations/`.

Recommended core order:

1. `sql/migrations/supabase-setup.sql`
2. `sql/migrations/supplier_kpi_schema.sql`
3. `sql/migrations/import_batches_schema.sql`
4. `sql/migrations/upload_mappings_schema.sql`
5. `sql/migrations/step1_supply_inventory_financials_schema.sql`
6. `sql/migrations/bom_forecast_schema.sql`
7. `sql/migrations/ingest_rpc.sql`
8. `sql/migrations/release_ingest_rpc_permissions.sql`

Common optional migrations:

- `sql/migrations/one_shot_chunk_idempotency.sql`
- `sql/migrations/logic_control_center_schema.sql`
- `sql/migrations/di_runs_and_artifacts.sql`
- `sql/migrations/di_run_steps.sql`
- `sql/migrations/di_async_jobs_v0.sql`
- `sql/migrations/di_solver_runs_telemetry.sql`

Reason for the split: not every environment needs every module yet. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the current boundary.

## 2. Supabase Edge Functions

Deploy only the functions your environment uses, but `ai-proxy` is the baseline requirement for AI features.

```bash
supabase functions deploy ai-proxy
supabase functions deploy bom-explosion
supabase functions deploy sync-materials-from-sap
supabase functions deploy sync-demand-fg-from-sap
supabase functions deploy sync-po-open-lines-from-sap
supabase functions deploy sync-inventory-from-sap
supabase functions deploy sync-bom-from-sap
```

Set secrets server-side, not in browser env:

```bash
supabase secrets set FRONTEND_ORIGIN=https://decision-intelligence-web.example.com
supabase secrets set GEMINI_API_KEY=...
supabase secrets set DEEPSEEK_API_KEY=...
supabase secrets set DI_GEMINI_MODEL=gemini-3.1-pro-preview
supabase secrets set DI_DEEPSEEK_MODEL=deepseek-chat
```

## 3. Frontend

Build the app:

```bash
npm ci
npm run build
```

Required frontend env values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ML_API_URL`

Notes:

- The repo already includes a Netlify-compatible SPA redirect file in `public/_redirects`.
- Any static host is acceptable as long as it serves `dist/` and handles client-side routes.

## 4. ML API

The ML runtime is containerized separately from the frontend.

Local container build:

```bash
docker build -t decision-intelligence-ml .
docker run --rm -p 8000:8000 \
  -e ALLOWED_ORIGINS=http://localhost:5173 \
  -e DI_DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres \
  decision-intelligence-ml
```

Production notes:

- The image intentionally excludes Chronos-heavy dependencies by default.
- Health probes target `/health/live`.
- Railway configuration is already present in [`../railway.toml`](../railway.toml).

## 5. Verification Checklist

- Frontend loads and can authenticate against Supabase.
- `/health/live` on the ML API returns `200`.
- The Settings page no longer shows missing AI secret warnings.
- A sample upload from [public/sample_data/test_data.xlsx](../public/sample_data/test_data.xlsx) can complete the expected workflow.
- `npm run build` and `npm run test:regression` pass in the target branch.
