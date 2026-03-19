# Batch 7 Findings: Pages & Views

**Scope:** `src/pages/**`, `src/views/**`
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
This batch covers the top-level route components ("Pages") and the heavy business logic containers ("Views").
**Critical Risks:**
1.  **God Object (`DecisionSupportView.jsx`):** A massive 2900+ line component that orchestrates the entire AI chat experience. Despite extracting some hooks (`useForecastExecutor`, etc.), it remains the single point of failure for the application's core feature.
2.  **Direct Database Coupling:** Almost all Views (`RiskDashboardView`, `ForecastsView`, `BOMDataView`) import `supabaseClient` and execute raw SQL queries inside `useEffect`. This makes the frontend tightly coupled to the DB schema and hard to test.
3.  **Inconsistent API Usage:** `SyntheticERPSandbox.jsx` performs direct `fetch` calls to the ML API, bypassing the service layer abstractions used elsewhere.

## Correctness & Reliability Findings (P0/P1)

### [P1] Unmaintainable "God View"
*   **File:** `src/views/DecisionSupportView/index.jsx`
*   **Impact:** 2900+ LOC. Any change to the chat behavior, layout, or state management carries a high risk of regression. The component handles too many concerns: layout, auth, SSE events, data fetching, intent routing, and UI rendering.
*   **Fix:** Continue the refactoring started with `use*Executor` hooks. Extract the UI layout into smaller sub-components (`ChatArea`, `CanvasArea`) that accept props, rather than managing everything in one file.

### [P1] Direct Data Access in Views
*   **Files:** `RiskDashboardView.jsx`, `ForecastsView.jsx`, `BOMDataView.jsx`
*   **Impact:** Frontend logic contains specific column names and SQL relationships. Schema changes (e.g., renaming `material_code` to `sku`) will require "shotgun surgery" across multiple UI files.
*   **Evidence:** `supabase.from('po_open_lines').select('*')` calls directly in `useEffect`.
*   **Fix:** Move all Supabase queries into the `src/services/` layer (e.g., `riskService.js`, `bomService.js`). Views should only call service methods.

### [P2] Hardcoded API Calls
*   **File:** `src/pages/SyntheticERPSandbox.jsx`
*   **Impact:** Direct `fetch` calls to `http://localhost:8000` (or env var). Bypasses any centralized error handling, auth token injection (if needed later), or logging.
*   **Fix:** Wrap these calls in a `syntheticDataService.js`.

## Maintainability & Code Quality (P2/P3)

### [P2] Duplicate Logic in Views
*   **Observation:** `RiskDashboardView` and `ForecastsView` both implement their own loading states, error handling banners, and tab switching logic.
*   **Fix:** Create a `ViewShell` component or higher-order component (HOC) that handles the common "Page Header + Tabs + Loading/Error State" pattern.

### [P3] Prop Drilling
*   **Observation:** `user` and `addNotification` are passed down from `App.jsx` -> `Page` -> `View` -> `Component`.
*   **Fix:** Rely more on `useAuth()` and `useApp()` hooks within the components that need them, rather than passing them as props through every layer.

## Architecture & Simplification

1.  **Strict MVC Separation:**
    *   **Model/Service:** Supabase queries, API calls, business logic transformation.
    *   **View/Page:** Layout, route management, parameter parsing.
    *   **Controller/Hook:** Glue code that calls services and updates view state (`useRiskData`, `useForecastData`).
    *   *Current State:* Views are doing Model + Controller work.

2.  **Feature Slices:**
    *   Instead of splitting by `views/` vs `services/`, consider grouping by feature: `src/features/risk/` (containing `RiskDashboardView`, `riskService`, `RiskCard`, etc.). This might be too big a refactor now, but worth considering for V2.

## Batch Summary
The Views layer confirms the pattern observed in components: "Smart" UI components that know too much about the backend. `DecisionSupportView` is the most critical technical debt item in the frontend. Refactoring it is essential for long-term velocity.
