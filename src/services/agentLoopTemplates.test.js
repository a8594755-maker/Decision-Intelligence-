// @product: ai-employee
import { describe, it, expect } from 'vitest';
import {
  AGENT_LOOP_TEMPLATES,
  TEMPLATE_OPTIONS,
  resolveTemplate,
  initLoopState,
} from './agentLoopTemplates';

describe('agentLoopTemplates', () => {
  describe('AGENT_LOOP_TEMPLATES', () => {
    it('has all expected template IDs', () => {
      const ids = Object.keys(AGENT_LOOP_TEMPLATES);
      expect(ids).toContain('full_report');
      expect(ids).toContain('forecast_then_plan');
      expect(ids).toContain('risk_aware_plan');
      expect(ids).toContain('forecast');
      expect(ids).toContain('plan');
      expect(ids).toContain('risk');
    });

    it('full_report has 4 steps', () => {
      expect(AGENT_LOOP_TEMPLATES.full_report.steps).toHaveLength(4);
      expect(AGENT_LOOP_TEMPLATES.full_report.steps.map((s) => s.name))
        .toEqual(['forecast', 'plan', 'risk', 'synthesize']);
    });

    it('single-step templates have exactly 1 step', () => {
      expect(AGENT_LOOP_TEMPLATES.forecast.steps).toHaveLength(1);
      expect(AGENT_LOOP_TEMPLATES.plan.steps).toHaveLength(1);
      expect(AGENT_LOOP_TEMPLATES.risk.steps).toHaveLength(1);
    });

    it('each step has required fields', () => {
      for (const template of Object.values(AGENT_LOOP_TEMPLATES)) {
        for (const step of template.steps) {
          expect(step).toHaveProperty('name');
          expect(step).toHaveProperty('workflow_type');
          expect(step).toHaveProperty('requires_review');
          expect(typeof step.requires_review).toBe('boolean');
        }
      }
    });
  });

  describe('TEMPLATE_OPTIONS', () => {
    it('has composite and non-composite entries', () => {
      expect(TEMPLATE_OPTIONS.filter((o) => o.composite).length).toBeGreaterThan(0);
      expect(TEMPLATE_OPTIONS.filter((o) => !o.composite).length).toBeGreaterThan(0);
    });

    it('every option value maps to a template', () => {
      for (const opt of TEMPLATE_OPTIONS) {
        expect(AGENT_LOOP_TEMPLATES[opt.value]).toBeDefined();
      }
    });
  });

  describe('resolveTemplate', () => {
    it('resolves known template by ID', () => {
      const t = resolveTemplate('full_report');
      expect(t).toBeTruthy();
      expect(t.id).toBe('full_report');
    });

    it('resolves single-step template by workflow_type', () => {
      const t = resolveTemplate('forecast');
      expect(t).toBeTruthy();
      expect(t.steps).toHaveLength(1);
    });

    it('returns null for unknown ID', () => {
      expect(resolveTemplate('nonexistent')).toBeNull();
      expect(resolveTemplate(null)).toBeNull();
      expect(resolveTemplate(undefined)).toBeNull();
    });
  });

  describe('initLoopState', () => {
    it('produces correct initial state from full_report template', () => {
      const template = AGENT_LOOP_TEMPLATES.full_report;
      const state = initLoopState(template);

      expect(state.template_id).toBe('full_report');
      expect(state.steps).toHaveLength(4);
      expect(state.current_step_index).toBe(0);
      expect(state.started_at).toBeNull();
      expect(state.finished_at).toBeNull();
    });

    it('all steps start as pending', () => {
      const state = initLoopState(AGENT_LOOP_TEMPLATES.forecast_then_plan);
      for (const step of state.steps) {
        expect(step.status).toBe('pending');
        expect(step.run_id).toBeNull();
        expect(step.artifact_refs).toEqual([]);
        expect(step.retry_count).toBe(0);
        expect(step.error).toBeNull();
      }
    });

    it('preserves step index and metadata', () => {
      const state = initLoopState(AGENT_LOOP_TEMPLATES.risk_aware_plan);
      expect(state.steps[0]).toMatchObject({ index: 0, name: 'forecast', workflow_type: 'forecast' });
      expect(state.steps[1]).toMatchObject({ index: 1, name: 'risk', workflow_type: 'risk' });
      expect(state.steps[2]).toMatchObject({ index: 2, name: 'plan', workflow_type: 'plan', requires_review: true });
    });

    it('throws on empty/null template', () => {
      expect(() => initLoopState(null)).toThrow();
      expect(() => initLoopState({ steps: [] })).toThrow();
    });
  });
});
