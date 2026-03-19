# Batch 9 Findings: Domains, Contracts, Config & Hooks

**Scope:** `src/domains/**`, `src/contracts/**`, `src/config/**`, `src/hooks/**`
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
This batch covers the core business logic ("Domains"), data contracts, configuration, and React hooks. The architecture shows a strong move towards "Domain-Driven Design" with pure calculation functions in `src/domains/`. However, the `src/hooks/` layer often leaks business logic or directly accesses the database, bypassing the service layer.
**Critical Risks:**
1.  **Contract Monolith:** `diArtifactContractV1.js` is over 1000 lines long and contains validators for every artifact type in the system. This is a merge conflict magnet and hard to maintain.
2.  **Heavy Hooks:** `useRiskData.js` and `useForecastData.js` contain significant orchestration logic (data fetching, normalization, calculation invocation) that duplicates logic found in Views or Services.
3.  **Recursive Complexity:** `src/domains/forecast/bomCalculator.js` implements a complex recursive BOM explosion in-memory. While pure, it lacks safeguards against extremely deep or cyclic graphs beyond a simple depth counter (though `MAX_BOM_DEPTH` exists).

## Correctness & Reliability Findings (P0/P1)

### [P1] Direct Database Access in Hooks
*   **Files:** `src/hooks/useWidgetData/useForecastData.js`, `src/hooks/useWidgetData/useRiskData.js`, `src/hooks/useSessionContext.js`.
*   **Impact:** These hooks import `supabase` directly and execute queries. This creates a distributed data access layer that is hard to mock, test, or migrate.
*   **Fix:** Ensure all data fetching goes through `src/services/`. Hooks should only call service methods.

### [P2] Incomplete Abstraction in `useRiskData`
*   **File:** `src/hooks/useWidgetData/useRiskData.js`
*   **Observation:** This hook dynamically imports domain calculators (`coverageCalculator`, `profitAtRiskCalculator`) and orchestrates the entire risk calculation pipeline on the client side.
*   **Risk:** This heavy computation blocks the UI thread. It mirrors the logic in `RiskDashboardView`, potentially leading to drift if one is updated and the other isn't.
*   **Fix:** Move the orchestration of "Fetch -> Normalize -> Calculate" into a `RiskService` that can be called by both the View and the Hook (or run in a Worker).

## Maintainability & Code Quality (P2/P3)

### [P2] Monolithic Contract File
*   **File:** `src/contracts/diArtifactContractV1.js`
*   **Impact:** Contains validators for Forecast, Plan, Risk, Negotiation, and Review artifacts all in one file.
*   **Fix:** Split into `src/contracts/validators/forecastValidators.js`, `planValidators.js`, etc., and export a registry from `diArtifactContractV1.js`.

### [P3] Hardcoded Configs
*   **File:** `src/config/capabilityMatrix.js`
*   **Observation:** Defines data requirements for capabilities. Good usage, but some degradation notes and field lists are verbose and repetitive.
*   **Fix:** Normalize the schema definition to reduce duplication.

## Architecture & Simplification

1.  **Pure Domain Logic (Success):**
    *   The files in `src/domains/` (e.g., `inventory/calculator.js`, `supply/poDelayProbability.js`) are excellent examples of functional core logic. They are testable and framework-agnostic. This pattern should be encouraged.

2.  **Hook/Service Boundary:**
    *   Current: Component -> Hook -> Supabase (Direct) + Domain Logic
    *   Target: Component -> Hook -> Service -> Supabase
    *   *Action:* Refactor `useWidgetData` hooks to delegate to Services.

## Batch Summary
The `src/domains` directory is the cleanest part of the codebase logic-wise. The `src/contracts` system is robust but bloated. The `src/hooks` layer is the weak point, acting as a "God Layer" that does too much (fetching, calculating, state management) instead of just binding UI to Services.
