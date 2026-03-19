# Batch 4 Findings: Infrastructure, Ingestion, and AI Core

**Scope:** `src/services/` (remaining files not in Batches 1-3), including `closed_loop`, `eventLoop`, `ingest`, `supabase`, `observability`, `aiEmployeeLLM`, and domain services.
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
This batch covers the application's foundational infrastructure: data ingestion (ETL), persistence (Supabase DAL), AI model routing, and the closed-loop automation engine.
**Critical Risks:**
1.  **AI Cost & Governance Bypass:** `diModelRouterService.js` (used for structured data tasks) calls `ai-proxy` directly, bypassing the cost tracking and policy enforcement centralized in `modelRoutingService.js`.
2.  **Critical Logic Untested:** The core inventory projection engine (`inventoryProjectionService.js`) and high-volume data ingestion (`ingestRpcService.js`) have **zero** discovered unit tests.
3.  **Upload Strategy Bloat:** `uploadStrategies.js` is a monolithic file mixing UI concerns (progress callbacks) with complex data mapping and persistence logic.

## Correctness & Reliability Findings (P0/P1)

### [P1] AI Cost Tracking Bypass
*   **File:** `src/services/diModelRouterService.js` vs `src/services/modelRoutingService.js`
*   **Impact:** LLM calls made via `runDiPrompt` (Data Profiling, Schema Mapping, Readiness) are **not** recorded in `task_model_runs`. This leads to under-reporting of AI costs and potential budget overruns.
*   **Evidence:** `aiEmployeeLLMService.js` calls `recordModelRun` after execution. `diModelRouterService.js` calls `invokeAiProxy` directly without any `recordModelRun` call.
*   **Fix:** Refactor `diModelRouterService` to use `aiEmployeeLLMService` (or `modelRoutingService`) instead of calling `aiProxyService` directly, or manually add `recordModelRun` calls.

### [P1] Missing Critical Test Coverage
*   **Files:**
    *   `src/services/inventoryProjectionService.js`: Core logic for projected inventory (Cash flow impact).
    *   `src/services/ingestRpcService.js`: High-volume write path.
    *   `src/services/bomExplosionService.js`: Manufacturing requirements calculation.
*   **Impact:** Regressions in these complex calculations could corrupt planning data or break data imports without warning.
*   **Evidence:** `find` command returned no test files for these services.
*   **Fix:** Add unit tests for `projectInventoryByBuckets` logic and RPC error handling.

### [P2] Inconsistent Event Ingestion
*   **File:** `src/services/eventLoop/eventQueueClient.js`
*   **Impact:** Two different paths for event ingestion: `ingestEvent` calls a Python API (`/api/v1/events/ingest`), while `ingestEventDirect` writes directly to Supabase. This creates ambiguity and potential for split behavior (e.g., Python path might run extra validation/enrichment that direct path skips).
*   **Fix:** Standardize on one path or clearly document when to use which (e.g., "Direct is only for client-side synthetic events").

## Maintainability & Code Quality (P2/P3)

### [P2] Monolithic `uploadStrategies.js`
*   **File:** `src/services/uploadStrategies.js`
*   **Impact:** >700 lines containing logic for 9 different upload types. Hard to maintain or add new types without risk of breaking others. It also mixes UI concerns (notifications, progress) with data logic.
*   **Fix:** Split into `src/services/ingest/strategies/{Type}Strategy.js`. Decouple UI callbacks using an event emitter or observer pattern.

### [P3] Redundant AI Routing Logic
*   **Files:** `aiEmployeeLLMService.js`, `diModelRouterService.js`, `modelRoutingService.js`
*   **Impact:** Three services handling LLM routing/calling. `diModelRouterService` seems specialized for "DI Contracts" (JSON outputs), but overlaps significantly with `aiEmployeeLLMService`.
*   **Fix:** Merge `diModelRouterService` logic into `aiEmployeeLLMService` as a specific mode (e.g., `callLLM({ mode: 'di_contract', ... })`).

## Architecture & Simplification

1.  **Unify AI Gateway:**
    *   Make `aiEmployeeLLMService.js` the *single* entry point for all LLM interactions.
    *   Deprecate direct usage of `invokeAiProxy` outside of this service to ensure all calls are tracked, budgeted, and logged.

2.  **Consolidate Ingestion:**
    *   `ingestRpcService.js` and `sheetRunsService.js` provide good primitives.
    *   Refactor `uploadStrategies.js` to purely define the *mapping* and *validation* logic, delegating the actual execution to a generic `BatchIngestOrchestrator` that handles the UI updates and error reporting.

## Batch Summary
Batch 4 reveals a robust but fragmented set of services. The persistence layer (`supabase/*`) is well-structured. The Observability layer (`operationalMetrics.js`) is good but missing the "DI Prompts" blind spot. The biggest immediate win is unifying the AI Model Routing to close the cost tracking gap.
