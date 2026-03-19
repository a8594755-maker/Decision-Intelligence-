# Batch 1: src/services/aiEmployee/** — Findings Memo

**Scope**: 55 files, ~11.8k LOC | **Tests**: 174 pass | **Date**: 2026-03-18

---

## Confirmed Defects

### [P1] `orchestrator.js:573,657` — Step status set to 'review_hold' which is not a valid STEP_STATES value
When capability policy or governance rule gates block a step, the orchestrator writes `status: 'review_hold'`. But `STEP_STATES` only has 7 states (pending, waiting_input, running, succeeded, failed, retrying, skipped). The step becomes permanently stuck — `getNextPendingStep()` only queries `['pending', 'retrying']`.
- **Impact**: Steps permanently stuck when capability/governance policies trigger holds.
- **Evidence**: `stepStateMachine.js` defines 7 states; `'review_hold'` is not among them.
- **Fix direction**: Add `REVIEW_HOLD` to `STEP_STATES` with transitions, or use `WAITING_INPUT` and store hold reason separately.

### [P1] `orchestrator.js:536-539,587-589,612-614` — Budget/sensitive/permission gates write raw 'failed' bypassing state machine
These paths write `status: 'failed'` directly without `stepTransition()`. Step may be in `'pending'` and `pending → failed` is not a valid transition.
- **Impact**: State machine invariant violation. Audit/replay relying on state consistency will break.
- **Fix direction**: Transition step to `running` first then `failed`, or add `pending → failed` shortcut event.

### [P2] `trustMetricsService.js:417-423,436-443` — `fetchReviews`/`fetchAiReviews` have no employee_id filter
Both query review tables by date range only, not scoped to the employee. In multi-worker setups, all workers' reviews contaminate each other's trust metrics.
- **Impact**: Autonomy levels computed incorrectly in multi-worker environments.
- **Evidence**: `fetchTasks` at line 408 correctly filters by `employee_id`; `fetchReviews` does not.
- **Fix direction**: Join through `ai_employee_tasks` to filter reviews by the employee's task IDs.

### [P2] `orchestrator.js:262-265` — `cancelTask` assumes employee is BUSY without checking
Hardcodes `employeeTransition(EMPLOYEE_STATES.BUSY, ...)` without reading actual state. If employee is in `REVIEW_NEEDED` or `ERROR`, transition is invalid (silently caught).
- **Impact**: Employee state may remain stuck after cancellation.
- **Fix direction**: Read actual `_logicalState` before transitioning.

### [P2] `taskActionService.js:111-118` — `resolveReviewDecision('needs_revision')` bypasses orchestrator
Writes `status: 'failed'` directly, bypassing worklog, SSE, and event bus notifications. No `TASK_FAILED` event emitted.
- **Fix direction**: Route through orchestrator method.

### [P3] `pythonToolExecutor.js:7`, `excelExecutor.js:13` — Hardcoded `http://localhost:8000`
Should read `import.meta.env.VITE_ML_API_URL` with localhost fallback, matching orchestrator:102-104.
- **Impact**: Non-localhost deployments fail silently.

---

## Inferred Risks

| ID | Risk | Evidence | Depends on |
|----|------|----------|------------|
| IR-1 | `task.version += 1` in-memory mutation vulnerable to concurrent OCC conflicts | Lines 968, 998, 1085, 1116 | Multi-tab/concurrent access |
| IR-2 | `lazyContextService.js:89` queries `ai_employee_task_steps` but actual table may be `ai_employee_runs` | stepRepo uses different table name | DB schema |
| IR-3 | `orchestrator.js:511` mutates `task.input_context` in-memory without DB writeback | Lazy-resolved dataset ID lost on next tick | Tick loop re-reads from DB |

---

## Redundancy and Simplification

| Module/Pattern | Recommendation | Rationale |
|---|---|---|
| `templatePlanAdapter.js` — `buildPlanFromTemplateTask` vs `buildPlanFromTaskTemplate` | **Merge** | ~90% identical, differing only in param shape |
| `review.js` — thin wrapper around `aiReviewerService.reviewStepOutput` | **Keep but note** | Orchestrator imports `reviewStepOutput` directly AND uses `review.js`'s `shouldReview()`. Re-export from `index.js` is unused |
| `executionPolicy.js` | **Keep** | 24 LOC, used by templatePlanAdapter |
| `workOrderDraftService.js` vs `planner.js` | **Keep both** | Different use cases (instant heuristic vs full LLM decomposition) |
| `queries.js` | **Keep** | Clean facade pattern with non-trivial `enrichRunArtifactRef` |

---

## Test Coverage Gaps

1. **orchestrator.js (0 direct unit tests)** — Most critical file (~1200 LOC) has zero unit tests. Complex logic in `_executeStep`, `_handleStepFailure`, self-healing retry, capability/governance/approval gates, autonomy auto-approve all untested directly.
2. **Tick loop error handling** — Catch blocks at lines 467-481 untested.
3. **provideStepInput** — Dataset attachment + unblock flow untested.
4. **cancelTask / retryTask** — Employee state transitions during cancel/retry untested.
5. **Lazy context resolution** — `detectMissingContext` → `resolveContext` → in-memory mutation untested.
6. **Cross-worker trust metric contamination** — No test verifies employee-scoped review queries.

---

## Batch Summary

Architecturally sound: clean separation between state machines (pure functions), persistence (Supabase repos), executors (pure async), and orchestration (single mutation owner). Three state machines are well-designed and thoroughly tested (174 tests pass). Style learning pipeline is comprehensive.

Most significant: **step 'review_hold' status doesn't exist in state machine** (P1) — steps become permanently stuck on capability/governance holds. **Trust metrics cross-worker contamination** (P2) will compute wrong autonomy levels in multi-worker setups. **Zero orchestrator unit tests** is the biggest structural gap.
