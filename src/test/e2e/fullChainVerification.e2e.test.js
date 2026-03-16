// @product: ai-employee
//
// E2E verification: 3 formal full-chain tests for Digital Worker v1.
//
// Chain 1: chat/manual → intake → plan → execute → review → approve
// Chain 2: email/transcript → intake → work order → execute → review
// Chain 3: scheduled/proactive → auto task → review/escalation → replay
//
// Each chain proves: task has trace, step has artifact, review can revise/approve,
// replay completeness computable, failure can retry/resume.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Supabase ──────────────────────────────────────────────────────────

const _mockStore = { tasks: [], steps: [], worklogs: [], reviews: [] };

vi.mock('../../services/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), data: [], error: null }),
          is: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          maybeSingle: async () => ({ data: null, error: null }),
          order: () => ({ limit: () => ({ data: [], error: null }), data: [], error: null }),
          data: [],
          error: null,
        }),
        data: [],
        error: null,
      }),
      insert: (row) => ({ data: Array.isArray(row) ? row : [row], error: null, select: () => ({ single: async () => ({ data: { id: `mock_${Date.now()}`, ...row }, error: null }) }) }),
      update: (row) => ({ eq: () => ({ data: [row], error: null }) }),
      upsert: (row) => ({ data: Array.isArray(row) ? row : [row], error: null }),
    }),
  },
}));

// Polyfill localStorage
if (typeof globalThis.localStorage === 'undefined') {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

// ── Imports ────────────────────────────────────────────────────────────────

import { taskTransition, TASK_STATES, TASK_EVENTS, isTaskTerminal } from '../../services/aiEmployee/taskStateMachine.js';
import { stepTransition, STEP_STATES, STEP_EVENTS, isStepTerminal, isStepFailed } from '../../services/aiEmployee/stepStateMachine.js';
import { employeeTransition, EMPLOYEE_STATES, EMPLOYEE_EVENTS } from '../../services/aiEmployee/employeeStateMachine.js';
import { decomposeTask, validateDecomposition } from '../../services/chatTaskDecomposer';
import { buildDynamicTemplate, initDynamicLoopState } from '../../services/dynamicTemplateBuilder';
import { normalizeIntake, processIntake, INTAKE_SOURCES, checkDuplicate } from '../../services/taskIntakeService';
import { computeReplayCompleteness } from '../../services/taskTimelineService';
import { TIMELINE_EVENT, TIMELINE_PHASE } from '../../services/taskTimelineService';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTimelineEntry(phase, eventType, timestamp = new Date().toISOString(), actor = 'ai', detail = {}) {
  return { phase, event_type: eventType, timestamp, actor, detail, metadata: {} };
}

function simulateFullTaskLifecycle(steps, { withRetry = false, withReview = false } = {}) {
  const timeline = [];
  const now = new Date();
  let ts = (offset) => new Date(now.getTime() + offset * 1000).toISOString();

  // Intake
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.INTAKE, TIMELINE_EVENT.TASK_CREATED, ts(0), 'system', { title: 'Test task' }));
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.INTAKE, TIMELINE_EVENT.INTAKE_NORMALIZED, ts(1), 'system'));

  // Planning
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.PLANNING, TIMELINE_EVENT.PLAN_GENERATED, ts(2), 'ai', { step_count: steps.length }));
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.PLANNING, TIMELINE_EVENT.STEPS_CREATED, ts(3), 'system', { total_steps: steps.length }));

  // Approval
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.APPROVAL, TIMELINE_EVENT.APPROVAL_REQUESTED, ts(4), 'system'));
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.APPROVAL, TIMELINE_EVENT.APPROVAL_DECIDED, ts(5), 'manager', { decision: 'approved' }));

  // Execution
  let offset = 6;
  for (let i = 0; i < steps.length; i++) {
    timeline.push(makeTimelineEntry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_STARTED, ts(offset++), 'ai', {
      step_index: i, step_name: steps[i].name,
    }));

    if (withRetry && i === 0) {
      // First step fails, then retries successfully
      timeline.push(makeTimelineEntry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_FAILED, ts(offset++), 'ai', {
        step_index: i, error: 'Simulated failure',
      }));
      timeline.push(makeTimelineEntry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_RETRIED, ts(offset++), 'ai', {
        step_index: i, retry_count: 1,
      }));
      timeline.push(makeTimelineEntry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_STARTED, ts(offset++), 'ai', {
        step_index: i, step_name: steps[i].name,
      }));
    }

    timeline.push(makeTimelineEntry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.STEP_COMPLETED, ts(offset++), 'ai', {
      step_index: i, artifact_count: 1,
    }));
    timeline.push(makeTimelineEntry(TIMELINE_PHASE.EXECUTION, TIMELINE_EVENT.ARTIFACT_PRODUCED, ts(offset++), 'ai', {
      step_index: i, artifact_id: `artifact_${i}`,
    }));
  }

  // Review
  if (withReview) {
    timeline.push(makeTimelineEntry(TIMELINE_PHASE.REVIEW, TIMELINE_EVENT.AI_REVIEW_SCORED, ts(offset++), 'ai', { score: 0.85 }));
    timeline.push(makeTimelineEntry(TIMELINE_PHASE.REVIEW, TIMELINE_EVENT.MANAGER_REVIEWED, ts(offset++), 'manager', { outcome: 'approved' }));
  }

  // Delivery
  timeline.push(makeTimelineEntry(TIMELINE_PHASE.DELIVERY, TIMELINE_EVENT.TASK_COMPLETED, ts(offset++), 'system'));

  return timeline;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHAIN 1: chat/manual → intake → plan → execute → review → approve
// ═══════════════════════════════════════════════════════════════════════════

describe('Chain 1: chat → intake → plan → execute → review → approve', () => {

  it('intake normalization produces valid work order from chat message', () => {
    const workOrder = normalizeIntake({
      source: INTAKE_SOURCES.CHAT,
      message: 'Run urgent demand forecast for next quarter',
      employeeId: 'emp_001',
      userId: 'user_001',
    });

    expect(workOrder.id).toMatch(/^wo_/);
    expect(workOrder.source).toBe('chat');
    expect(workOrder.priority).toBe('critical'); // "urgent" keyword → critical
    expect(workOrder.sla).toBeDefined();
    expect(workOrder.sla.due_at).toBeDefined();
    expect(workOrder.title).toBeTruthy();
    expect(workOrder.dedup_key).toContain('chat');
    expect(workOrder.created_at).toBeTruthy();
  });

  it('task state machine transitions through complete lifecycle', () => {
    let state = TASK_STATES.DRAFT_PLAN;

    state = taskTransition(state, TASK_EVENTS.PLAN_READY);
    expect(state).toBe(TASK_STATES.WAITING_APPROVAL);

    state = taskTransition(state, TASK_EVENTS.APPROVE);
    expect(state).toBe(TASK_STATES.QUEUED);

    state = taskTransition(state, TASK_EVENTS.START);
    expect(state).toBe(TASK_STATES.IN_PROGRESS);

    state = taskTransition(state, TASK_EVENTS.STEP_COMPLETED);
    expect(state).toBe(TASK_STATES.IN_PROGRESS);

    state = taskTransition(state, TASK_EVENTS.REVIEW_NEEDED);
    expect(state).toBe(TASK_STATES.REVIEW_HOLD);

    // REVIEW_APPROVED returns to IN_PROGRESS (worker continues)
    state = taskTransition(state, TASK_EVENTS.REVIEW_APPROVED);
    expect(state).toBe(TASK_STATES.IN_PROGRESS);

    // ALL_STEPS_DONE completes the task
    state = taskTransition(state, TASK_EVENTS.ALL_STEPS_DONE);
    expect(state).toBe(TASK_STATES.DONE);

    expect(isTaskTerminal(state)).toBe(true);
  });

  it('step state machine handles success path', () => {
    let state = STEP_STATES.PENDING;

    state = stepTransition(state, STEP_EVENTS.START);
    expect(state).toBe(STEP_STATES.RUNNING);

    state = stepTransition(state, STEP_EVENTS.SUCCEED);
    expect(state).toBe(STEP_STATES.SUCCEEDED);

    expect(isStepTerminal(state)).toBe(true);
    expect(isStepFailed(state)).toBe(false);
  });

  it('employee state machine tracks busy → review_needed → idle cycle', () => {
    let state = EMPLOYEE_STATES.IDLE;

    state = employeeTransition(state, EMPLOYEE_EVENTS.TASK_STARTED);
    expect(state).toBe(EMPLOYEE_STATES.BUSY);

    state = employeeTransition(state, EMPLOYEE_EVENTS.REVIEW_NEEDED);
    expect(state).toBe(EMPLOYEE_STATES.REVIEW_NEEDED);

    state = employeeTransition(state, EMPLOYEE_EVENTS.TASK_DONE);
    expect(state).toBe(EMPLOYEE_STATES.IDLE);
  });

  it('full lifecycle produces computable replay completeness', () => {
    const steps = [{ name: 'forecast' }, { name: 'plan' }];
    const timeline = simulateFullTaskLifecycle(steps, { withReview: true });

    const completeness = computeReplayCompleteness(timeline);

    expect(completeness).toBeDefined();
    expect(completeness.score).toBeGreaterThanOrEqual(0);
    expect(completeness.score).toBeLessThanOrEqual(100);
    // Full lifecycle with review should have high completeness (score is 0-100)
    expect(completeness.score).toBeGreaterThan(50);
    expect(completeness.missing).toBeDefined();
    expect(completeness.phases).toBeDefined();
  });

  it('decomposeTask → buildTemplate → loopState → state machine integration', async () => {
    const decomposition = await decomposeTask({ userMessage: 'Run demand forecast and plan' });
    expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(2);

    const { valid } = validateDecomposition(decomposition);
    expect(valid).toBe(true);

    const template = buildDynamicTemplate(decomposition);
    const loopState = initDynamicLoopState(template);

    // Every step starts pending
    expect(loopState.steps.every(s => s.status === 'pending')).toBe(true);

    // Simulate step transitions using state machine
    for (const step of loopState.steps) {
      let ss = STEP_STATES.PENDING;
      ss = stepTransition(ss, STEP_EVENTS.START);
      expect(ss).toBe(STEP_STATES.RUNNING);
      ss = stepTransition(ss, STEP_EVENTS.SUCCEED);
      expect(ss).toBe(STEP_STATES.SUCCEEDED);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAIN 2: email/transcript → intake → work order → execute → review
// ═══════════════════════════════════════════════════════════════════════════

describe('Chain 2: email/transcript → intake → work order → execute → review', () => {

  it('email intake normalizes with subject and priority', () => {
    const workOrder = normalizeIntake({
      source: INTAKE_SOURCES.EMAIL,
      message: 'Please prepare the weekly inventory report ASAP',
      employeeId: 'emp_001',
      userId: 'user_001',
      metadata: {
        subject: 'Urgent: Weekly Inventory Report',
        sender: 'manager@example.com',
      },
    });

    expect(workOrder.source).toBe('email');
    expect(workOrder.title).toBe('Urgent: Weekly Inventory Report');
    expect(workOrder.priority).toBe('critical'); // ASAP → critical
    expect(workOrder.sla.due_at).toBeTruthy();
    expect(workOrder.context.sender).toBe('manager@example.com');
  });

  it('transcript intake normalizes with meeting title', () => {
    const workOrder = normalizeIntake({
      source: INTAKE_SOURCES.MEETING_TRANSCRIPT,
      message: 'Action item: run risk analysis on supplier ABC by Friday',
      employeeId: 'emp_001',
      userId: 'user_001',
      metadata: {
        meeting_title: 'Supply Chain Review Meeting',
        speakers: ['Alice', 'Bob'],
      },
    });

    expect(workOrder.source).toBe('meeting_transcript');
    expect(workOrder.title).toContain('Meeting');
    expect(workOrder.context.speakers).toEqual(['Alice', 'Bob']);
  });

  it('dedup check prevents duplicate work orders', async () => {
    // First intake
    const wo1 = normalizeIntake({
      source: INTAKE_SOURCES.CHAT,
      message: 'Run demand forecast',
      employeeId: 'emp_001',
      userId: 'user_001',
    });
    expect(wo1.dedup_key).toBeTruthy();

    // Second identical intake should produce same dedup key
    const wo2 = normalizeIntake({
      source: INTAKE_SOURCES.CHAT,
      message: 'Run demand forecast',
      employeeId: 'emp_001',
      userId: 'user_001',
    });
    expect(wo2.dedup_key).toBe(wo1.dedup_key);
  });

  it('intake → task lifecycle with review hold and approval', () => {
    // Simulate: create → plan → approve → execute → review_hold → approve → continue → done
    let taskState = TASK_STATES.DRAFT_PLAN;
    taskState = taskTransition(taskState, TASK_EVENTS.PLAN_READY);
    taskState = taskTransition(taskState, TASK_EVENTS.APPROVE);
    taskState = taskTransition(taskState, TASK_EVENTS.START);

    // Execute steps
    taskState = taskTransition(taskState, TASK_EVENTS.STEP_COMPLETED);
    taskState = taskTransition(taskState, TASK_EVENTS.STEP_COMPLETED);

    // Review hold
    taskState = taskTransition(taskState, TASK_EVENTS.REVIEW_NEEDED);
    expect(taskState).toBe(TASK_STATES.REVIEW_HOLD);

    // Manager approves → back to in_progress
    taskState = taskTransition(taskState, TASK_EVENTS.REVIEW_APPROVED);
    expect(taskState).toBe(TASK_STATES.IN_PROGRESS);

    // Complete
    taskState = taskTransition(taskState, TASK_EVENTS.ALL_STEPS_DONE);
    expect(taskState).toBe(TASK_STATES.DONE);
  });

  it('intake → task lifecycle with review rejection → fail → retry', () => {
    let taskState = TASK_STATES.DRAFT_PLAN;
    taskState = taskTransition(taskState, TASK_EVENTS.PLAN_READY);
    taskState = taskTransition(taskState, TASK_EVENTS.APPROVE);
    taskState = taskTransition(taskState, TASK_EVENTS.START);
    taskState = taskTransition(taskState, TASK_EVENTS.REVIEW_NEEDED);
    expect(taskState).toBe(TASK_STATES.REVIEW_HOLD);

    // Manager rejects → task goes to FAILED
    taskState = taskTransition(taskState, TASK_EVENTS.REVIEW_REJECTED);
    expect(taskState).toBe(TASK_STATES.FAILED);

    // RETRY from failed → QUEUED → re-execute
    taskState = taskTransition(taskState, TASK_EVENTS.RETRY);
    expect(taskState).toBe(TASK_STATES.QUEUED);

    taskState = taskTransition(taskState, TASK_EVENTS.START);
    expect(taskState).toBe(TASK_STATES.IN_PROGRESS);

    taskState = taskTransition(taskState, TASK_EVENTS.ALL_STEPS_DONE);
    expect(taskState).toBe(TASK_STATES.DONE);
  });

  it('replay completeness captures email/transcript origin', () => {
    const steps = [{ name: 'report_gen' }];
    const timeline = simulateFullTaskLifecycle(steps, { withReview: true });

    // Augment with email-specific events
    timeline.unshift(makeTimelineEntry(TIMELINE_PHASE.INTAKE, TIMELINE_EVENT.DEDUP_CHECKED, new Date().toISOString(), 'system', { isDuplicate: false }));

    const completeness = computeReplayCompleteness(timeline);
    expect(completeness.score).toBeGreaterThan(50); // score is 0-100
    expect(completeness.missing).toEqual([]); // all required events present
    expect(completeness.phases.intake).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAIN 3: scheduled/proactive → auto task → retry/resume → replay
// ═══════════════════════════════════════════════════════════════════════════

describe('Chain 3: scheduled/proactive → auto task → retry/resume → replay', () => {

  it('proactive alert intake normalizes with alert metadata', () => {
    const workOrder = normalizeIntake({
      source: INTAKE_SOURCES.PROACTIVE_ALERT,
      message: 'Stockout risk detected for material ABC-123',
      employeeId: 'emp_001',
      userId: 'user_001',
      metadata: {
        alert_id: 'alert_stockout_001',
        alert_type: 'stockout_risk',
        material_code: 'ABC-123',
        severity: 'high',
      },
    });

    expect(workOrder.source).toBe('proactive_alert');
    expect(workOrder.title).toContain('Alert');
    expect(workOrder.title).toContain('ABC-123');
    expect(workOrder.dedup_key).toContain('alert:alert_stockout_001');
    expect(workOrder.needs_clarification).toBe(false); // Structured sources don't need clarification
  });

  it('scheduled task intake normalizes with schedule metadata', () => {
    const workOrder = normalizeIntake({
      source: INTAKE_SOURCES.SCHEDULE,
      message: 'Weekly demand forecast run',
      employeeId: 'emp_001',
      userId: 'user_001',
      metadata: {
        schedule_id: 'sched_weekly_forecast',
        schedule_name: 'Weekly Forecast',
        cron: '0 9 * * MON',
      },
    });

    expect(workOrder.source).toBe('schedule');
    expect(workOrder.title).toBe('Weekly Forecast');
    expect(workOrder.dedup_key).toContain('sched:sched_weekly_forecast');
    expect(workOrder.needs_clarification).toBe(false);
  });

  it('step failure → retry → resume follows valid state machine transitions', () => {
    // Step fails, retries, succeeds
    let stepState = STEP_STATES.PENDING;
    stepState = stepTransition(stepState, STEP_EVENTS.START);
    expect(stepState).toBe(STEP_STATES.RUNNING);

    stepState = stepTransition(stepState, STEP_EVENTS.FAIL);
    expect(stepState).toBe(STEP_STATES.FAILED);
    expect(isStepFailed(stepState)).toBe(true);

    // Retry
    stepState = stepTransition(stepState, STEP_EVENTS.RETRY);
    expect(stepState).toBe(STEP_STATES.RETRYING);

    // Resume from retry
    stepState = stepTransition(stepState, STEP_EVENTS.SUCCEED);
    expect(stepState).toBe(STEP_STATES.SUCCEEDED);
    expect(isStepTerminal(stepState)).toBe(true);
  });

  it('task failure → retry → re-execute follows valid transitions', () => {
    let taskState = TASK_STATES.DRAFT_PLAN;
    taskState = taskTransition(taskState, TASK_EVENTS.PLAN_READY);
    taskState = taskTransition(taskState, TASK_EVENTS.APPROVE);
    taskState = taskTransition(taskState, TASK_EVENTS.START);

    // Task fails (FAILED is not terminal — can RETRY)
    taskState = taskTransition(taskState, TASK_EVENTS.FAIL);
    expect(taskState).toBe(TASK_STATES.FAILED);
    expect(isTaskTerminal(taskState)).toBe(false);

    // Retry from failed
    taskState = taskTransition(taskState, TASK_EVENTS.RETRY);
    expect(taskState).toBe(TASK_STATES.QUEUED);

    taskState = taskTransition(taskState, TASK_EVENTS.START);
    expect(taskState).toBe(TASK_STATES.IN_PROGRESS);

    taskState = taskTransition(taskState, TASK_EVENTS.ALL_STEPS_DONE);
    expect(taskState).toBe(TASK_STATES.DONE);
    expect(isTaskTerminal(taskState)).toBe(true);
  });

  it('task block → unblock follows valid transitions', () => {
    let taskState = TASK_STATES.DRAFT_PLAN;
    taskState = taskTransition(taskState, TASK_EVENTS.PLAN_READY);
    taskState = taskTransition(taskState, TASK_EVENTS.APPROVE);
    taskState = taskTransition(taskState, TASK_EVENTS.START);

    // Block
    taskState = taskTransition(taskState, TASK_EVENTS.BLOCK);
    expect(taskState).toBe(TASK_STATES.BLOCKED);

    // Unblock
    taskState = taskTransition(taskState, TASK_EVENTS.UNBLOCK);
    expect(taskState).toBe(TASK_STATES.IN_PROGRESS);
  });

  it('replay completeness with retry events reports correctly', () => {
    const steps = [{ name: 'forecast' }, { name: 'plan' }];
    const timeline = simulateFullTaskLifecycle(steps, { withRetry: true, withReview: true });

    const completeness = computeReplayCompleteness(timeline);
    expect(completeness.score).toBeGreaterThan(50); // score is 0-100
    expect(completeness.missing).toEqual([]); // all required events present
    expect(completeness.phases.intake).toBeGreaterThan(0);
    expect(completeness.phases.execution).toBeGreaterThan(0);
    expect(completeness.phases.delivery).toBeGreaterThan(0);
  });

  it('incomplete timeline (missing review) shows lower or equal completeness', () => {
    const steps = [{ name: 'forecast' }];
    const timelineFull = simulateFullTaskLifecycle(steps, { withReview: true });
    const timelinePartial = simulateFullTaskLifecycle(steps, { withReview: false });

    const fullResult = computeReplayCompleteness(timelineFull);
    const partialResult = computeReplayCompleteness(timelinePartial);

    // Full timeline has more phases covered (review phase)
    expect(fullResult.phases.review).toBeGreaterThan(0);
    expect(partialResult.phases.review || 0).toBe(0);
    expect(fullResult.score).toBeGreaterThanOrEqual(partialResult.score);
  });

  it('all INTAKE_SOURCES are covered by normalizeIntake', () => {
    const sources = Object.values(INTAKE_SOURCES);
    for (const source of sources) {
      const workOrder = normalizeIntake({
        source,
        message: 'Test task for ' + source,
        employeeId: 'emp_001',
        userId: 'user_001',
      });
      expect(workOrder.id).toMatch(/^wo_/);
      expect(workOrder.source).toBe(source);
      expect(workOrder.priority).toBeTruthy();
      expect(workOrder.sla).toBeDefined();
    }
  });
});
