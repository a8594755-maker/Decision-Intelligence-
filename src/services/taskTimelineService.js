/**
 * taskTimelineService.js — Canonical Task Timeline (Audit / Replay)
 *
 * Builds a single-source-of-truth timeline for any task by aggregating events
 * from all lifecycle phases:
 *
 *   1. Intake trace       — how the task was created (chat, alert, schedule, etc.)
 *   2. Planning trace     — decomposition decisions, step plan, template selection
 *   3. Approval trace     — approval requests, decisions, escalations
 *   4. Execution trace    — step start/complete/fail/retry, artifacts produced
 *   5. Review trace       — AI review scores, manager feedback, revisions
 *   6. Delivery trace     — final output, KPIs, memory written
 *
 * Each timeline entry has:
 *   { phase, event_type, timestamp, actor, detail, metadata }
 *
 * Usage:
 *   const timeline = await buildTaskTimeline(taskId);
 *   const completeness = computeReplayCompleteness(timeline);
 */

import { supabase } from './supabaseClient';

// ── Timeline Phases ─────────────────────────────────────────────────────────

export const TIMELINE_PHASE = {
  INTAKE:     'intake',
  PLANNING:   'planning',
  APPROVAL:   'approval',
  EXECUTION:  'execution',
  REVIEW:     'review',
  DELIVERY:   'delivery',
};

// ── Event Types ─────────────────────────────────────────────────────────────

export const TIMELINE_EVENT = {
  // Intake
  TASK_CREATED:        'task_created',
  INTAKE_NORMALIZED:   'intake_normalized',
  DEDUP_CHECKED:       'dedup_checked',

  // Planning
  PLAN_GENERATED:      'plan_generated',
  PLAN_SUBMITTED:      'plan_submitted',
  STEPS_CREATED:       'steps_created',

  // Approval
  APPROVAL_REQUESTED:  'approval_requested',
  APPROVAL_DECIDED:    'approval_decided',
  APPROVAL_ESCALATED:  'approval_escalated',
  APPROVAL_EXPIRED:    'approval_expired',

  // Execution
  STEP_STARTED:        'step_started',
  STEP_COMPLETED:      'step_completed',
  STEP_FAILED:         'step_failed',
  STEP_RETRIED:        'step_retried',
  STEP_SKIPPED:        'step_skipped',
  ARTIFACT_PRODUCED:   'artifact_produced',

  // Review
  AI_REVIEW_SCORED:    'ai_review_scored',
  MANAGER_REVIEWED:    'manager_reviewed',
  REVISION_REQUESTED:  'revision_requested',

  // Delivery
  TASK_COMPLETED:      'task_completed',
  TASK_FAILED:         'task_failed',
  MEMORY_WRITTEN:      'memory_written',
  KPI_SNAPSHOT:        'kpi_snapshot',
};

// ── Required Phases for Completeness ────────────────────────────────────────

const REQUIRED_EVENTS = [
  TIMELINE_EVENT.TASK_CREATED,
  TIMELINE_EVENT.PLAN_GENERATED,
  TIMELINE_EVENT.STEPS_CREATED,
];

const COMPLETION_EVENTS = [
  TIMELINE_EVENT.TASK_COMPLETED,
  TIMELINE_EVENT.TASK_FAILED,
];

// ── Build Timeline ──────────────────────────────────────────────────────────

/**
 * Build the canonical timeline for a task by querying all relevant tables.
 *
 * @param {string} taskId
 * @returns {Promise<Object[]>} Sorted timeline entries
 */
export async function buildTaskTimeline(taskId) {
  const timeline = [];

  // Fetch all sources in parallel
  const [taskResult, stepsResult, reviewsResult, worklogsResult, approvalsResult, memoryResult, aiReviewsResult] =
    await Promise.allSettled([
      fetchTask(taskId),
      fetchSteps(taskId),
      fetchReviews(taskId),
      fetchWorklogs(taskId),
      fetchApprovals(taskId),
      fetchMemory(taskId),
      fetchAIReviews(taskId),
    ]);

  // 1. Task lifecycle events
  const task = taskResult.status === 'fulfilled' ? taskResult.value : null;
  if (task) {
    timeline.push(entry(TIMELINE_PHASE.INTAKE, TIMELINE_EVENT.TASK_CREATED, task.created_at, 'system', {
      title: task.title,
      status: task.status,
      source: task.input_context?.source || 'chat',
      priority: task.input_context?.priority || 'medium',
    }));

    if (task.input_context) {
      timeline.push(entry(TIMELINE_PHASE.INTAKE, TIMELINE_EVENT.INTAKE_NORMALIZED, task.created_at, 'system', {
        source: task.input_context.source || 'chat',
        alert_id: task.input_context.alert_id,
        schedule_id: task.input_context.schedule_id,
      }));
    }

    // Plan generation (from task metadata)
    if (task.plan_snapshot || task.status !== 'draft_plan') {
      const planTs = task.approved_at || task.created_at;
      timeline.push(entry(TIMELINE_PHASE.PLANNING, TIMELINE_EVENT.PLAN_GENERATED, planTs, 'ai', {
        step_count: task.plan_snapshot?.steps?.length || 0,
        workflow_types: task.plan_snapshot?.steps?.map(s => s.tool_type).filter(Boolean) || [],
      }));
    }

    // Task completion
    if (task.status === 'done' && task.completed_at) {
      timeline.push(entry(TIMELINE_PHASE.DELIVERY, TIMELINE_EVENT.TASK_COMPLETED, task.completed_at, 'system', {
        duration_ms: new Date(task.completed_at) - new Date(task.created_at),
      }));
    } else if (task.status === 'failed') {
      timeline.push(entry(TIMELINE_PHASE.DELIVERY, TIMELINE_EVENT.TASK_FAILED, task.updated_at || task.created_at, 'system', {
        error: task.error_message,
      }));
    }
  }

  // 2. Step execution events
  const steps = stepsResult.status === 'fulfilled' ? stepsResult.value : [];
  for (const step of steps) {
    if (step.step_index === 0 && steps.length > 0) {
      timeline.push(entry(TIMELINE_PHASE.PLANNING, TIMELINE_EVENT.STEPS_CREATED, step.created_at || task?.created_at, 'system', {
        total_steps: steps.length,
      }));
    }

    if (step.started_at) {
      timeline.push(entry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_STARTED, step.started_at, 'ai', {
        step_index: step.step_index,
        step_name: step.step_name,
        tool_type: step.tool_type,
      }));
    }

    if (step.status === 'succeeded' && step.ended_at) {
      timeline.push(entry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_COMPLETED, step.ended_at, 'ai', {
        step_index: step.step_index,
        step_name: step.step_name,
        duration_ms: step.started_at ? new Date(step.ended_at) - new Date(step.started_at) : null,
        artifact_count: (step.artifact_refs || []).length,
      }));

      // Artifact events
      if (step.artifact_refs?.length > 0) {
        for (const ref of step.artifact_refs) {
          timeline.push(entry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.ARTIFACT_PRODUCED, step.ended_at, 'ai', {
            step_index: step.step_index,
            artifact_id: ref,
          }));
        }
      }
    }

    if (step.status === 'failed') {
      timeline.push(entry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_FAILED, step.ended_at || step.started_at, 'ai', {
        step_index: step.step_index,
        step_name: step.step_name,
        error: step.error_message,
        retry_count: step.retry_count,
      }));
    }

    if (step.status === 'retrying') {
      timeline.push(entry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_RETRIED, step.ended_at || step.started_at, 'ai', {
        step_index: step.step_index,
        retry_count: step.retry_count,
      }));
    }

    if (step.status === 'skipped') {
      timeline.push(entry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_SKIPPED, step.ended_at || step.started_at, 'ai', {
        step_index: step.step_index,
        step_name: step.step_name,
      }));
    }
  }

  // 3. Review events (human manager reviews)
  const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : [];
  for (const review of reviews) {
    timeline.push(entry(TIMELINE_PHASE.REVIEW, TIMELINE_EVENT.MANAGER_REVIEWED, review.created_at, 'manager', {
      decision: review.decision,
      feedback: review.feedback,
      review_id: review.id,
    }));

    if (review.decision === 'needs_revision') {
      timeline.push(entry(TIMELINE_PHASE.REVIEW, TIMELINE_EVENT.REVISION_REQUESTED, review.created_at, 'manager', {
        feedback: review.feedback,
      }));
    }
  }

  // 4. Worklog events (structured activity logs)
  const worklogs = worklogsResult.status === 'fulfilled' ? worklogsResult.value : [];
  for (const log of worklogs) {
    if (log.log_type === 'step_progress') {
      // Already captured from steps — skip to avoid duplication
      continue;
    }
    const phase = log.log_type === 'escalation' ? TIMELINE_PHASE.APPROVAL : TIMELINE_PHASE.EXECUTION;
    timeline.push(entry(phase, `worklog:${log.log_type}`, log.created_at, 'ai', {
      log_type: log.log_type,
      content: log.content,
    }));
  }

  // 5. Approval events
  const approvals = approvalsResult.status === 'fulfilled' ? approvalsResult.value : [];
  for (const approval of approvals) {
    timeline.push(entry(TIMELINE_PHASE.APPROVAL, TIMELINE_EVENT.APPROVAL_REQUESTED, approval.created_at, 'system', {
      approval_id: approval.id,
      type: approval.type,
      urgency: approval.urgency,
    }));

    if (approval.status === 'approved' || approval.status === 'rejected') {
      timeline.push(entry(TIMELINE_PHASE.APPROVAL, TIMELINE_EVENT.APPROVAL_DECIDED, approval.reviewed_at || approval.updated_at, approval.reviewer_id || 'manager', {
        approval_id: approval.id,
        decision: approval.status,
        comment: approval.review_comment,
      }));
    }

    if (approval.status === 'escalated') {
      timeline.push(entry(TIMELINE_PHASE.APPROVAL, TIMELINE_EVENT.APPROVAL_ESCALATED, approval.updated_at, 'system', {
        approval_id: approval.id,
        reason: approval.metadata?.escalation_reason,
      }));
    }

    if (approval.status === 'expired') {
      timeline.push(entry(TIMELINE_PHASE.APPROVAL, TIMELINE_EVENT.APPROVAL_EXPIRED, approval.updated_at, 'system', {
        approval_id: approval.id,
      }));
    }
  }

  // 6. AI review events
  const aiReviews = aiReviewsResult.status === 'fulfilled' ? aiReviewsResult.value : [];
  for (const review of aiReviews) {
    timeline.push(entry(TIMELINE_PHASE.REVIEW, TIMELINE_EVENT.AI_REVIEW_SCORED, review.created_at, 'ai_reviewer', {
      step_name: review.step_name,
      score: review.score,
      passed: review.passed,
      threshold: review.threshold,
      revision_round: review.revision_round,
      categories: review.categories,
    }));
  }

  // 7. Memory events
  const memory = memoryResult.status === 'fulfilled' ? memoryResult.value : null;
  if (memory) {
    timeline.push(entry(TIMELINE_PHASE.DELIVERY, TIMELINE_EVENT.MEMORY_WRITTEN, memory.created_at, 'system', {
      success: memory.success,
      outcome_summary: memory.outcome_summary,
      workflow_type: memory.workflow_type,
    }));

    if (memory.outcome_kpis && Object.keys(memory.outcome_kpis).length > 0) {
      timeline.push(entry(TIMELINE_PHASE.DELIVERY, TIMELINE_EVENT.KPI_SNAPSHOT, memory.created_at, 'system', {
        kpis: memory.outcome_kpis,
      }));
    }
  }

  // Sort by timestamp
  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return timeline;
}

// ── Replay Completeness ─────────────────────────────────────────────────────

/**
 * Compute replay completeness score for a task timeline.
 *
 * Checks that all expected lifecycle phases have entries.
 *
 * @param {Object[]} timeline - Output from buildTaskTimeline()
 * @returns {{ score: number, missing: string[], phases: Record<string, number> }}
 */
export function computeReplayCompleteness(timeline) {
  const eventTypes = new Set(timeline.map(e => e.event_type));

  // Check required events
  const missingRequired = REQUIRED_EVENTS.filter(e => !eventTypes.has(e));

  // Check completion events (at least one)
  const hasCompletion = COMPLETION_EVENTS.some(e => eventTypes.has(e));
  if (!hasCompletion && timeline.length > 0) {
    missingRequired.push('completion_event (task_completed or task_failed)');
  }

  // Phase coverage
  const phases = {};
  for (const phase of Object.values(TIMELINE_PHASE)) {
    phases[phase] = timeline.filter(e => e.phase === phase).length;
  }

  // Score: ratio of present phases with events
  const totalPhases = Object.keys(TIMELINE_PHASE).length;
  const coveredPhases = Object.values(phases).filter(count => count > 0).length;
  const requiredScore = (REQUIRED_EVENTS.length - missingRequired.length) / REQUIRED_EVENTS.length;
  const phaseScore = coveredPhases / totalPhases;

  const score = Math.round(((requiredScore * 0.6) + (phaseScore * 0.4)) * 100);

  return { score, missing: missingRequired, phases };
}

// ── Timeline Summary ────────────────────────────────────────────────────────

/**
 * Generate a human-readable summary from a timeline.
 *
 * @param {Object[]} timeline
 * @returns {{ total_events, duration_ms, phases, key_decisions, artifacts_produced }}
 */
export function summarizeTimeline(timeline) {
  if (timeline.length === 0) {
    return { total_events: 0, duration_ms: 0, phases: {}, key_decisions: [], artifacts_produced: 0 };
  }

  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  const durationMs = new Date(last.timestamp) - new Date(first.timestamp);

  const phases = {};
  for (const e of timeline) {
    phases[e.phase] = (phases[e.phase] || 0) + 1;
  }

  const keyDecisions = timeline
    .filter(e => [
      TIMELINE_EVENT.APPROVAL_DECIDED,
      TIMELINE_EVENT.MANAGER_REVIEWED,
      TIMELINE_EVENT.REVISION_REQUESTED,
    ].includes(e.event_type))
    .map(e => ({
      event: e.event_type,
      timestamp: e.timestamp,
      actor: e.actor,
      detail: e.detail,
    }));

  const artifactsProduced = timeline.filter(e => e.event_type === TIMELINE_EVENT.ARTIFACT_PRODUCED).length;

  return {
    total_events: timeline.length,
    duration_ms: durationMs,
    phases,
    key_decisions: keyDecisions,
    artifacts_produced: artifactsProduced,
  };
}

// ── Data Fetchers ───────────────────────────────────────────────────────────

async function fetchTask(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .select('*')
    .eq('id', taskId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchSteps(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_runs')
    .select('*')
    .eq('task_id', taskId)
    .not('step_index', 'is', null)
    .order('step_index', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchReviews(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_reviews')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchWorklogs(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_worklogs')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchApprovals(taskId) {
  const { data, error } = await supabase
    .from('di_approval_requests')
    .select('*')
    .contains('metadata', { task_id: taskId })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchMemory(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_task_memory')
    .select('*')
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchAIReviews(taskId) {
  const { data, error } = await supabase
    .from('ai_review_results')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function entry(phase, eventType, timestamp, actor, detail = {}) {
  return {
    phase,
    event_type: eventType,
    timestamp: timestamp || new Date().toISOString(),
    actor,
    detail,
  };
}
