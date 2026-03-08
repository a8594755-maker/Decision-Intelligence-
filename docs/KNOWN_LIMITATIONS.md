# Known Limitations

Decision Intelligence is a working product prototype with real multi-service dependencies. This page defines the current operating boundary so demos, evaluation, and local setup stay realistic.

## Environment Dependencies

| Dependency | Why it matters | What to do |
| --- | --- | --- |
| Supabase project | Auth, persistence, storage, and Edge Functions are part of the main runtime. | Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and deploy the required functions. |
| ML API service | Forecasting, planning, async runs, and simulation do not execute inside the frontend bundle. | Start the FastAPI service locally or deploy the containerized runtime. |
| AI provider secrets | Assistant, mapping, and prompt workflows depend on server-side model credentials. | Set `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and `FRONTEND_ORIGIN` in Supabase Edge Function secrets. |
| Migration set | Some flows rely on curated baseline or optional hardening migrations. | Apply the minimum baseline first, then add optional migrations before staging or production. |

## Current Scope Boundaries

| Boundary | Current state | Practical impact |
| --- | --- | --- |
| Bootstrap experience | There is not yet a single-command full-stack bootstrap. | New environments still need the curated setup path in [DEPLOYMENT.md](DEPLOYMENT.md). |
| Partial bring-up | Frontend-only bring-up can render pages while key workflows remain unavailable. | Treat system health and the end-to-end demo flow as the real readiness signal. |
| ERP integration | SAP sync functions are adapters, not turnkey enterprise connectors. | Production rollout still needs customer-specific endpoint contracts and credentials. |
| Optional ML footprint | Chronos-heavy dependencies are excluded from the default Docker image. | Default deploys favor a lean runtime over the full research feature set. |
| Import hardening | Some idempotency and async protections are unlocked only after optional migrations. | Environments can behave in degraded mode if those migrations are skipped. |

## Documentation Boundary

- `README.md` and the curated docs in this folder are the primary reading path.
- `docs/archive/` remains useful for implementation history, but it is not the main product entry point.
- Deep reference notes and archived summaries should support evaluation, not replace the product-facing docs.
