# Digital Worker v1 — Operations Runbook

## Deployment

### Pre-deploy checklist
- [ ] `npm run ci` passes (lint + tests + dw-gate + build)
- [ ] Supabase migrations applied: `20260313_ai_employee_core.sql`, `20260315_agent_loop_steps.sql`, `20260321_phase4_dynamic_tools.sql`, `20260325_style_learning_pipeline.sql`, `20260329_capability_model.sql`
- [ ] Edge function `ai-proxy` deployed and healthy
- [ ] Environment variables set: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

### Rollback
1. Revert frontend deploy to previous version
2. Supabase migrations are additive — no rollback needed for schema
3. If capability_policies or worker_templates data is corrupted, re-run seed SQL from migration

## Task Lifecycle

### State machine: task
```
draft_plan → waiting_approval → queued → in_progress → review_hold → done
                                  │         │              │
                                  └→ failed  └→ blocked     └→ failed
                                  └→ cancelled
```

### State machine: step
```
pending → running → succeeded
                 → failed → retrying → succeeded | failed
                 → skipped
pending → waiting_input → pending
```

### State machine: employee
```
idle → busy → review_needed → idle
           → error → idle
```

## Queue / Retry / Resume

### Retry behavior
- Max 3 retries per step (configurable via capability_policies.max_retry)
- Self-healing: on failure, orchestrator calls `analyzeStepFailure()` → tries alternative model or approach
- Model escalation: tier_a → tier_b → tier_c on repeated failures

### Resume after crash
- Tasks in `in_progress` state can be resumed by calling `approvePlan(taskId, userId)`
- Orchestrator picks up from the first `pending` step
- Steps in `running` state at crash time are treated as failed and retried

### Manual intervention
- Block a task: update `ai_employee_tasks.status = 'blocked'`
- Cancel a task: `orchestratorCancel(taskId, userId)` or update status to `cancelled`
- Force-complete: update status to `done` (use sparingly — skips review)

## Monitoring

### Health check endpoints
- Supabase: `${VITE_SUPABASE_URL}/rest/v1/` (200 = healthy)
- Edge function: `${VITE_SUPABASE_URL}/functions/v1/ai-proxy` (check with OPTIONS)

### Key metrics to watch
- Task completion rate: `SELECT status, COUNT(*) FROM ai_employee_tasks GROUP BY status`
- Average task duration: `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) FROM ai_employee_tasks WHERE status = 'done'`
- Step failure rate: `SELECT COUNT(*) FILTER (WHERE status = 'failed') * 100.0 / COUNT(*) FROM ai_employee_runs`
- Review first-pass rate: `SELECT AVG(first_pass_rate) FROM style_trust_metrics`

### SLO targets (v1)
- Task completion within SLA: > 80%
- Step first-pass success: > 70%
- Orchestrator availability: > 99%

### Alerting
- Task stuck in `in_progress` > 30 minutes without step progress → investigate
- Task stuck in `queued` > 5 minutes → orchestrator may be down
- Employee stuck in `busy` > 1 hour → possible orphaned execution

## Audit / Replay

### Trace completeness check
```sql
SELECT t.id, t.title, t.status,
  (SELECT COUNT(*) FROM ai_employee_worklogs w WHERE w.task_id = t.id) as worklog_count,
  (SELECT COUNT(*) FROM ai_employee_runs r WHERE r.task_id = t.id) as step_count
FROM ai_employee_tasks t
WHERE t.created_at > NOW() - INTERVAL '7 days'
ORDER BY t.created_at DESC;
```

### Replay a task timeline
Use `buildTaskTimeline(taskId)` from `taskTimelineService.js`. This aggregates:
1. Intake trace (task creation, source, priority)
2. Planning trace (step plan, template selection)
3. Approval trace (approval requests, decisions)
4. Execution trace (step start/complete/fail/retry, artifacts)
5. Review trace (AI review scores, manager feedback)
6. Delivery trace (completion, KPIs, memory)

### Completeness score
Use `computeReplayCompleteness(timeline)` — returns score 0-100 and list of missing events.
Required events: `task_created`, `plan_generated`, `steps_created`, plus at least one completion event.

## Intake Sources

| Source | Entry point | Intake service | Notes |
|--------|------------|----------------|-------|
| Chat/manual | DSV index.jsx | processIntake(CHAT) | Via work order draft |
| /assignTask | DSV intent handler | processIntake(CHAT) | Via intent routing |
| Email | /email command | processEmailIntake() | Parses subject, sender |
| Transcript | /transcript command | processTranscriptIntake() | Parses speakers, actions |
| Scheduled | scheduledTaskService | processIntake(SCHEDULE) | Cron-based |
| Proactive alert | proactiveTaskGenerator | processIntake(PROACTIVE_ALERT) | Alert-driven |

## Design Partner Acceptance Criteria

### 3 core scenarios that must be stable
1. **Chat → forecast + plan**: User types "Run demand forecast and create replenishment plan" → work order → decompose → 2+ steps → execute → review → approve
2. **Alert → auto-task**: Stockout risk alert → auto-create task → execute → AI review → manager review
3. **Scheduled report**: Weekly schedule fires → create task → execute → deliver artifacts

### Acceptance evidence
- [ ] Manager can view task in EmployeeTasksPage kanban
- [ ] Manager can approve/revise/reject in EmployeeReviewPage
- [ ] Replay trace is complete (score > 80) for all 3 scenarios
- [ ] Autonomy level (A1-A4) reflects actual trust metrics
- [ ] Style learning: revision feedback → extracted rules → applied in next execution
