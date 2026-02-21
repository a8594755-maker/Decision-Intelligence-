# Staging -> Production Release Gate

This runbook defines the mandatory promotion gate for releasing staged artifacts to production.

## Gate Policy
Promotion is blocked unless all three checks pass:
1. Artifact quality gates (`mape`, `coverage_10_90`, `pinball`, `bias`, calibration, min eval points)
2. Regression suite result (`passed=true`, zero failed tests)
3. Canary checks (fixture smoke metrics + endpoint/schema checks)

The API promotion endpoint enforces this by default with `enforce_release_gate=true`.

## 1) Staging Deploy Steps
1. Deploy candidate artifact to staging and register it:
```bash
curl -X POST http://<host>/ml/registry/register \
  -H 'Content-Type: application/json' \
  -d '{
    "artifact_path": "/path/to/artifact",
    "series_id": "SKU-001",
    "model_name": "lightgbm",
    "metrics_summary": {"mape": 14.2, "coverage_10_90": 0.82, "pinball": 19.0, "bias": -2.1, "n_eval_points": 14},
    "calibration_passed": true
  }'
```
2. Stage artifact:
```bash
curl -X POST http://<host>/ml/registry/stage \
  -H 'Content-Type: application/json' \
  -d '{"series_id": "SKU-001", "artifact_id": "art_xxx", "note": "staging validation"}'
```

## 2) Regression Suite (Required Pass)
Run required regression suites and capture summary JSON:
```bash
npm run test:solver-regression
python3 -m pytest -q tests/test_planning_api_contract.py tests/test_planning_contract_parity.py
```

Persist normalized regression evidence (example `regression_result.json`):
```json
{
  "passed": true,
  "total": 72,
  "failed": 0,
  "suite": "planning-regression"
}
```

## 3) Canary Checks (Required Pass)
Run canary script on staging.

```bash
python3 scripts/run_canary_checks.py \
  --base-url https://staging.example.com \
  --engine heuristic \
  --output canary_result.json
```

Canary includes:
- fixture smoke runs on staging planning fixtures (`feasible_basic_single`, `feasible_tight_capacity`)
- key metrics threshold checks:
  - `max_solve_time_ms`
  - `timeout_rate`
  - `infeasible_rate`
- endpoint probes and schema validation:
  - `GET /health`
  - `POST /replenishment-plan`

Default canary thresholds:
- `max_solve_time_ms <= 10000`
- `timeout_rate <= 0.0`
- `infeasible_rate <= 0.25`
- endpoint success rate `= 1.0`

## 4) Gate Evaluation + Approve/Promote
Evaluate release evidence before promotion:

```bash
python3 scripts/evaluate_release_gate.py \
  --artifact-json artifact_record.json \
  --regression-json regression_result.json \
  --canary-json canary_result.json \
  --output release_gate_result.json
```

Exit code:
- `0`: promotion allowed
- `2`: promotion blocked

Promote only when gate passes:
```bash
curl -X POST http://<host>/ml/registry/promote \
  -H 'Content-Type: application/json' \
  -d @promote_payload.json
```

`promote_payload.json` template:
```json
{
  "series_id": "SKU-001",
  "artifact_id": "art_xxx",
  "approved_by": "release-engineer",
  "note": "Passed regression + canary",
  "override": false,
  "enforce_release_gate": true,
  "regression_result": {"passed": true, "total": 72, "failed": 0},
  "canary_result": {
    "fixture_results": [
      {"id": "feasible_basic_single", "status": "OPTIMAL", "solve_time_ms": 121, "schema_valid": true},
      {"id": "feasible_tight_capacity", "status": "OPTIMAL", "solve_time_ms": 214, "schema_valid": true}
    ],
    "endpoint_checks": [
      {"path": "/health", "status_code": 200, "responded": true, "schema_valid": true},
      {"path": "/replenishment-plan", "status_code": 200, "responded": true, "schema_valid": true}
    ]
  }
}
```

## 5) Rollback Strategy

### Fast rollback (pointer revert)
Use the scripted rollback hook:
```bash
python3 scripts/rollback_prod_pointer.py --series-id SKU-001 --steps 1
```

Exit code:
- `0`: rollback applied
- `1`: no previous PROD artifact found

### API rollback alternative
```bash
curl -X POST http://<host>/ml/registry/rollback \
  -H 'Content-Type: application/json' \
  -d '{"series_id":"SKU-001","steps":1}'
```

### Post-rollback verification
1. Confirm PROD pointer:
```bash
curl "http://<host>/ml/registry/prod?series_id=SKU-001"
```
2. Confirm health and planning endpoint response:
```bash
python3 scripts/run_canary_checks.py --base-url https://prod.example.com --output prod_post_rollback_canary.json
```

## Automation Hooks
- `scripts/run_canary_checks.py`: canary evidence producer (deterministic JSON + exit code)
- `scripts/evaluate_release_gate.py`: promotion gate evaluator (deterministic JSON + exit code)
- `scripts/rollback_prod_pointer.py`: one-command pointer rollback
