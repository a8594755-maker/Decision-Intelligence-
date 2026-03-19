# Batch 10 Findings: Workflows, Prompts & Entrypoints

**Scope:** `src/workflows/**`, `src/prompts/**`, `src/router.jsx`, `src/main.jsx`, `src/layouts/AppShell.jsx`
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
This final batch covers the "Brain" (Workflows/Prompts) and the "Skeleton" (Entrypoints/Router) of the application. The workflow engines are the most complex part of the backend-for-frontend logic, orchestrating services into coherent business processes. The prompt engineering is centralized but static.
**Critical Risks:**
1.  **Workflow Coupling:** `workflowAEngine.js` and `workflowBEngine.js` are massive files (>1000 lines) that import almost every service in the application. They are "God Objects" for business process logic.
2.  **Prompt Management:** Prompts in `src/prompts/` are hardcoded JavaScript strings. Modifying a prompt requires a code deployment. Testing prompt performance (evals) is hard without externalizing them.
3.  **Hardcoded Workflow Steps:** The steps (`profile`, `contract`, `validate`...) are hardcoded arrays. Changing the workflow structure requires significant code changes in the engine.

## Correctness & Reliability Findings (P0/P1)

### [P1] Infinite Loop Potential in Workflows
*   **File:** `src/workflows/workflowAEngine.js` (and B)
*   **Context:** `processWorkflowRun` loops up to `maxIterations = 24`.
*   **Risk:** If a step fails in a way that doesn't trigger a terminal status (e.g., repeatedly returns `progressed_step: null` but `status: running`), it could consume the budget or hang the UI.
*   **Fix:** Ensure every step handler guarantees a state transition or a terminal error. Add a "stuck detection" mechanism.

### [P2] Prompt Injection / Fragility
*   **File:** `src/prompts/diJsonContracts.js`
*   **Risk:** Large prompts with interpolated variables (`${compact}`). If user input (column names, values) contains special characters or prompt-injection-like patterns, it could break the strict JSON contract.
*   **Fix:** Use proper escaping for interpolated variables or switch to an LLM provider that supports "System Messages" vs "User Messages" more strictly (most do, but the prompt builder concatenates them).

## Maintainability & Code Quality (P2/P3)

### [P2] "God Engine" Pattern
*   **File:** `src/workflows/workflowAEngine.js`
*   **Observation:** Handles State Machine, Persistence, Artifact Loading, Error Recovery, and UI Card generation.
*   **Fix:** Split into:
    *   `WorkflowStateService.js`: Manages persistence/transitions.
    *   `WorkflowASteps.js`: Pure functions for each step logic.
    *   `WorkflowCardFactory.js`: Generates UI payloads.

### [P3] Router Complexity
*   **File:** `src/router.jsx`
*   **Observation:** Contains legacy redirects (`ai/decision` -> `plan`).
*   **Action:** Clean up dead routes to reduce bundle size and confusion.

## Architecture & Simplification

1.  **Workflow Engine:**
    *   Current: Ad-hoc async engines for A and B.
    *   Target: A generic `WorkflowEngine` class that takes a `WorkflowDefinition` (JSON/Object) defining steps and transitions.

2.  **Prompt Registry:**
    *   Move prompts to a CMS or at least JSON files that can be versioned independently of code.

## Batch Summary
The application's "Brain" is functional but monolithic. The workflows work well for the current defined processes but will be hard to extend (e.g., adding "Workflow C") without copy-pasting the engine. The entrypoints (`main.jsx`, `router.jsx`) are clean and modern.
