# Known Limitations

Decision Intelligence is a deployable product with real multi-service dependencies. This page defines the current operating boundary so demos, evaluation, and production setup stay realistic.

## Environment Dependencies

| Dependency | Why it matters | What to do |
| --- | --- | --- |
| Supabase project | Auth, persistence, storage, and Edge Functions are part of the main runtime. | Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and deploy the required functions. |
| ML API service | Forecasting, planning, async runs, and simulation do not execute inside the frontend bundle. | Start via `./scripts/start.sh --backend` or deploy the containerized runtime. |
| AI provider secrets | Assistant, mapping, and prompt workflows depend on server-side model credentials. | Set `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and `FRONTEND_ORIGIN` in Supabase Edge Function secrets. |
| Migration set | Some flows rely on curated baseline or optional hardening migrations. | Apply all migrations in `supabase/migrations/` before staging or production. |

## Current Scope Boundaries

| Boundary | Current state | Practical impact |
| --- | --- | --- |
| ~~Bootstrap experience~~ | **Resolved.** `./scripts/start.sh` provides single-command full-stack startup with preflight checks, env validation, DB migration check, and connectivity verification. `./scripts/start.sh --check` for dry-run. | — |
| ~~Health monitoring~~ | **Resolved.** Shell: `./scripts/healthcheck.sh`. ML API: `/healthz` (liveness), `/readyz` (readiness). Frontend: `systemHealthService.js` checks Supabase, ML API, AI Proxy, DB with latency tracking. | — |
| ~~ERP adapter contract~~ | **Resolved.** `ADAPTER_PAYLOAD_CONTRACT` in `hardening/erpAdapterPayload.js` locks envelope schema + per-system record shapes. `MUTATION_FIELD_TYPES` enforces value types. `validateWritebackPayload()` runs full schema + type validation. 25+ contract tests. | — |
| Partial bring-up | Frontend-only bring-up can render pages while key workflows remain unavailable. | Use `./scripts/healthcheck.sh` as the real readiness signal. |
| ERP integration | SAP sync functions are adapters with locked contracts, not turnkey enterprise connectors. | Production rollout still needs customer-specific endpoint credentials. Contract shape is stable. |
| Optional ML footprint | Chronos-heavy dependencies are excluded from the default Docker image. | Default deploys favor a lean runtime over the full research feature set. |

## Operations Quick Reference

| Task | Command |
| --- | --- |
| Full-stack start | `./scripts/start.sh` |
| Preflight check only | `./scripts/start.sh --check` |
| Health check (human) | `./scripts/healthcheck.sh` |
| Health check (CI/JSON) | `./scripts/healthcheck.sh --json` |
| ML API readiness | `curl http://127.0.0.1:8000/readyz` |
| Runbook | [RUNBOOK.md](RUNBOOK.md) |

## Documentation Boundary

- `README.md` and the curated docs in this folder are the primary reading path.
- `docs/archive/` remains useful for implementation history, but it is not the main product entry point.
- Deep reference notes and archived summaries should support evaluation, not replace the product-facing docs.
