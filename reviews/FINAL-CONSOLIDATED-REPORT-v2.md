# Final Consolidated Code Review Report: Decision Intelligence Platform

**Date:** 2026-03-18
**Reviewer:** Cascade
**Scope:** Full Source Code (`src/**`)
**Batches Covered:** 1 through 10

---

## 1. Executive Summary

The Decision Intelligence platform is a sophisticated, feature-rich application implementing complex supply chain workflows (Planning, Risk, Negotiation, Forecasting). The architecture follows a generally sound separation of concerns but suffers from significant **"Logic Leakage"** and **"God Object"** patterns as it has scaled.

The codebase is at a **tipping point**. While functional, the current trajectory of tightly coupling UI components to database schemas and concentrating logic in massive "Engine" files will severely hamper future velocity and testability.

### Overall Health Score: 🟡 Amber (Functional but Brittle)

| Aspect | Status | Notes |
| :--- | :--- | :--- |
| **Architecture** | 🟡 | Service layer exists but is often bypassed by UI/Hooks. |
| **Code Quality** | 🟢 | Generally clean, modern ES6+/React patterns. Good use of functional programming in Domains. |
| **Security** | 🔴 | **CRITICAL:** Direct SQL execution in UI/Hooks; minimal RLS visibility. |
| **Testability** | 🔴 | Hard to unit test due to direct Supabase imports in components. |
| **Maintainability**| 🟡 | Monolithic files (>1000 LOC) in Workflows and Views are risk hotspots. |

---

## 2. Critical Risks (P0 / P1)

These issues require immediate attention to prevent production incidents or severe technical debt accumulation.

### 🚨 P0: Data Access Layer Bypass
*   **Issue:** Dozens of UI Components (`RiskDashboardView`, `ForecastWidgetLive`, `useRiskData`) import `supabaseClient` directly and execute raw queries (`.from('table').select(...)`).
*   **Impact:**
    *   **Security:** Frontend logic determines data access rules, making RLS audit difficult.
    *   **Fragility:** Database schema refactors (renaming columns) will require "shotgun surgery" across hundreds of UI files.
    *   **Untestable:** Impossible to unit test UI components without mocking the entire Supabase client.
*   **Remediation:** Enforce a strict rule: **UI components must ONLY call `src/services/`**. Move all Supabase queries into service files.

### 🚨 P1: The "God View" (`DecisionSupportView.jsx`)
*   **Issue:** A single file with **~2900 lines of code**. It handles routing, auth, chat state, SSE events, data fetching, and layout.
*   **Impact:** High risk of regression with every change. Extremely difficult to read or debug.
*   **Remediation:** Deconstruct into sub-components (`ChatInterface`, `CanvasManager`, `WorkflowOrchestrator`). Move state management to a dedicated Context or Redux store.

### 🚨 P1: Monolithic Workflow Engines
*   **Issue:** `workflowAEngine.js` and `workflowBEngine.js` are massive (>1500 LOC each) and tightly coupled to specific service implementations.
*   **Impact:** Adding a new workflow step requires editing the core engine. Hard to test distinct path/branching logic.
*   **Remediation:** Implement a generic `WorkflowRunner` that accepts a definition object (steps, transitions) rather than hardcoding logic.

### 🚨 P1: Logic Hidden in Utilities
*   **Issue:** Critical domain logic (e.g., `replaySimulator.js` for inventory projection, `constraintChecker.js` for plan validation) resides in `src/utils/`.
*   **Impact:** Core business rules are treated as "helpers". They lack the visibility and rigorous testing structure of a proper Domain layer.
*   **Remediation:** Promote these to `src/domains/` (e.g., `src/domains/planning/engine.js`).

---

## 3. Layer-by-Layer Analysis

### 3.1 Services (`src/services/`)
*   **Strengths:** Good encapsulation of specific features (e.g., `aiEmployeeLLMService`).
*   **Weaknesses:** Some services are just thin wrappers around Supabase, while others (like `chatPlanningService`) contain heavy formatting logic that belongs in the Domain/View layer.
*   **Action:** Ensure Services focus on **Data I/O and Orchestration**, delegating calculation to Domains and formatting to Transformers.

### 3.2 UI & Components (`src/components/`, `src/views/`)
*   **Strengths:** The **Canvas/Widget architecture** (`WidgetRegistry.js`, `DynamicCanvas.jsx`) is a highlight—extensible and modular.
*   **Weaknesses:** `CanvasPanel.jsx` (~900 lines) and `DataImportPanel.jsx` (~1000 lines) are mini-monoliths.
*   **Action:** Aggressively extract sub-components. For example, `DataImportPanel` should be a wizard with distinct steps in separate files.

### 3.3 Domain Logic (`src/domains/`)
*   **Strengths:** Files like `inventory/calculator.js` and `supply/poDelayProbability.js` are excellent. They are pure functions, easily testable, and framework-agnostic.
*   **Action:** **This is the model to follow.** Move more logic from Utils and Hooks into this layer.

### 3.4 Hooks (`src/hooks/`)
*   **Weaknesses:** `useRiskData` and `useForecastData` are doing too much work (fetching, normalizing, calculating). They act as "God Hooks".
*   **Action:** Hooks should bind UI to Services. Logic should move to Services or Domains.

---

## 4. Refactoring Roadmap

### Phase 1: Secure the Core (Weeks 1-4)
1.  **Stop the Bleeding:** Establish linting rules to forbid `import { supabase }` in `src/components/`.
2.  **Service Layer Extraction:** SYSTEMATICALLY move every raw Supabase query from `src/views/**` into a corresponding `src/services/*Service.js` file.
    *   *Target:* `RiskDashboardView`, `ForecastsView`, `BOMDataView`.

### Phase 2: Deconstruct Monoliths (Weeks 5-8)
1.  **DecisionSupportView:** Break into `ChatContainer` (left) and `CanvasContainer` (right). Extract `useAgentOrchestrator` to handle the SSE/Event logic.
2.  **CanvasPanel:** Split into `CanvasCharts`, `CanvasLogs`, `CanvasCode`.
3.  **DataImportPanel:** Refactor into a multi-step Wizard pattern.

### Phase 3: Domain Purity (Weeks 9-12)
1.  **Promote Utils:** Move `replaySimulator`, `constraintChecker`, and `capabilityUnlockRanker` to `src/domains/`.
2.  **Unify Mapping:** Consolidate the 5+ different mapping utility files into a single `MappingDomain` module.

### Phase 4: Workflow Engine (Long Term)
1.  **Generic Engine:** Design a JSON-driven workflow engine to replace `workflowAEngine.js` and `workflowBEngine.js`.
2.  **Externalized Prompts:** Move prompts from JS strings to a managed JSON/YAML structure to allow for non-code updates and testing.

---

## 5. Conclusion

The Decision Intelligence platform has a strong feature set and a capable "Canvas" UX pattern. However, technical debt in the form of **God Objects** and **Leaky Abstractions** poses a significant risk to stability and speed. Prioritizing the decoupling of the UI from the Database (Phase 1) is the single highest-impact action the team can take immediately.
