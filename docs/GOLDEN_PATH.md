# Golden Path — v1 Primary User Flow

This document defines the single canonical end-to-end flow for Decision Intelligence v1. All product entry points converge to this path.

## The 6 Steps

| Step | Action | Route | Component |
| --- | --- | --- | --- |
| 1. Upload Workbook | User uploads Excel/CSV workbook into the workspace canvas | `/workspace` | `WorkspacePage` → `UnifiedWorkspaceLayout` → `DecisionSupportView` |
| 2. Worker Picks Up Task | Digital worker receives the task via intake pipeline | `/employees/tasks` | `EmployeeTasksPage` (task board) |
| 3. Forecast + Plan + Risk | Workflow A or B executes: profile → forecast → plan → risk → verify → topology → report | `/workspace` | `useWorkflowExecutor` drives `workflowAEngine` / `workflowBEngine` |
| 4. Revise | Manager reviews worker output, requests revisions if needed | `/employees/review` | `EmployeeReviewPage` (review center + audit timeline) |
| 5. Approve | Approval gate: manager approves the plan for writeback | `/employees/approvals` | `ApprovalQueuePage` (standalone approval manager) |
| 6. Replay / Audit | Replay the run with cached artifacts or audit the full decision trail | `/employees/review` | `EmployeeReviewPage` → `AuditTimelineCard` |

## Route Convergence

| Old Route | Redirects To | Reason |
| --- | --- | --- |
| `/plan` | `/workspace` | Plan Studio merged into unified workspace canvas |
| `/chat` | `/workspace` | Chat is embedded in workspace, not a standalone route |
| `/ai/decision` | `/workspace` | Legacy path |

## Entry Points

- **DI Mode**: Sidebar "Workspace" is the first nav item → `/workspace`
- **AI Mode**: "Task Board" is the first nav item → `/employees/tasks`
- **Command Center**: "Plan" CTA button → `/workspace`

## Key Invariants

1. `/workspace` is the only route where workbook upload and workflow execution happen.
2. All planning, forecasting, risk, and scenario work flows through `/workspace` with query params (`?widget=forecast`, `?widget=risk`, etc.).
3. The digital worker task lifecycle lives under `/employees/*`.
4. No standalone `/chat` route exists — chat is a panel within `/workspace`.
