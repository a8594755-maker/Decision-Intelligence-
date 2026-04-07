# Digital Workforce — Interface Contract

> For team collaboration. Groupmate reads this, builds against these interfaces.
> **Last updated:** 2026-04-07

---

## 1. Task State Machine

14 states, deterministic transitions. This is the single source of truth.

```
draft_plan ──PLAN_READY──▸ waiting_approval ──APPROVE──▸ queued ──START──▸ in_progress
                                                                         │
                          ┌──────────────────────────────────────────────┘
                          │
                          ├─ STEP_COMPLETED ──▸ in_progress (loop)
                          ├─ ALL_STEPS_DONE ──▸ done ✓
                          ├─ REVIEW_NEEDED  ──▸ review_hold ──REVIEW_APPROVED──▸ in_progress
                          │                                 ──REVIEW_REJECTED──▸ failed
                          ├─ BLOCK ──▸ blocked ──UNBLOCK──▸ in_progress
                          ├─ NEED_CLARIFICATION ──▸ needs_clarification ──CLARIFICATION_RECEIVED──▸ in_progress
                          ├─ PUBLISH_FAIL ──▸ publish_failed ──RETRY──▸ in_progress
                          ├─ EXTERNAL_BLOCK ──▸ blocked_external_dependency ──EXTERNAL_RESOLVED──▸ in_progress
                          └─ FAIL ──▸ failed ──RETRY──▸ queued

Terminal: done, failed, cancelled
Any non-terminal state + CANCEL ──▸ cancelled
```

### Step States (8)

```
pending ──START──▸ running ──SUCCEED──▸ succeeded ✓
                           ──FAIL────▸ failed ──RETRY──▸ retrying ──START──▸ running
pending ──NEED_INPUT──▸ waiting_input ──INPUT_RECEIVED──▸ pending
pending ──HOLD──▸ review_hold ──REVIEW_APPROVED──▸ pending
Any non-terminal ──SKIP──▸ skipped ✓
```

### Employee States (4)

```
idle ──TASK_STARTED──▸ busy ──TASK_DONE──▸ idle
                            ──REVIEW_NEEDED──▸ review_needed ──REVIEW_RESOLVED──▸ busy
                            ──ERROR──▸ error ──RECOVER──▸ idle

DB mapping: idle→idle, busy→working, review_needed→waiting_review, error→blocked
```

---

## 2. Supabase Tables

### `ai_employees`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name | text | NOT NULL |
| role | text | `data_analyst`, `supply_chain_analyst`, `procurement_specialist`, `operations_coordinator` |
| status | text | `idle`, `working`, `blocked`, `waiting_review` |
| manager_user_id | uuid FK | → auth.users |
| description | text | |
| permissions | jsonb | `{can_run_forecast, can_run_plan, ...}` |
| archived_at | timestamptz | soft delete |

### `ai_employee_tasks`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| employee_id | uuid FK | → ai_employees, CASCADE |
| title | text | NOT NULL |
| description | text | |
| priority | text | `low`, `medium`, `high`, `urgent` |
| status | text | see state machine above |
| source_type | text | `manual`, `scheduled`, `question_to_task`, `chat_decomposed` |
| assigned_by_user_id | uuid FK | |
| due_at | timestamptz | |
| input_context | jsonb | `{inputData, llmConfig, dataset_profile_id, ...}` |
| plan_snapshot | jsonb | frozen at approval time |
| version | integer | **optimistic concurrency — always pass expected version** |
| worker_id | text | server execution claim |
| worker_heartbeat_at | timestamptz | stale after 60s |

### `ai_employee_runs` (steps)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| task_id | uuid FK | |
| employee_id | uuid FK | |
| step_index | smallint | null = not a step |
| step_name | text | e.g. `fetch_data`, `analyze_trends` |
| tool_type | text | `python_tool`, `builtin_tool`, `llm_call`, `excel`, `report` |
| status | text | `pending`, `running`, `succeeded`, `failed`, `retrying`, `skipped`, `needs_review` |
| artifact_refs | uuid[] | → di_artifacts |
| summary | text | |
| error_message | text | |
| retry_count / max_retries | smallint | default 0 / 3 |

### `ai_employee_reviews`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| task_id | uuid FK | |
| run_id | uuid FK | nullable |
| reviewer_type | text | `human_manager`, `ai_reviewer` |
| decision | text | `approved`, `needs_revision`, `rejected` |
| comments | text | |
| created_by | uuid FK | |

### `ai_employee_worklogs`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| employee_id | uuid FK | |
| task_id | uuid FK | nullable |
| log_type | text | `task_update`, `daily_summary`, `escalation`, `retrospective`, `step_progress`, `task_lifecycle` |
| content | jsonb | |

### `worker_templates`
| Column | Type | Notes |
|--------|------|-------|
| id | text PK | `data_analyst`, `supply_chain_analyst`, etc. |
| name | text | |
| allowed_capabilities | text[] | |
| default_autonomy | text | `A0`–`A4` |
| max_autonomy | text | |
| is_active | boolean | |

### `capability_policies`
| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| capability_class | text | `planning`, `analysis`, `reporting`, `synthesis`, `custom_code`, `integration`, `negotiation`, `monitoring` |
| approval_required | boolean | |
| min_autonomy_level | text | |
| auto_approve_at | text | autonomy level that skips approval |
| review_required | boolean | |
| budget_tier | text | `tier_a`, `tier_b`, `tier_c` |

---

## 3. Public API — Functions to Call

All in `src/services/aiEmployee/`. All async.

### Task Lifecycle (orchestrator.js)

```js
// Create + queue a task
submitPlan(plan, employeeId, userId)
// → returns {taskId, task, autoApproved?, autonomyLevel?}
// plan shape: {title, description, steps[], inputData, llmConfig, priority?}

// Manager approves → queued → starts execution
approvePlan(taskId, userId)

// Cancel any non-terminal task
cancelTask(taskId, userId)

// Retry a failed task → re-queued
retryTask(taskId, userId)
```

### Review (orchestrator.js)

```js
// Approve or reject a review_hold task
approveReview(taskId, userId, {feedback?, decision?, revision?})
// decision: 'approve' | 'needs_revision' | 'rejected'

// Provide data to a waiting_input step
provideStepInput(taskId, {datasetProfileId, datasetProfileRow}, userId)

// Skip a waiting_input step
skipWaitingInputStep(taskId, userId)
```

### Queries (queries.js)

```js
// Workers
getOrCreateWorker(userId, templateId = 'data_analyst')
listEmployeesByManager(userId)
getKpis(employeeId)

// Tasks
listTasksByUser(userId, opts)       // all tasks for a manager
listTasks(employeeId, opts)          // tasks for one worker
getTaskStatus(taskId)                // task + enriched steps

// Reviews
listPendingReviews(userId)           // tasks in review_hold, enriched with artifacts

// Templates
listTemplates()                      // DB + hardcoded merged
```

---

## 4. Happy Path — End-to-End Flow

This is the flow that needs to work for demo:

```
Step 1: Create worker
  → getOrCreateWorker(userId, 'data_analyst')
  → returns employee {id, name, status: 'idle'}

Step 2: Submit task
  → submitPlan({
      title: 'Analyze Q1 Sales',
      description: 'Run KPI analysis on uploaded dataset',
      steps: [
        {name: 'clean_data', tool_type: 'builtin_tool'},
        {name: 'calculate_kpis', tool_type: 'builtin_tool'},
        {name: 'detect_anomalies', tool_type: 'builtin_tool'},
        {name: 'synthesize_report', tool_type: 'builtin_tool'}
      ],
      inputData: {dataset_profile_id: '...'},
      llmConfig: {model: 'deepseek-chat'}
    }, employeeId, userId)
  → task created in draft_plan → auto-transitions to waiting_approval
  → if autonomy >= A3: auto-approved → queued

Step 3: Approve (if not auto-approved)
  → approvePlan(taskId, userId)
  → task: waiting_approval → queued

Step 4: Execution (automatic)
  → tick(taskId) called in loop
  → each step: pending → running → succeeded
  → if step needs review: task → review_hold

Step 5: Review (if review_hold)
  → listPendingReviews(userId)  // shows this task
  → approveReview(taskId, userId, {decision: 'approve'})
  → task resumes: review_hold → in_progress

Step 6: Complete
  → all steps succeeded → task: in_progress → done
  → employee: busy → idle
```

---

## 5. Key Design Rules

| Rule | Detail |
|------|--------|
| **Optimistic concurrency** | Always pass `version` on state updates. Mismatch = concurrent modification error. |
| **Autonomy levels** | A0 < A1 < A2 < A3 < A4. A3+ can auto-approve plans. |
| **Artifact chaining** | Steps produce `artifact_refs: uuid[]`. Downstream steps can read these. |
| **Soft delete** | Workers use `archived_at`, never hard delete. |
| **RLS** | All tables have row-level security. Queries must include `manager_user_id` or `assigned_by_user_id`. |
| **Heartbeat** | Server execution: heartbeat every 15-30s, stale after 60s → reclaimable. |

---

## 6. What Groupmate Should NOT Touch

| File / Area | Reason |
|-------------|--------|
| `src/ml/api/*` | Python backend — actively being modified |
| `orchestrator.js` core state machine | Complex, tightly coupled |
| `ai-proxy` edge function | LLM routing — sensitive |
| DB schema changes | Coordinate first |

---

## 7. What Groupmate CAN Independently Do

1. **Wire up the happy path** — make Step 1-6 above actually work in the UI
2. **Fix UI bugs** in `src/pages/WorkersHub.jsx` and sub-pages
3. **Add loading/empty/error states** to all pages
4. **Create seed data script** — so `/employees` isn't empty on first load
5. **Write integration tests** — call orchestrator functions, verify state transitions
6. **Build Report Viewer** — render synthesis markdown output as styled UI
