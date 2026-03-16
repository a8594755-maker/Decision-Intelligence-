/**
 * Tests for Phase 1 — Decision Pipeline, State Machine extensions, Worklog Taxonomy, Intake→DWO
 */

import { describe, it, expect } from 'vitest';

import {
  taskTransition,
  TASK_STATES,
  TASK_EVENTS,
  isTaskTerminal,
  isTaskWaiting,
  canTaskTransition,
} from './taskStateMachine.js';

import {
  PIPELINE_PHASES,
  PHASE_ORDER,
  classifyStepPhase,
  annotateStepsWithPhases,
  getPipelineProgress,
  isReadyForReview,
  convertToDWO,
} from './decisionPipelineService.js';

import {
  WORKLOG_EVENTS,
  WORKLOG_CATEGORIES,
  buildWorklogEntry,
  checkAuditCompleteness,
  PHASE_EXPECTED_EVENTS,
} from './worklogTaxonomy.js';

// ── Task State Machine v2 ───────────────────────────────────────────────────

describe('Task State Machine — v2 extensions', () => {
  describe('new states', () => {
    it('defines needs_clarification state', () => {
      expect(TASK_STATES.NEEDS_CLARIFICATION).toBe('needs_clarification');
    });

    it('defines awaiting_approval state', () => {
      expect(TASK_STATES.AWAITING_APPROVAL).toBe('awaiting_approval');
    });

    it('defines publish_failed state', () => {
      expect(TASK_STATES.PUBLISH_FAILED).toBe('publish_failed');
    });

    it('defines blocked_external_dependency state', () => {
      expect(TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY).toBe('blocked_external_dependency');
    });
  });

  describe('new transitions from in_progress', () => {
    it('in_progress → needs_clarification via need_clarification', () => {
      expect(taskTransition(TASK_STATES.IN_PROGRESS, TASK_EVENTS.NEED_CLARIFICATION))
        .toBe(TASK_STATES.NEEDS_CLARIFICATION);
    });

    it('in_progress → publish_failed via publish_fail', () => {
      expect(taskTransition(TASK_STATES.IN_PROGRESS, TASK_EVENTS.PUBLISH_FAIL))
        .toBe(TASK_STATES.PUBLISH_FAILED);
    });

    it('in_progress → blocked_external_dependency via external_block', () => {
      expect(taskTransition(TASK_STATES.IN_PROGRESS, TASK_EVENTS.EXTERNAL_BLOCK))
        .toBe(TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY);
    });
  });

  describe('recovery from new states', () => {
    it('needs_clarification → in_progress via clarification_received', () => {
      expect(taskTransition(TASK_STATES.NEEDS_CLARIFICATION, TASK_EVENTS.CLARIFICATION_RECEIVED))
        .toBe(TASK_STATES.IN_PROGRESS);
    });

    it('needs_clarification → cancelled', () => {
      expect(taskTransition(TASK_STATES.NEEDS_CLARIFICATION, TASK_EVENTS.CANCEL))
        .toBe(TASK_STATES.CANCELLED);
    });

    it('publish_failed → in_progress via retry', () => {
      expect(taskTransition(TASK_STATES.PUBLISH_FAILED, TASK_EVENTS.RETRY))
        .toBe(TASK_STATES.IN_PROGRESS);
    });

    it('blocked_external_dependency → in_progress via external_resolved', () => {
      expect(taskTransition(TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY, TASK_EVENTS.EXTERNAL_RESOLVED))
        .toBe(TASK_STATES.IN_PROGRESS);
    });

    it('blocked_external_dependency → failed', () => {
      expect(taskTransition(TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY, TASK_EVENTS.FAIL))
        .toBe(TASK_STATES.FAILED);
    });

    it('awaiting_approval → in_progress via approve', () => {
      expect(taskTransition(TASK_STATES.AWAITING_APPROVAL, TASK_EVENTS.APPROVE))
        .toBe(TASK_STATES.IN_PROGRESS);
    });

    it('awaiting_approval → failed via review_rejected', () => {
      expect(taskTransition(TASK_STATES.AWAITING_APPROVAL, TASK_EVENTS.REVIEW_REJECTED))
        .toBe(TASK_STATES.FAILED);
    });
  });

  describe('isTaskWaiting', () => {
    it('waiting states return true', () => {
      expect(isTaskWaiting(TASK_STATES.WAITING_APPROVAL)).toBe(true);
      expect(isTaskWaiting(TASK_STATES.REVIEW_HOLD)).toBe(true);
      expect(isTaskWaiting(TASK_STATES.NEEDS_CLARIFICATION)).toBe(true);
      expect(isTaskWaiting(TASK_STATES.AWAITING_APPROVAL)).toBe(true);
      expect(isTaskWaiting(TASK_STATES.PUBLISH_FAILED)).toBe(true);
      expect(isTaskWaiting(TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY)).toBe(true);
    });

    it('active/terminal states return false', () => {
      expect(isTaskWaiting(TASK_STATES.IN_PROGRESS)).toBe(false);
      expect(isTaskWaiting(TASK_STATES.DONE)).toBe(false);
      expect(isTaskWaiting(TASK_STATES.QUEUED)).toBe(false);
    });
  });

  describe('backward compatibility', () => {
    it('original transitions still work', () => {
      expect(taskTransition(TASK_STATES.DRAFT_PLAN, TASK_EVENTS.PLAN_READY)).toBe(TASK_STATES.WAITING_APPROVAL);
      expect(taskTransition(TASK_STATES.WAITING_APPROVAL, TASK_EVENTS.APPROVE)).toBe(TASK_STATES.QUEUED);
      expect(taskTransition(TASK_STATES.QUEUED, TASK_EVENTS.START)).toBe(TASK_STATES.IN_PROGRESS);
      expect(taskTransition(TASK_STATES.IN_PROGRESS, TASK_EVENTS.ALL_STEPS_DONE)).toBe(TASK_STATES.DONE);
      expect(taskTransition(TASK_STATES.FAILED, TASK_EVENTS.RETRY)).toBe(TASK_STATES.QUEUED);
    });

    it('isTaskTerminal unchanged', () => {
      expect(isTaskTerminal(TASK_STATES.DONE)).toBe(true);
      expect(isTaskTerminal(TASK_STATES.CANCELLED)).toBe(true);
      expect(isTaskTerminal(TASK_STATES.FAILED)).toBe(false);
      expect(isTaskTerminal(TASK_STATES.NEEDS_CLARIFICATION)).toBe(false);
    });
  });
});

// ── Decision Pipeline Service ───────────────────────────────────────────────

describe('Decision Pipeline Service', () => {
  describe('classifyStepPhase', () => {
    it('classifies data loading as ingest', () => {
      expect(classifyStepPhase({ name: 'load_data' })).toBe(PIPELINE_PHASES.INGEST);
      expect(classifyStepPhase({ name: 'import_csv' })).toBe(PIPELINE_PHASES.INGEST);
      expect(classifyStepPhase({ name: 'data_quality_check' })).toBe(PIPELINE_PHASES.INGEST);
    });

    it('classifies analysis steps', () => {
      expect(classifyStepPhase({ name: 'run_forecast' })).toBe(PIPELINE_PHASES.ANALYZE);
      expect(classifyStepPhase({ name: 'risk_assessment' })).toBe(PIPELINE_PHASES.ANALYZE);
      expect(classifyStepPhase({ name: 'scenario_compare' })).toBe(PIPELINE_PHASES.ANALYZE);
    });

    it('classifies planning steps', () => {
      expect(classifyStepPhase({ name: 'optimize_plan' })).toBe(PIPELINE_PHASES.DRAFT_PLAN);
      expect(classifyStepPhase({ name: 'generate_report' })).toBe(PIPELINE_PHASES.DRAFT_PLAN);
      expect(classifyStepPhase({ name: 'build_brief' })).toBe(PIPELINE_PHASES.DRAFT_PLAN);
    });

    it('classifies review steps', () => {
      expect(classifyStepPhase({ name: 'review_checkpoint' })).toBe(PIPELINE_PHASES.REVIEW_GATE);
      expect(classifyStepPhase({ name: 'approval_gate' })).toBe(PIPELINE_PHASES.REVIEW_GATE);
    });

    it('classifies publish steps', () => {
      expect(classifyStepPhase({ name: 'export_excel' })).toBe(PIPELINE_PHASES.PUBLISH);
      expect(classifyStepPhase({ name: 'writeback_sap' })).toBe(PIPELINE_PHASES.PUBLISH);
      expect(classifyStepPhase({ name: 'opencloud_publish' })).toBe(PIPELINE_PHASES.PUBLISH);
    });

    it('respects explicit pipeline_phase override', () => {
      expect(classifyStepPhase({ name: 'custom_step', pipeline_phase: 'ingest' })).toBe(PIPELINE_PHASES.INGEST);
    });

    it('defaults to analyze for unknown steps', () => {
      expect(classifyStepPhase({ name: 'unknown_step_xyz' })).toBe(PIPELINE_PHASES.ANALYZE);
    });
  });

  describe('annotateStepsWithPhases', () => {
    it('adds _pipeline_phase to each step', () => {
      const steps = [
        { name: 'load_data' },
        { name: 'run_forecast' },
        { name: 'optimize_plan' },
      ];
      const annotated = annotateStepsWithPhases(steps);
      expect(annotated[0]._pipeline_phase).toBe('ingest');
      expect(annotated[1]._pipeline_phase).toBe('analyze');
      expect(annotated[2]._pipeline_phase).toBe('draft_plan');
      expect(annotated[0]._pipeline_index).toBe(0);
    });

    it('does not mutate input', () => {
      const steps = [{ name: 'test' }];
      annotateStepsWithPhases(steps);
      expect(steps[0]._pipeline_phase).toBeUndefined();
    });
  });

  describe('getPipelineProgress', () => {
    it('reports correct progress', () => {
      const steps = [
        { name: 'load_data', status: 'succeeded' },
        { name: 'run_forecast', status: 'succeeded' },
        { name: 'optimize_plan', status: 'running' },
        { name: 'export_excel', status: 'pending' },
      ];
      const progress = getPipelineProgress(steps);

      expect(progress.phaseProgress.ingest.done).toBe(true);
      expect(progress.phaseProgress.analyze.done).toBe(true);
      expect(progress.phaseProgress.draft_plan.done).toBe(false);
      expect(progress.completedPhases).toContain('ingest');
      expect(progress.completedPhases).toContain('analyze');
      expect(progress.currentPhase).toBe('draft_plan');
    });

    it('handles all completed', () => {
      const steps = [
        { name: 'load_data', status: 'succeeded' },
        { name: 'run_forecast', status: 'succeeded' },
        { name: 'optimize_plan', status: 'succeeded' },
        { name: 'export_excel', status: 'succeeded' },
      ];
      const progress = getPipelineProgress(steps);
      expect(progress.completedPhases).toHaveLength(4); // ingest, analyze, draft_plan, publish
    });
  });

  describe('isReadyForReview', () => {
    it('returns true when ingest+analyze+draft_plan done', () => {
      const steps = [
        { name: 'load_data', status: 'succeeded' },
        { name: 'run_forecast', status: 'succeeded' },
        { name: 'optimize_plan', status: 'succeeded' },
      ];
      expect(isReadyForReview(steps)).toBe(true);
    });

    it('returns false when analyze still running', () => {
      const steps = [
        { name: 'load_data', status: 'succeeded' },
        { name: 'run_forecast', status: 'running' },
        { name: 'optimize_plan', status: 'pending' },
      ];
      expect(isReadyForReview(steps)).toBe(false);
    });
  });

  describe('convertToDWO', () => {
    it('converts legacy work order and validates', () => {
      const legacy = {
        id: 'wo_123',
        source: 'chat',
        title: 'Run forecast',
        description: 'Weekly forecast',
        priority: 'high',
        employee_id: 'emp-1',
        user_id: 'user-1',
        sla: { due_at: '2026-04-01T00:00:00Z' },
        context: {},
      };
      const { dwo, validation } = convertToDWO(legacy, {
        intent_type: 'forecast_refresh',
      });
      expect(dwo.intent_type).toBe('forecast_refresh');
      expect(dwo.source_channel).toBe('chat');
      expect(validation.valid).toBe(true);
    });
  });
});

// ── Worklog Taxonomy ────────────────────────────────────────────────────────

describe('Worklog Taxonomy', () => {
  it('defines all expected event types', () => {
    expect(WORKLOG_EVENTS.INTAKE_NORMALIZED).toBe('intake_normalized');
    expect(WORKLOG_EVENTS.ANALYSIS_STARTED).toBe('analysis_started');
    expect(WORKLOG_EVENTS.ARTIFACT_GENERATED).toBe('artifact_generated');
    expect(WORKLOG_EVENTS.REVIEW_REQUESTED).toBe('review_requested');
    expect(WORKLOG_EVENTS.WRITEBACK_PREPARED).toBe('writeback_prepared');
    expect(WORKLOG_EVENTS.VALUE_EVENT_RECORDED).toBe('value_event_recorded');
  });

  it('defines worklog categories', () => {
    expect(WORKLOG_CATEGORIES.DECISION).toBe('decision');
    expect(WORKLOG_CATEGORIES.PUBLISH).toBe('publish');
    expect(WORKLOG_CATEGORIES.VALUE).toBe('value');
  });

  describe('buildWorklogEntry', () => {
    it('builds structured entry with timestamp', () => {
      const entry = buildWorklogEntry(WORKLOG_EVENTS.ANALYSIS_STARTED, {
        step_name: 'forecast',
      }, { pipelinePhase: 'analyze' });

      expect(entry.event).toBe('analysis_started');
      expect(entry.pipeline_phase).toBe('analyze');
      expect(entry.step_name).toBe('forecast');
      expect(entry.timestamp).toBeTruthy();
    });
  });

  describe('checkAuditCompleteness', () => {
    it('returns complete when all expected events present', () => {
      const worklogs = [
        { content: { event: 'intake_received' } },
        { content: { event: 'intake_normalized' } },
        { content: { event: 'analysis_started' } },
        { content: { event: 'analysis_completed' } },
        { content: { event: 'artifact_generated' } },
        { content: { event: 'decision_brief_built' } },
        { content: { event: 'review_requested' } },
        { content: { event: 'review_resolved' } },
        { content: { event: 'writeback_prepared' } },
      ];
      const result = checkAuditCompleteness(worklogs);
      expect(result.complete).toBe(true);
    });

    it('reports missing events', () => {
      const worklogs = [
        { content: { event: 'intake_received' } },
        { content: { event: 'analysis_started' } },
      ];
      const result = checkAuditCompleteness(worklogs, ['ingest', 'analyze']);
      expect(result.complete).toBe(false);
      expect(result.missing.ingest).toContain('intake_normalized');
      expect(result.missing.analyze).toContain('analysis_completed');
    });

    it('checks specific phases only', () => {
      const worklogs = [
        { content: { event: 'intake_received' } },
        { content: { event: 'intake_normalized' } },
      ];
      const result = checkAuditCompleteness(worklogs, ['ingest']);
      expect(result.complete).toBe(true);
    });
  });
});
