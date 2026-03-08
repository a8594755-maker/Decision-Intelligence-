# Known Limitations

## Current Boundary

| Area | Current state | Impact | Mitigation |
| --- | --- | --- | --- |
| Infrastructure bootstrap | There is no single-command environment bootstrap yet. | New environments still need a curated migration sequence. | Follow [DEPLOYMENT.md](DEPLOYMENT.md) and apply only the required modules. |
| Multi-service dependency | Full behavior depends on frontend, Supabase, Edge Functions, and the ML API. | A partial bring-up can render some pages healthy while key workflows are unavailable. | Treat system health as a release gate, not a cosmetic widget. |
| AI provider dependency | AI features require server-side provider keys and internet access. | Missing secrets degrade assistant and mapping behavior. | Configure `ai-proxy` secrets before demo or staging validation. |
| ERP integration | SAP sync functions are adapters, not turnkey enterprise connectors. | Production rollout still needs customer-specific endpoint contracts and credentials. | Keep `USE_MOCK_ERP=true` in local environments unless real integration is ready. |
| Optional ML capabilities | Chronos is disabled in the default Docker image. | Forecast behavior in the default deploy is narrower than a full research environment. | Enable extra dependencies only where the larger image is justified. |
| Import hardening | Some import flows have stronger guarantees only after optional migrations such as `one_shot_chunk_idempotency.sql`. | Environments can run in degraded mode if those migrations are skipped. | Apply optional hardening migrations before production cutover. |
| Release hygiene | The repo now has a changelog, but git tags are not yet standardized. | Historical release tracking is still file-based. | Keep `CHANGELOG.md` updated until tag discipline is formalized. |

## Documentation Boundary

- `README.md` and the curated docs in this folder are the primary entry path.
- `docs/archive/` and `docs/guides/` remain useful, but they are historical or deep-reference material.
- Internal execution reports and refactor summaries should not be treated as product documentation.
