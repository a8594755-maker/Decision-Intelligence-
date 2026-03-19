# Batch 6 Findings: Application Components & Canvas

**Scope:** `src/components/**` (excluding `chat/`).
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
This batch covers the core application UI components, including the "Canvas" widget system, data management panels, dashboards, and reusable UI elements.
**Critical Risks:**
1.  **Data Access in UI Layer:** Multiple components (e.g., `RiskDetailModal`, `ForecastWidgetLive`) import `supabaseClient` and make direct DB queries in `useEffect`. This bypasses the Service Abstraction Layer, making testing difficult and schema refactoring risky.
2.  **God Components:** `DataImportPanel.jsx` (~1000 lines) and `WhatIfPanel.jsx` (~500 lines) are monolithic, handling complex state, IO, and UI logic.
3.  **Missing Error Boundaries:** While `ErrorBoundary.jsx` exists, individual widgets in the Dynamic Canvas do not appear to be wrapped in granular error boundaries, meaning one crashing widget could crash the whole canvas.

## Correctness & Reliability Findings (P0/P1)

### [P1] Direct Database Access in Components
*   **Files:** `src/components/risk/RiskDetailModal.jsx`, `src/components/canvas/widgets/ForecastWidget.jsx` (Live mode), `src/components/monitor/KpiWatchPanel.jsx`.
*   **Impact:** Components are tightly coupled to the database schema. Changing a table name or column requires updating React components. Logic is hard to unit test without mocking Supabase globally.
*   **Evidence:** `import { supabase } from '../../services/supabaseClient';` followed by `await supabase.from('...').select(...)` inside components.
*   **Fix:** Move all data fetching logic into custom hooks (e.g., `useRiskDetails`, `useForecastData`) or service methods. Components should only call these hooks/services.

### [P2] Race Conditions in Data Loading
*   **File:** `src/components/risk/RiskDetailModal.jsx`
*   **Impact:** If the user switches tabs quickly (e.g., Inventory -> BOM), the async requests might complete out of order or update state on an unmounted component (though `cancelled` flags are used in some places, it's inconsistent).
*   **Fix:** Use a data fetching library like `TanStack Query` (React Query) which handles cancellation, caching, and race conditions automatically.

## Maintainability & Code Quality (P2/P3)

### [P2] Monolithic `DataImportPanel.jsx`
*   **File:** `src/components/DataImportPanel.jsx`
*   **Impact:** Contains logic for file parsing, worker management, sheet classification, validation preview, and progress tracking. Very hard to read or maintain.
*   **Fix:** Refactor into a multi-step wizard where each step is a separate component (`ImportStepUpload`, `ImportStepMapping`, `ImportStepValidation`, `ImportStepProgress`). Move state to a `useImportWizard` hook.

### [P3] Hardcoded Strings & Magic Numbers
*   **File:** `src/components/canvas/widgets/InventoryWidget.jsx`
*   **Impact:** `FORECAST_STOP_ROWS = 100000`. Such configuration should be in a centralized config file or constants file, not scattered in components.
*   **Fix:** Move constants to `src/config/uiConstants.js`.

### [P3] Inconsistent Virtualization
*   **Files:** `RiskTable.jsx` vs `PlanTableCard.jsx`.
*   **Impact:** `RiskTable` uses `tanstack-virtual`, while other large tables might use pagination or simple mapping. Inconsistent UX and performance characteristics.
*   **Fix:** Standardize on a single `DataTable` component (like `src/components/ui/Table.jsx`) that handles virtualization or pagination consistently.

## Architecture & Simplification

1.  **Widget Architecture:**
    *   The `WidgetRegistry.js` + `DynamicCanvas.jsx` pattern is excellent. It allows for lazy loading and extensibility.
    *   *Recommendation:* Formalize the "Widget Contract" (props passed to every widget: `data`, `mode`, `user`) and ensure all widgets adhere to it.

2.  **Service Integration:**
    *   Strictly enforce "No `import { supabase }` in `src/components`".
    *   Create `src/hooks/use[Entity].js` for all data requirements.

## Batch Summary
The UI layer is feature-rich but "leaky" regarding data access. The Component library (`src/components/ui`) is a good foundation. The Canvas system is well-architected. The main technical debt is the logic creep into huge components like `DataImportPanel`.
