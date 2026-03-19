# Batch 3: Root-Level Planning / Intent Services — Findings Memo

**Scope**: ~22 source files, ~12.7k LOC | **Tests**: 84/84 pass (4 test files) | **Date**: 2026-03-18

---

## Confirmed Defects

### [P1] `chatTaskDecomposer.js` — `workflow_type: 'excel'` not in KNOWN_WORKFLOWS
Keyword fallback pushes steps with `workflow_type: 'excel'`, but `KNOWN_WORKFLOWS` validation set doesn't include `'excel'`. `validateDecomposition()` will flag Excel export tasks as invalid.
- **Impact**: Excel export tasks fail validation in keyword-based decomposition path.
- **Fix direction**: Add `'excel'` to `KNOWN_WORKFLOWS`.

### [P2] `chatForecastService.js` — 4 utility functions still duplicated from dataServiceHelpers
Lines ~144-211 locally re-declare `toNumber`, `createBlockingError`, `normalizeRowsFromUserFile`, `getRowsForSheet` — all identical to dataServiceHelpers versions. Incomplete refactoring remnant.
- **Fix direction**: Import from dataServiceHelpers. The local `normalizeTargetMapping` with forecast-specific targets can stay (or use the `knownTargets` parameter).

### [P2] `chatCanvasWorkflowService.js` — `toNumber` and `normalizeText` duplicated
Lines ~70-77 re-declare both, identical to dataServiceHelpers.

### [P2] `basePlanResolverService.js:169` — Dead code in fetchRecentPlans
`_run = diRunsService.getLatestRunByStage(...)` result is never read. Function separately fetches all recent runs and filters client-side.

### [P2] `scenarioEngine.js` — Potential double-application of scenario overrides
`scenarioEngine.js` re-exports `applyScenarioOverridesToPayload`. Same function also called inside `chatPlanningService.js:1726-1732`. If caller goes through scenarioEngine then planning service, overrides could be doubled (e.g., demand_multiplier applied twice).
- **Impact**: Scenario demand could be 2x what user intended.
- **Fix direction**: Apply overrides in exactly one place, with idempotency guard.

### [P3] `chatPlanningService.js:1741` — `console.warn` instead of structured logger
### [P3] `chatPlanningService.js` — Duplicated plan row normalization (base pass ~1781-1806 vs risk pass ~2175-2191)

---

## Inferred Risks

| ID | Risk | Evidence |
|----|------|----------|
| IR-1 | `sessionContextService.js` cross-tab localStorage race | No `storage` event listener, concurrent writes possible |
| IR-2 | `clarificationService.js` in-memory Map lost on HMR/restart | `_pendingClarifications` is primary store, DB is best-effort |
| IR-3 | `planGovernanceService.js` no auth beyond `x-actor-id` header | Lines 27-28 send plain headers, no JWT |
| IR-4 | "Missing table" error detection duplicated across 3+ files | planAuditService, planWritebackService, sessionContextService |
| IR-5 | `chatRefinementService.js:88` dynamic import suggests circular dependency | Should convert to static import if cycle is broken |

---

## Redundancy and Simplification

| Pattern | Files | Est. LOC Saved | Recommendation |
|---------|-------|----------------|----------------|
| Duplicated `toNumber`, `createBlockingError`, `normalizeRowsFromUserFile`, `getRowsForSheet` | chatForecastService.js | ~60 | **Merge** — import from dataServiceHelpers |
| Duplicated `toNumber`, `normalizeText` | chatCanvasWorkflowService.js | ~10 | **Merge** |
| "Missing table" error detection | 3 files | ~50 | **Merge** — extract to supabaseErrorHelpers.js |
| Plan row normalization (base vs risk) | chatPlanningService.js | ~25 | **Collapse** — extract shared helper |

---

## Test Coverage Gaps

**18 of 22 source files have ZERO test coverage.** Only 4 files have tests:
- chatIntentService (8 tests)
- chatSessionContextBuilder (16 tests)
- chatTaskDecomposer (29 tests)
- scenarioIntentParser (31 tests)

**Most critical gap**: `chatPlanningService.js` (~3000 LOC, zero direct tests) — the largest and most complex file in this batch and arguably the entire codebase. It's tested only indirectly via degradation/e2e tests.

Other untested critical files: chatForecastService (~1000 LOC), chatRiskService (~612 LOC), chatCanvasWorkflowService (~840 LOC), sessionContextService (~772 LOC), decisionTaskService (~300 LOC).

---

## Batch Summary

The planning/intent layer is the backbone of the product — it transforms user data into actionable plans via forecast, optimization, and risk analysis. The code is functional and well-structured at macro level.

Top concerns: (1) **P1**: Excel workflow type fails validation. (2) **P2**: Incomplete dataServiceHelpers refactoring leaves ~70 lines duplicated. (3) **Coverage**: 18/22 files have zero tests, with chatPlanningService (~3000 LOC) being the single biggest coverage risk in the entire codebase. (4) Scenario override double-application risk could silently corrupt planning outputs.
