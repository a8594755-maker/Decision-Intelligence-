# Batch 8 Findings: Utilities & Shared Logic

**Scope:** `src/utils/**`
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
The `src/utils/` directory acts as a catch-all for both generic helpers (date parsing, formatting) and heavy domain logic (inventory replay, constraint checking). While the individual files are generally high-quality and pure, the architectural boundary between "Service", "Domain", and "Util" is blurred.
**Critical Risks:**
1.  **Core Logic Hidden in Utils:** Critical business logic like `replaySimulator.js` (Inventory Projection) and `constraintChecker.js` (Plan Validation) resides in `utils/`. These are domain engines, not just utilities.
2.  **Mapping Logic Fragmentation:** Column mapping logic is split across `aiMappingHelper.js`, `deterministicMapping.js`, `headerNormalize.js`, `fieldPatternInference.js`, and `mappingValidation.js`. This makes it hard to trace the full mapping pipeline.
3.  **Csv Parsing Security:** `exportWorkbook.js` and `dataValidation.js` use `SheetJS` (XLSX) but `poNormalizer.js` and others seem to do manual parsing or rely on `papaparse` implicitly via other services. Inconsistent parsing strategies.

## Correctness & Reliability Findings (P0/P1)

### [P1] `replaySimulator.js` Precision
*   **Context:** Used for "What-If" analysis and "Inventory Projection".
*   **Observation:** Uses `Number.toFixed(6)` for rounding.
*   **Risk:** Repeated rounding in the loop (running total) might accumulate errors over long horizons (365+ days).
*   **Fix:** Maintain full precision in the accumulator and only round for display/output.

### [P2] `dataCleaningUtils.js` Date Parsing
*   **Context:** `parseDate` handles many formats.
*   **Risk:** It attempts to parse `YYYYMMDD` but might misinterpret if the string is ambiguous.
*   **Fix:** Use a dedicated library like `date-fns` or `luxon` for robust parsing instead of regex-heavy custom logic.

## Maintainability & Code Quality (P2/P3)

### [P2] Logic Fragmentation (Mapping)
*   **Observation:** The "Smart Mapping" feature spans at least 5 utility files.
*   **Fix:** Consolidate mapping logic into a `src/domains/mapping/` directory or a cohesive `MappingService` class that composes these utilities.

### [P3] "God Utils"
*   **File:** `dataProcessing.js`
*   **Observation:** Contains `extractSuppliers`, `validateFile`, `filterData`, `sortData`, `paginateData`. These are unrelated concerns.
*   **Fix:** Split into `fileUtils.js`, `dataGridUtils.js`, `supplierUtils.js`.

### [P3] Test Coverage
*   **Observation:** `replaySimulator.js` and `constraintChecker.js` have `.test.js` files (GOOD). However, `dataCleaningUtils.js` and `exportWorkbook.js` appear less covered.
*   **Action:** Ensure critical data transformation utilities have comprehensive unit tests.

## Architecture & Simplification

1.  **Promote Domain Engines:**
    *   Move `replaySimulator.js` -> `src/domains/inventory/replayEngine.js`
    *   Move `constraintChecker.js` -> `src/domains/planning/constraintEngine.js`
    *   Move `capabilityUnlockRanker.js` -> `src/domains/onboarding/`
    *   *Rationale:* These are not generic utilities; they are the core business logic of the application.

2.  **Consolidate CSV/Excel Handling:**
    *   Create a unified `src/services/data/parser.js` that abstracts `SheetJS`/`PapaParse`.
    *   Ensure consistent date/number parsing rules across all imports.

## Batch Summary
The `src/utils` folder contains some of the most important code in the app (the "brains" of the planning engine). It is functional and tested, but architecturally misplaced. Promoting these to a `domains/` folder would clarify the architecture significantly.
