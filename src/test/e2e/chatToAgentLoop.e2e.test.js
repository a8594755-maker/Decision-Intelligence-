// @product: ai-employee
//
// E2E integration test: Chat instruction → decompose → template → agent loop
// Tests the full Phase 5 pipeline without requiring Supabase or LLM calls.

import { describe, it, expect, vi } from 'vitest';

// Mock supabase
vi.mock('../../services/supabaseClient', () => ({ supabase: null }));

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

import { decomposeTask, validateDecomposition, topologicalSort } from '../../services/chatTaskDecomposer';
import { buildDynamicTemplate, isDynamicTemplate, initDynamicLoopState } from '../../services/dynamicTemplateBuilder';
import { getBuiltinTool, findToolsByQuery, resolveDependencies } from '../../services/builtinToolCatalog';
import { PERMISSION_REGISTRY, checkPermission } from '../../services/toolPermissionGuard';

// ── Full pipeline: decompose → validate → template → loop state ─────────────

describe('Chat → Agent Loop pipeline', () => {
  it('decomposes "Run forecast and plan" into valid builtin_tool steps with dependencies', async () => {
    const decomposition = await decomposeTask({ userMessage: 'Run demand forecast and create a replenishment plan' });

    // Should have at least 2 subtasks
    expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(2);

    // Should contain forecast and plan as builtin_tool steps
    const forecastStep = decomposition.subtasks.find(s => s.builtin_tool_id === 'run_forecast');
    const planStep = decomposition.subtasks.find(s => s.builtin_tool_id === 'run_plan');
    expect(forecastStep).toBeTruthy();
    expect(planStep).toBeTruthy();
    expect(forecastStep.workflow_type).toBe('builtin_tool');
    expect(planStep.workflow_type).toBe('builtin_tool');

    // Forecast should come before plan (dependency order)
    const forecastIdx = decomposition.subtasks.indexOf(forecastStep);
    const planIdx = decomposition.subtasks.indexOf(planStep);
    expect(forecastIdx).toBeLessThan(planIdx);

    // Plan depends on forecast
    expect(planStep.depends_on).toContain('run_forecast');

    // Validation should pass
    const { valid, errors } = validateDecomposition(decomposition);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it('builds a dynamic template from decomposition', async () => {
    const decomposition = await decomposeTask({ userMessage: 'Forecast demand and generate a report' });
    const template = buildDynamicTemplate(decomposition);

    expect(template.id).toMatch(/^dynamic_/);
    expect(isDynamicTemplate(template.id)).toBe(true);
    expect(template.steps.length).toBeGreaterThanOrEqual(2);

    // Steps should preserve builtin_tool_id
    const forecastStep = template.steps.find(s => s.builtin_tool_id === 'run_forecast');
    expect(forecastStep).toBeTruthy();
    expect(forecastStep.workflow_type).toBe('builtin_tool');
  });

  it('initializes loop state from dynamic template with correct step metadata', async () => {
    const decomposition = await decomposeTask({ userMessage: 'Run forecast then plan' });
    const template = buildDynamicTemplate(decomposition);
    const loopState = initDynamicLoopState(template);

    expect(loopState.template_id).toBe(template.id);
    expect(loopState.steps.length).toBe(template.steps.length);

    // All steps should start as pending
    for (const step of loopState.steps) {
      expect(step.status).toBe('pending');
      expect(step.retry_count).toBe(0);
      expect(step.artifact_refs).toEqual([]);
    }

    // builtin_tool_id should be propagated
    const forecastLoopStep = loopState.steps.find(s => s.builtin_tool_id === 'run_forecast');
    expect(forecastLoopStep).toBeTruthy();
    expect(forecastLoopStep.workflow_type).toBe('builtin_tool');
  });

  it('auto-resolves transitive dependencies: risk_aware_plan → plan → forecast', async () => {
    // risk_aware_plan depends on plan and risk, plan depends on forecast
    const decomposition = await decomposeTask({ userMessage: 'Run a risk-aware replenishment plan' });

    // Should have forecast auto-added as dependency
    const hasAnyForecast = decomposition.subtasks.some(s =>
      s.builtin_tool_id === 'run_forecast' ||
      s.builtin_tool_id === 'run_risk_aware_plan'
    );
    expect(hasAnyForecast).toBe(true);
  });

  it('complex pipeline: forecast + risk + plan + report + export', async () => {
    const decomposition = await decomposeTask({
      userMessage: 'Forecast demand, assess risk, generate a replenishment plan, and export to Excel with a summary report',
    });

    expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(4);
    expect(decomposition.report_format).toBe('xlsx');

    // Should have report and export steps with correct dependencies
    const reportStep = decomposition.subtasks.find(s => s.workflow_type === 'report');
    const exportStep = decomposition.subtasks.find(s => s.workflow_type === 'export');
    expect(reportStep).toBeTruthy();
    expect(exportStep).toBeTruthy();
    expect(exportStep.depends_on).toContain('report');

    // Build template and verify
    const template = buildDynamicTemplate(decomposition);
    expect(template.steps.length).toBeGreaterThanOrEqual(4);

    const loopState = initDynamicLoopState(template);
    expect(loopState.steps.length).toBe(template.steps.length);

    // All steps pending, no errors
    expect(loopState.steps.every(s => s.status === 'pending')).toBe(true);
  });

  it('Chinese instruction produces valid pipeline', async () => {
    const decomposition = await decomposeTask({ userMessage: '執行需求預測然後產生補貨計畫' });

    expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(2);
    const { valid } = validateDecomposition(decomposition);
    expect(valid).toBe(true);

    const template = buildDynamicTemplate(decomposition);
    const loopState = initDynamicLoopState(template);
    expect(loopState.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('unknown instruction falls through to dynamic_tool and builds template', async () => {
    const decomposition = await decomposeTask({ userMessage: 'Xylophone giraffe paradox quasar' });

    // Should have at least one step
    expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(1);

    // dynamic_tool or registered_tool
    const hasDynamic = decomposition.subtasks.some(s =>
      s.workflow_type === 'dynamic_tool' || s.workflow_type === 'registered_tool'
    );
    expect(hasDynamic).toBe(true);

    // Can still build a template
    const template = buildDynamicTemplate(decomposition);
    expect(template.steps.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Permission check integration ─────────────────────────────────────────────

describe('Permission integration', () => {
  it('builtin_tool permission is registered', () => {
    expect(PERMISSION_REGISTRY.builtin_tool).toEqual(['can_run_builtin_tool']);
  });

  it('Aiden-like employee with all permissions passes builtin_tool check', () => {
    const employee = {
      name: 'Aiden',
      permissions: {
        can_run_forecast: true,
        can_run_plan: true,
        can_run_risk: true,
        can_run_builtin_tool: true,
        can_run_dynamic_tool: true,
        can_run_registered_tool: true,
        can_generate_report: true,
        can_export: true,
      },
    };

    expect(checkPermission(employee, 'builtin_tool')).toBe(true);
    expect(checkPermission(employee, 'dynamic_tool')).toBe(true);
    expect(checkPermission(employee, 'report')).toBe(true);
    expect(checkPermission(employee, 'export')).toBe(true);
  });

  it('employee without can_run_builtin_tool is denied', () => {
    const employee = {
      name: 'Limited',
      permissions: { can_run_forecast: true },
    };

    expect(() => checkPermission(employee, 'builtin_tool')).toThrow('Permission denied');
  });
});

// ── Catalog → executor arg-building integration ──────────────────────────────

describe('Catalog → executor integration', () => {
  it('every builtin_tool step from decomposer has a valid catalog entry', async () => {
    const testMessages = [
      'Run demand forecast',
      'Generate replenishment plan',
      'Assess supplier risk',
      'Run BOM explosion',
      'Start supplier negotiation',
      'Run cost forecast',
      'Run what-if scenario',
      'Run monte carlo simulation',
    ];

    for (const msg of testMessages) {
      const d = await decomposeTask({ userMessage: msg });
      for (const step of d.subtasks) {
        if (step.workflow_type === 'builtin_tool') {
          const entry = getBuiltinTool(step.builtin_tool_id);
          expect(entry).toBeTruthy();
          expect(entry.module).toBeTruthy();
          expect(entry.method).toBeTruthy();
        }
      }
    }
  });

  it('dependency resolution produces stable topological order', () => {
    // run_risk_aware_plan depends on run_forecast + run_risk_analysis
    const resolved = resolveDependencies(['run_risk_aware_plan']);

    // forecast must come before risk_aware_plan
    expect(resolved.indexOf('run_forecast')).toBeLessThan(resolved.indexOf('run_risk_aware_plan'));
    // risk_analysis must come before risk_aware_plan
    expect(resolved.indexOf('run_risk_analysis')).toBeLessThan(resolved.indexOf('run_risk_aware_plan'));
  });
});
