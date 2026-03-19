# Batch 5 Findings: Chat Components & UI Shell

**Scope:** `src/components/chat/**`
**Date:** 2026-03-18
**Reviewer:** Cascade

## Executive Summary
This batch covers the primary user interface for the AI Employee: the chat shell, message thread, composer, and the visualization "Canvas". It includes a rich set of interactive "Cards" that render specific artifacts (Plans, Risks, Negotiations).
**Critical Risks:**
1.  **God Component (`CanvasPanel.jsx`):** This component is ~900 lines long and handles tabs, log rendering, code viewing, charting (Recharts), and export logic. It is a maintenance bottleneck and hard to test.
2.  **Hardcoded Coupling:** `ChatComposer.jsx` defines slash commands that duplicate logic found in the backend intent system. `DataTab.jsx` relies on a `TABLE_REGISTRY` imported from services, tightly coupling UI to data implementation.
3.  **Performance Risk:** `ChatThread.jsx` and `AgentExecutionPanel.jsx` rely on potentially heavy renders for long history/execution logs without virtualization (except generic browser scrolling).

## Correctness & Reliability Findings (P0/P1)

### [P1] Missing Error Boundaries
*   **Context:** `ChatThread.jsx` renders dynamic content via `ChatMessageBubble` and various Cards.
*   **Impact:** If a single artifact card fails to render (e.g., malformed payload), the entire chat thread could crash (React white screen).
*   **Fix:** Wrap `renderSpecialMessage` or individual Card renderers in an `<ErrorBoundary>` component.

### [P2] Hardcoded Slash Commands
*   **File:** `src/components/chat/ChatComposer.jsx`:11
*   **Impact:** The `SLASH_COMMANDS` list is hardcoded in the frontend. If the backend adds or changes capabilities (e.g., new workflow), the frontend is immediately out of date.
*   **Fix:** Fetch available commands from a backend capability endpoint (e.g., `aiEmployee/capabilities`) or the `toolRegistryService`.

## Maintainability & Code Quality (P2/P3)

### [P2] God Component: `CanvasPanel.jsx`
*   **File:** `src/components/chat/CanvasPanel.jsx`
*   **Impact:** Combines layout, state management, complex chart rendering (Recharts), and export logic.
*   **Fix:** Extract sub-components:
    *   `CanvasCharts.jsx`: Encapsulate Recharts logic.
    *   `CanvasLogs.jsx`: Encapsulate log rendering.
    *   `CanvasCode.jsx`: Encapsulate code view.
    *   `CanvasTopology.jsx`: (Already partly done with `TopologyTab`, but `CanvasPanel` still has logic).

### [P3] Prop Drilling in Chat Shell
*   **File:** `AIEmployeeChatShell.jsx` -> `ChatThread` -> `ChatMessageBubble` -> Cards.
*   **Impact:** Passing callbacks (`onRunPlan`, `onApprove`, etc.) down 4+ levels makes refactoring painful.
*   **Fix:** Use a React Context (`ChatActionContext`) to provide action handlers to deep components without prop drilling.

### [P3] Redundant Sidebar Logic
*   **Files:** `ConversationSidebar.jsx` and `AIEmployeeConversationSidebar.jsx`
*   **Impact:** Significant duplication between the "legacy" sidebar and the "AI Employee" sidebar.
*   **Fix:** Merge into a single `Sidebar` component with a `variant` prop, or extract shared logic (list items, skeletons, search) into sub-components.

## UX & Simplification Recommendations

1.  **Unified Artifact Rendering:**
    *   Instead of `renderSpecialMessage` switch statements scattered in `ChatThread` or `ChatMessageBubble`, use a `<ArtifactRenderer type={msg.type} payload={msg.payload} />` that dynamically loads the correct Card. This makes adding new artifacts O(1) change.

2.  **Virtualization for Execution Panel:**
    *   `AgentExecutionPanel.jsx` renders execution steps. For long-running agents (e.g., Ralph Loop with 100+ steps), this will become sluggish. Implement `react-window` or similar list virtualization.

## Batch Summary
The chat UI is feature-rich but becoming monolithic. The Card pattern is excellent for modularity, but the container components (`CanvasPanel`, `ChatShell`) are accumulating too much responsibility. Breaking down `CanvasPanel` is the highest priority refactor here.
