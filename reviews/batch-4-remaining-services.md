# Batch 4: Remaining src/services/** — Findings Memo

**Scope**: ~80 files (closed_loop/, hardening/, supabase/, topology/, observability/, eventLoop/, roi/, kpiMonitor/, artifacts/, forecasting/, ~50 root-level) | **Tests**: 2160 pass | **Date**: 2026-03-18

---

## Confirmed Defects

### [P1] `sandboxRunner.js` — `_runDirect` ignores timeout parameter
The fallback path (when Web Worker unavailable) accepts `_timeoutMs` but never enforces it. LLM-generated code could run indefinitely, blocking the main thread. Worker path correctly enforces timeout via `setTimeout + terminate()`.
- **Impact**: Main thread blocked indefinitely by runaway LLM code.
- **Fix direction**: Add `setTimeout` + `Promise.race` in `_runDirect`.

### [P2] `supplierEventConnectorService.js:374-396` — Creates new Supabase client per event
`processSupplierEvent()` dynamically imports `@supabase/supabase-js` and calls `createClient()` on every event. Bypasses singleton from `supabaseClient.js`, creating connection overhead and losing auth context.
- **Fix direction**: Import singleton client.

### [P2] `webhookIntakeService.js` — `_updateWebhookStats` TOCTOU race condition
Stats update reads counter, increments in JS, writes back. Concurrent webhooks will lose events.
- **Fix direction**: Use Supabase RPC or SQL `increment`.

### [P2] `workflowBClosedLoopBridge.js` — `sessionStorage` for cooldown (browser-only)
`sessionStorage` throws in SSR, Node.js tests, or Web Worker contexts. Rest of closed-loop uses in-memory `Map`.
- **Fix direction**: Use in-memory Map with TTL, matching rest of subsystem.

### [P2] `closedLoopPersistence.js:11` — Inconsistent import specifier (no `.js` extension)
Works with Vite but fails in strict ESM environments.

### [P3] `governanceService._governanceItems` — Unbounded in-memory array
No size cap. Other similar services cap at 200-500 entries.

### [P3] `liveDataQueryService.js:171` — ilike filter vulnerable to SQL wildcard injection
`%${value}%` doesn't escape `%` and `_` in user input. User can inject `%` to match everything or craft slow patterns.
- **Fix direction**: Escape `%` → `\%` and `_` → `\_` in user input before interpolation.

---

## Inferred Risks

| ID | Risk | Evidence |
|----|------|----------|
| R1 | `dynamicToolExecutor.js` auth check reads localStorage key naming convention directly | Fragile coupling to Supabase internal storage format |
| R2 | `ingestRpcService.js` staging cleanup on failure is best-effort (orphaned rows) | `.catch(() => {})` swallows cleanup errors |
| R3 | Multiple services' in-memory dedup Maps never fully evict | supplierEventConnector, closedLoopStore, governanceService, idempotencyService |
| R4 | `normalizeBaseUrl` + `withTimeout` pattern duplicated across 5+ API clients | forecastApiClient, asyncRunsApiClient, planGovernanceService, digitalTwinService, optimizationApiClient |

---

## Redundancy and Simplification

| Pattern | Files | Est. LOC | Recommendation |
|---------|-------|----------|----------------|
| `normalizeBaseUrl` / `withTimeout` / `postJson` | 5 API client files | ~150 | **Merge** → shared `apiClientBase.js` |
| `trySupabase()` wrapper | 8+ files | ~80 | **Merge** → shared utility |
| `_archive/` deprecated stubs | 3 files | ~90 | **Delete** — marked "ZERO production imports" |
| `ingestRpcService` goods receipts / price history | 1 file, 2 functions | ~90 | **Collapse** — parameterize into single function |

---

## Test Coverage Gaps

| File | Gap |
|------|-----|
| `liveDataQueryService.js` | No tests. ilike injection (P3) would be caught. |
| `planWritebackService.js` | No tests. Critical path: writes approved plans to baseline. |
| `supplierEventConnectorService.js` | Existing tests don't cover per-event client creation. |
| `mappingProfileService.js` | No tests. `generateHeaderFingerprint` is pure-function testable. |
| `macroSignalService.js` | No tests. Pure parsers ideal for unit testing. |
| `ingestRpcService.js` | No tests. Complex staging + finalize flow. |
| `dynamicToolExecutor.js` | No tests. LLM code execution + auth check. |

---

## Batch Summary

Well-structured with consistent patterns (Supabase + localStorage fallback, pure functions + async orchestrator). Most actionable: **P1 sandbox timeout bypass** in `_runDirect` (runaway LLM code), **P2 per-event Supabase client creation** (performance + correctness). Biggest code health win: extracting duplicated `normalizeBaseUrl`/`withTimeout`/`trySupabase` into shared utilities (~320 LOC savings).
