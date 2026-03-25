// @product: ai-employee
import { describe, it, expect } from 'vitest';

import {
  buildDynamicTemplate,
  initDynamicLoopState,
  isDynamicTemplate,
  getDynamicTemplateFromTask,
} from './dynamicTemplateBuilder';

// ── buildDynamicTemplate ─────────────────────────────────────────────────────

describe('buildDynamicTemplate', () => {
  it('builds a template from a decomposition', () => {
    const decomposition = {
      original_instruction: 'Forecast demand and create a plan',
      subtasks: [
        { name: 'forecast', workflow_type: 'forecast', depends_on: [], requires_review: false },
        { name: 'plan', workflow_type: 'plan', depends_on: ['forecast'], requires_review: true },
      ],
      report_format: 'xlsx',
      estimated_cost: 0.01,
    };

    const template = buildDynamicTemplate(decomposition);

    expect(template.id).toMatch(/^dynamic_\d+$/);
    expect(template.label).toContain('Forecast demand');
    expect(template.steps.length).toBe(2);
    expect(template.steps[0].name).toBe('forecast');
    expect(template.steps[1].name).toBe('plan');
    expect(template.report_format).toBe('xlsx');
  });

  it('topologically sorts steps', () => {
    const decomposition = {
      original_instruction: 'Multi-step',
      subtasks: [
        { name: 'report', workflow_type: 'report', depends_on: ['plan'] },
        { name: 'plan', workflow_type: 'plan', depends_on: ['forecast'] },
        { name: 'forecast', workflow_type: 'forecast', depends_on: [] },
      ],
    };

    const template = buildDynamicTemplate(decomposition);
    const names = template.steps.map(s => s.name);
    expect(names).toEqual(['forecast', 'plan', 'report']);
  });

  it('marks ai_review for reviewable types', () => {
    const decomposition = {
      original_instruction: 'Dynamic tool + export',
      subtasks: [
        { name: 'tool', workflow_type: 'dynamic_tool', depends_on: [] },
        { name: 'export', workflow_type: 'export', depends_on: ['tool'] },
      ],
    };

    const template = buildDynamicTemplate(decomposition);
    expect(template.steps.find(s => s.name === 'tool').ai_review).toBe(true);
    expect(template.steps.find(s => s.name === 'export').ai_review).toBe(false);
  });

  it('preserves tool_hint and tool_id', () => {
    const decomposition = {
      original_instruction: 'Use registered tool',
      subtasks: [
        { name: 'analysis', workflow_type: 'registered_tool', tool_id: 'tool-123', depends_on: [] },
        { name: 'gen', workflow_type: 'dynamic_tool', tool_hint: 'build lead time model', depends_on: [] },
      ],
    };

    const template = buildDynamicTemplate(decomposition);
    expect(template.steps.find(s => s.name === 'analysis').tool_id).toBe('tool-123');
    expect(template.steps.find(s => s.name === 'gen').tool_hint).toBe('build lead time model');
  });

  it('preserves builtin_tool_id', () => {
    const decomposition = {
      original_instruction: 'Run forecast via catalog',
      subtasks: [
        { name: 'run_forecast', workflow_type: 'builtin_tool', builtin_tool_id: 'run_forecast', depends_on: [] },
        { name: 'run_plan', workflow_type: 'builtin_tool', builtin_tool_id: 'run_plan', depends_on: ['run_forecast'] },
      ],
    };

    const template = buildDynamicTemplate(decomposition);
    expect(template.steps[0].builtin_tool_id).toBe('run_forecast');
    expect(template.steps[1].builtin_tool_id).toBe('run_plan');
  });

  it('marks builtin_tool steps for ai_review', () => {
    const decomposition = {
      original_instruction: 'Builtin tool step',
      subtasks: [
        { name: 'run_forecast', workflow_type: 'builtin_tool', builtin_tool_id: 'run_forecast', depends_on: [] },
      ],
    };

    const template = buildDynamicTemplate(decomposition);
    expect(template.steps[0].ai_review).toBe(true);
  });

  it('sets builtin_tool_id to null when not provided', () => {
    const decomposition = {
      original_instruction: 'Legacy step',
      subtasks: [
        { name: 'forecast', workflow_type: 'forecast', depends_on: [] },
      ],
    };

    const template = buildDynamicTemplate(decomposition);
    expect(template.steps[0].builtin_tool_id).toBeNull();
  });

  it('throws on empty subtasks', () => {
    expect(() => buildDynamicTemplate({ subtasks: [] })).toThrow();
    expect(() => buildDynamicTemplate(null)).toThrow();
  });
});

// ── initDynamicLoopState ─────────────────────────────────────────────────────

describe('initDynamicLoopState', () => {
  it('initializes loop state from template', () => {
    const template = {
      id: 'dynamic_123',
      steps: [
        { name: 'forecast', workflow_type: 'forecast', requires_review: false, ai_review: true },
        { name: 'plan', workflow_type: 'plan', requires_review: true, ai_review: true },
      ],
    };

    const state = initDynamicLoopState(template);

    expect(state.template_id).toBe('dynamic_123');
    expect(state.steps.length).toBe(2);
    expect(state.current_step_index).toBe(0);
    expect(state.started_at).toBeTruthy();
    expect(state.finished_at).toBeNull();

    // Check step initialization
    const step0 = state.steps[0];
    expect(step0.status).toBe('pending');
    expect(step0.index).toBe(0);
    expect(step0.retry_count).toBe(0);
    expect(step0.run_id).toBeNull();
    expect(step0.artifact_refs).toEqual([]);
    expect(step0._revision_instructions).toBeNull();
    expect(step0._revision_log).toEqual([]);
  });

  it('preserves ai_review and tool fields', () => {
    const template = {
      id: 'dynamic_456',
      steps: [
        { name: 'tool', workflow_type: 'dynamic_tool', ai_review: true, tool_hint: 'build model' },
      ],
    };

    const state = initDynamicLoopState(template);
    expect(state.steps[0].ai_review).toBe(true);
    expect(state.steps[0].tool_hint).toBe('build model');
  });

  it('propagates builtin_tool_id into loop state steps', () => {
    const template = {
      id: 'dynamic_789',
      steps: [
        { name: 'run_forecast', workflow_type: 'builtin_tool', ai_review: true, builtin_tool_id: 'run_forecast' },
        { name: 'run_plan', workflow_type: 'builtin_tool', ai_review: true, builtin_tool_id: 'run_plan' },
      ],
    };

    const state = initDynamicLoopState(template);
    expect(state.steps[0].builtin_tool_id).toBe('run_forecast');
    expect(state.steps[1].builtin_tool_id).toBe('run_plan');
    expect(state.steps[0].workflow_type).toBe('builtin_tool');
  });
});

// ── isDynamicTemplate ────────────────────────────────────────────────────────

describe('isDynamicTemplate', () => {
  it('returns true for dynamic_ prefix', () => {
    expect(isDynamicTemplate('dynamic_1234567890')).toBe(true);
  });

  it('returns false for static templates', () => {
    expect(isDynamicTemplate('full_report')).toBe(false);
    expect(isDynamicTemplate('forecast')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isDynamicTemplate(null)).toBe(false);
    expect(isDynamicTemplate(undefined)).toBe(false);
  });
});

// ── getDynamicTemplateFromTask ───────────────────────────────────────────────

describe('getDynamicTemplateFromTask', () => {
  it('extracts template from task input_context', () => {
    const task = {
      input_context: {
        _dynamic_template: { id: 'dynamic_123', steps: [] },
      },
    };
    const template = getDynamicTemplateFromTask(task);
    expect(template.id).toBe('dynamic_123');
  });

  it('returns null when no template', () => {
    expect(getDynamicTemplateFromTask({ input_context: {} })).toBeNull();
    expect(getDynamicTemplateFromTask(null)).toBeNull();
    expect(getDynamicTemplateFromTask({})).toBeNull();
  });
});
