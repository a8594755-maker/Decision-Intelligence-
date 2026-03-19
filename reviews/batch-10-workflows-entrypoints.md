# Batch 10: Workflows / Prompts / Entrypoints — Findings Memo

**Scope**: 9 files, ~3.6k LOC | **Tests**: 0 | **Date**: 2026-03-18

---

## Confirmed Defects

### [P2] `workflowAEngine.js:1163-1174` — Unbounded `_profileRowCache` memory leak
Module-level Map grows without eviction. Every `startWorkflowA()` call adds an entry never removed.
- **Impact**: Memory growth in long-running sessions.
- **Fix direction**: Add max-size eviction or delete entries on run complete/fail.

### [P2] `workflowAEngine.js:921-922,724-725` — `buildBomBottlenecksCardPayload` called twice in same block
First call for `.total_rows > 0` check, second for payload. Unnecessary duplicate computation.
- **Fix direction**: Assign to local variable once and reuse.

### [P3] `diJsonContracts.js:268`, `intentParserPrompt.js:119` — Prompt injection vector
User message interpolated into LLM prompt with `"${userMessage}"` — no escaping. Malicious input with `"` can break prompt framing.
- **Fix direction**: Escape quotes in user input before interpolation, or use structured message format.

### [P3] `router.jsx:40` — Lazy component relies on parent Suspense boundary
Functionally correct but fragile — if AppShell removes Suspense wrapper, 20+ routes break.

---

## Inferred Risks

| ID | Risk | Evidence |
|----|------|----------|
| IR-1 | ~400 LOC duplicated between workflowAEngine and workflowBEngine | Identical: normalizeBlockingQuestions, sortSteps, classifyErrorCode, runNextStep, etc. |
| IR-2 | workflowBEngine:883 doesn't handle `local-*` IDs (workflowA does) | Offline workflow B runs will throw |
| IR-3 | No role-based auth on `/employees/*` admin routes beyond session check | Any authenticated user can access admin pages |
| IR-4 | Sentry.ErrorBoundary rendered always, unstyled fallback in production | `<p>An error occurred...</p>` looks broken |

---

## Redundancy and Simplification

| Pattern | Recommendation | Rationale |
|---------|---------------|-----------|
| workflowAEngine + workflowBEngine shared infra (~400 LOC) | **Merge** → extract `workflowEngineBase.js` | Bug fixes in one engine may miss the other |
| `App.jsx` (14 LOC) | **Delete** | Dead compatibility shim, zero imports found |
| `dataProfilerPrompt.js` (13 LOC) | **Delete or inline** | Trivial passthrough re-export, 1 consumer |
| Double `buildBomBottlenecksCardPayload` call | **Collapse** | Assign to variable once |

---

## Test Coverage Gaps

**Zero tests for any file in this batch.**

| File | LOC | Risk |
|------|-----|------|
| `workflowAEngine.js` | 1549 | **Critical** — complex orchestration, step lifecycle, error classification |
| `workflowBEngine.js` | 1222 | **Critical** — same complexity |
| `workflowRegistry.js` | ~200 | Medium — normalizeWorkflowName, parseRunId edge cases |
| `diJsonContracts.js` | ~400 | Medium — clampJsonPayload truncation, prompt builders |
| `intentParserPrompt.js` | ~150 | Low — validateIntentContract boundaries |
| `router.jsx` | ~100 | Low — lazy import resolution |

---

## Batch Summary

Architecture is sound: workflow engines follow consistent step-handler pattern with error classification and blocking-question support. Router uses lazy loading with auth at AppShell boundary.

Key concerns: (1) Unbounded `_profileRowCache` memory leak. (2) ~400 LOC duplicated between two workflow engines — maintenance risk. (3) `App.jsx` is dead code. (4) LLM prompt injection vectors from unescaped user input. (5) Entire workflow orchestration layer (2,771 LOC across 3 files) has zero unit tests.
