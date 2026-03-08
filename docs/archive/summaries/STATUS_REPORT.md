# Decision-Intelligence Platform — Status Report

> Generated: 2026-03-07 | Based on repo audit

---

## 1. As-Is: Current Capabilities (已完成)

| Module | Status | Key Files |
|--------|--------|-----------|
| **Multi-Model Training** (Prophet/LightGBM/XGBoost/ETS/Chronos) | Done + Tested | `src/ml/training/strategies.py` |
| **Champion / Leaderboard / Rollback** | Done + Tested | `src/ml/training/orchestrator.py` |
| **HPO (Optuna)** | Done + Tested | `src/ml/training/hpo.py` |
| **Uncertainty (p10/p50/p90)** — conformal residual | Done + Tested | `src/ml/uncertainty/quantile_engine.py` |
| **Drift Detection + Retrain Triggers** | Done + Tested | `src/ml/monitoring/drift_monitor.py`, `retrain_triggers.py` |
| **Model Registry + Lifecycle** (CANDIDATE → STAGED → PROD → DEPRECATED) | Done + Tested | `src/ml/registry/model_registry.py` |
| **Quality Gates / Promotion Gates / Release Gates** | Done + Tested | `src/ml/uncertainty/quality_gates.py`, `registry/promotion_gates.py` |
| **Governance** (RBAC + Approval Workflows + Audit) | Done + Tested | `src/ml/governance/` |
| **OR-Tools CP-SAT Solver** (3700+ LOC) | Done + Tested | `src/ml/api/replenishment_solver.py` |
| **Planning Contract v1** (shadow_price, relaxation, infeasibility diagnostics) | Done | `src/ml/api/planning_contract.py` |
| **p90 → Safety Stock / Robust Planning** | Done | Solver flags: `use_p90_for_safety_stock`, `use_p90_demand_model` |
| **Risk-Aware Planning** (5 rules) | Done + Tested | `src/services/riskAdjustmentsService.js` |
| **Closed-Loop Evaluation** (drift → retrigger → replan) | Done | `src/services/closed_loop/` |
| **Constraint Checker + Replay Simulator** (deterministic) | Done + Tested | `src/utils/constraintChecker.js`, `replaySimulator.js` |
| **JS Heuristic Fallback Solver** | Done | `src/services/optimizationApiClient.js` |
| **Workflow A Engine** (8-step orchestration) | Done | `src/workflows/workflowAEngine.js` |
| **Dataset Profiling + Fingerprinting + Schema Validation** | Done + Tested | `src/services/datasetProfilingService.js`, `src/utils/datasetFingerprint.js` |
| **FastAPI Endpoints** (33 routes) | All Implemented | `src/ml/api/main.py` |
| **Frontend** (12 views + 39 chat cards) | Done | `src/views/`, `src/components/chat/` |
| **SHAP Explainability** (TreeExplainer for LightGBM/XGBoost) | Done | `src/ml/training/strategies.py` |
| **Feature Importance API** (SHAP + gain fallback) | Done | `POST /feature-importance` |
| **Feature Flags** | Done | `.env.example` |
| **Tests** (681 JS + 40+ Python files) | 100% pass | |

---

## 2. Gap Analysis (缺口)

### P0 — Demo / Delivery Essentials

| Gap | Description | Status |
|-----|-------------|--------|
| **Decision KPI Dashboard** | Service level, stockout, holding, total cost cards | **Fixed** — added to `DashboardView.jsx` |
| **E2E Integration Test** | End-to-end pipeline validation (upload → plan → verify) | **Fixed** — `tests/test_e2e_workflow.py` |
| **Retrain Approval UI** | Frontend card for model retrain approval | **Fixed** — `RetrainApprovalCard.jsx` |

### P1 — Future Hardening

| Gap | Description | Recommendation |
|-----|-------------|----------------|
| **Multi-Level BOM** | Only single-level `bom_v0`; no recursive FG → subassembly → raw | Add when customer requires 3+ level BOM |
| **Real ERP Connectors** | Mock ERP default; SAP Edge Functions exist but untested | Test with real SAP sandbox before go-live |
| **Chronos Production** | Feature-flagged off (`VITE_DI_CHRONOS_ENABLED=false`) | Enable after torch dependency audit |

---

## 3. Differentiators (亮點 — 確保規劃書提到)

1. **Shadow Price + Relaxation Analysis** — planning contract includes `shadow_price_approx`, `KeyRelaxation` with `estimated_saving` and `nl_text`
2. **Deterministic Reproducibility** — replay simulator, dataset fingerprinting, stable JSON all produce byte-identical output
3. **4-Layer Solver Fallback** — CP-SAT → Gurobi → CPLEX → JS Heuristic
4. **Closed-Loop Feedback** — drift → retrigger → param patch → replan (feature-flagged)
5. **39 Artifact Types** — full audit trail with contract v1 validation
6. **Enterprise Governance** — RBAC, approval workflows, audit logging from Day 1
7. **Robust Planning** — `use_p90_for_safety_stock` and `use_p90_demand_model` flags connect forecast uncertainty directly to solver

---

## 4. Test Coverage Summary

| Layer | Framework | Count | Pass Rate |
|-------|-----------|-------|-----------|
| JavaScript (services, utils, contracts) | Vitest | 681 tests / 231 suites | 100% |
| Python (ML, solver, registry, governance) | pytest | 40+ files / ~12K LOC | ~100% |
| E2E Pipeline | pytest | 15 tests | New |

---

## 5. Recommended Next Steps

| Priority | Action | Expected Impact |
|----------|--------|-----------------|
| 1 | **Prepare Demo Script** (sample Excel → forecast → plan → risk compare → approve) | Proves system end-to-end |
| 2 | **Rewrite Planning Doc** as As-Is → Gap → To-Be (use this report) | Professional credibility |
| 3 | **Add Decision KPI to Planning Doc** (service_level, stockout, cost alongside MAPE) | Shows decision value |
| 4 | **Enable Chronos** in staging env, benchmark against Prophet/LightGBM | Zero-shot model comparison |
| 5 | **Multi-level BOM** if customer requires | Extend `bom_v0` → recursive explosion |
