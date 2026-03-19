# Decision Intelligence — Staging / Production Runbook

## Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Node.js | v18+ | `node --version` |
| Python | 3.10+ | `python3 --version` |
| Supabase project | Configured | URL + anon key in `.env.local` |
| Supabase CLI | Optional | For migration management |

## Environment Setup

### Required Environment Variables

Create `.env.local` at the project root:

```env
# Supabase (required)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# ML API (optional — defaults to http://127.0.0.1:8000)
VITE_ML_API_URL=http://127.0.0.1:8000

# LLM keys (set in Supabase Edge Function secrets, not locally)
# GEMINI_API_KEY, DEEPSEEK_API_KEY — stored as Supabase secrets
# Only DeepSeek can be set locally for direct calls:
VITE_DEEPSEEK_API_KEY=sk-...
```

### Database Migrations

Apply all migrations before first run:

```bash
# List pending migrations
ls supabase/migrations/*.sql | wc -l

# Apply via Supabase CLI
supabase db push

# Or apply manually via SQL editor in Supabase Dashboard
```

## Starting Services

### One-Command Start (Recommended)

```bash
# Preflight check only (dry-run)
./scripts/start.sh --check

# Start all services (frontend + backend)
./scripts/start.sh

# Start individual services
./scripts/start.sh --frontend
./scripts/start.sh --backend
```

### Manual Start

```bash
# Terminal 1: Backend (ML API)
python3 run_ml_api.py
# Runs on http://127.0.0.1:8000

# Terminal 2: Frontend (Vite)
npm run dev
# Runs on http://localhost:5173
```

## Health Checks

### CLI Health Check

```bash
# Human-readable output
./scripts/healthcheck.sh

# JSON output (for monitoring)
./scripts/healthcheck.sh --json

# Check single service
./scripts/healthcheck.sh --service mlapi
./scripts/healthcheck.sh --service supabase
```

### HTTP Health Endpoints (ML API)

| Endpoint | Purpose | Healthy Response |
|---|---|---|
| `GET /healthz` | Liveness probe | `{"status": "ok"}` (always 200) |
| `GET /readyz` | Readiness probe | `{"status": "ready", "checks": {...}}` (200 or 503) |
| `GET /health/live` | Liveness (router) | `{"status": "alive"}` |
| `GET /health/ready` | Readiness (router) | `{"status": "ready", "checks": {"database": "ok", "solver": "ok", "llm_proxy": "ok"}}` |

### Frontend Health (Programmatic)

Use `systemHealthService.js` for programmatic health checks (not just a React hook):

```js
import { runFullHealthCheck } from './services/systemHealthService.js';
const report = await runFullHealthCheck();
// { status: 'healthy'|'degraded'|'offline', checks: { supabase, mlApi, aiProxy, database }, timestamp }
```

Checks 4 real dependencies:
- **Supabase Auth**: `{SUPABASE_URL}/auth/v1/health`
- **ML API**: `{ML_API_URL}/readyz` (readiness probe)
- **AI Proxy**: `{SUPABASE_URL}/functions/v1/ai-proxy` (OPTIONS)
- **Database**: `{SUPABASE_URL}/rest/v1/` (PostgREST HEAD)

The `useSystemHealth()` React hook wraps this with auto-refresh every 30s + status bar UI.

## Verifying Deployment

```bash
# 1. Run JS test suite
npx vitest run

# 2. Run CI pipeline (lint + test + build)
npm run ci

# 3. Health check
./scripts/healthcheck.sh

# 4. Verify readiness endpoint
curl http://127.0.0.1:8000/readyz | jq .
```

## Common Issues and Troubleshooting

### Frontend starts but shows "offline" for all services

**Cause**: Missing or incorrect environment variables.

```bash
# Check your env
./scripts/start.sh --check
# Look for red ✗ marks
```

### ML API fails to start

**Cause**: Missing Python dependencies or PYTHONPATH issues.

```bash
# Install dependencies
pip install -r requirements.txt

# Verify PYTHONPATH
python3 -c "import ml.api.main; print('OK')"
```

### Supabase "offline" in health check

**Cause**: `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` misconfigured.

```bash
# Test connectivity directly
curl -H "apikey: YOUR_ANON_KEY" https://your-project.supabase.co/auth/v1/health
```

### LLM features not working

**Cause**: AI proxy Edge Function not deployed or secrets not set.

```bash
# Check proxy reachability
curl -X OPTIONS https://your-project.supabase.co/functions/v1/ai-proxy

# Set secrets in Supabase Dashboard → Edge Functions → Secrets
# Required: GEMINI_API_KEY, ANTHROPIC_API_KEY (or OPENAI_API_KEY)
```

### Database migration errors

```bash
# Check which migrations are applied
supabase migration list

# Re-apply a specific migration
supabase db push
```

### ERP adapter payload validation fails

```bash
# Run contract tests
npx vitest run src/services/hardening/hardening.test.js --reporter=verbose
```

The ERP contract is locked via `ADAPTER_PAYLOAD_CONTRACT` (frozen object, version `1.0`):
- Envelope keys: `target_system`, `schema_version`, `envelope_type`, `idempotency_key`, `approval_metadata`, `records`, `record_count`, `generated_at`
- Supported systems: `sap_mm`, `oracle_scm`, `generic`
- Field types enforced via `MUTATION_FIELD_TYPES` + `validateMutationFieldTypes()`
- Full validation: `validateWritebackPayload(payload, system)` (schema + types)
- Contract check: `validateAdapterPayloadContract(adapterPayload)` (envelope + record shape)

## Monitoring

### Key Metrics to Watch

- `/readyz` response (200 vs 503)
- Frontend `useSystemHealth()` — all three services should be "online"
- Task pipeline: tasks moving through `draft_plan → waiting_approval → queued → in_progress → review_hold → done`

### Logs

- **Frontend**: Browser dev console
- **Backend**: stdout from `run_ml_api.py` (structured logging with request IDs)
- **Supabase**: Dashboard → Logs (Edge Functions, Auth, Database)
