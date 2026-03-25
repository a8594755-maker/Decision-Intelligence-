// @product: ai-employee
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabaseClient', () => ({ supabase: null }));

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

import {
  decomposeTask,
  validateDecomposition,
  topologicalSort,
  getCatalogSummary,
} from './chatTaskDecomposer';

// Helper: check if any subtask matches a builtin_tool_id pattern
const hasBuiltinTool = (d, toolIdSubstr) =>
  d.subtasks.some(s => s.builtin_tool_id && s.builtin_tool_id.includes(toolIdSubstr));

const hasWorkflowType = (d, wfType) =>
  d.subtasks.some(s => s.workflow_type === wfType);

// ── decomposeTask ────────────────────────────────────────────────────────────

describe('decomposeTask', () => {
  it('detects forecast from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Run a demand forecast for next quarter' });
    expect(hasBuiltinTool(d, 'forecast')).toBe(true);
    expect(d.confidence).toBeGreaterThan(0);
  });

  it('detects plan from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Generate a replenishment plan' });
    expect(hasBuiltinTool(d, 'plan')).toBe(true);
  });

  it('detects risk from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Assess supplier risk for our top items' });
    expect(hasBuiltinTool(d, 'risk')).toBe(true);
  });

  it('detects export from keywords', async () => {
    const d = await decomposeTask({ userMessage: 'Export the results to Excel' });
    expect(hasWorkflowType(d, 'export')).toBe(true);
    expect(d.report_format).toBe('xlsx');
  });

  it('detects report from keywords', async () => {
    const d = await decomposeTask({ userMessage: 'Generate a summary report' });
    expect(hasWorkflowType(d, 'report')).toBe(true);
  });

  it('detects BOM explosion from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Run BOM explosion for component demand' });
    expect(hasBuiltinTool(d, 'bom')).toBe(true);
  });

  it('detects negotiation from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Start supplier negotiation' });
    expect(hasBuiltinTool(d, 'negotiation')).toBe(true);
  });

  it('detects cost forecast from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Run cost forecast for procurement spend' });
    expect(hasBuiltinTool(d, 'cost')).toBe(true);
  });

  it('detects scenario/what-if from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Run a what-if scenario analysis' });
    expect(hasBuiltinTool(d, 'scenario')).toBe(true);
  });

  it('detects simulation from keywords via catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Run a monte carlo simulation' });
    expect(hasBuiltinTool(d, 'simulation')).toBe(true);
  });

  it('defaults to python_tool for unknown instructions', async () => {
    const d = await decomposeTask({ userMessage: 'Do something completely new and weird' });
    expect(d.subtasks.length).toBeGreaterThanOrEqual(1);
    const hasKnownType = d.subtasks.some(s =>
      s.workflow_type === 'python_tool' || s.workflow_type === 'dynamic_tool' || s.workflow_type === 'registered_tool'
    );
    expect(hasKnownType).toBe(true);
  });

  it('auto-resolves dependencies from catalog', async () => {
    const d = await decomposeTask({ userMessage: 'Generate a replenishment plan' });
    // Plan depends on forecast in the catalog → forecast should be auto-added
    const hasForecast = d.subtasks.some(s => s.builtin_tool_id === 'run_forecast');
    const hasPlan = d.subtasks.some(s => s.builtin_tool_id === 'run_plan');
    expect(hasForecast).toBe(true);
    expect(hasPlan).toBe(true);
  });

  it('dependency order: forecast before plan', async () => {
    const d = await decomposeTask({ userMessage: 'Run forecast then create a plan' });
    const forecastIdx = d.subtasks.findIndex(s => s.builtin_tool_id === 'run_forecast');
    const planIdx = d.subtasks.findIndex(s => s.builtin_tool_id === 'run_plan');
    if (forecastIdx !== -1 && planIdx !== -1) {
      expect(forecastIdx).toBeLessThan(planIdx);
    }
  });

  it('report depends on other steps', async () => {
    const d = await decomposeTask({ userMessage: 'Run forecast and generate a report' });
    const reportStep = d.subtasks.find(s => s.name === 'report');
    expect(reportStep).toBeTruthy();
    expect(reportStep.depends_on.length).toBeGreaterThan(0);
  });

  it('export depends on report', async () => {
    const d = await decomposeTask({ userMessage: 'Generate a report and export to Excel' });
    const exportStep = d.subtasks.find(s => s.name === 'export');
    expect(exportStep).toBeTruthy();
    expect(exportStep.depends_on).toContain('report');
  });

  it('detects Power BI format', async () => {
    const d = await decomposeTask({ userMessage: 'Export results to Power BI' });
    expect(d.report_format).toBe('powerbi');
  });

  it('estimates cost', async () => {
    const d = await decomposeTask({ userMessage: 'Run forecast and create a plan' });
    expect(d.estimated_cost).toBeGreaterThan(0);
  });

  it('handles empty message', async () => {
    const d = await decomposeTask({ userMessage: '' });
    expect(d.subtasks.length).toBe(0);
    expect(d.confidence).toBe(0);
  });

  it('handles null message', async () => {
    const d = await decomposeTask({ userMessage: null });
    expect(d.subtasks.length).toBe(0);
  });

  it('supports Chinese instructions', async () => {
    const d = await decomposeTask({ userMessage: '執行需求預測然後產生補貨計畫' });
    expect(hasBuiltinTool(d, 'forecast')).toBe(true);
    expect(hasBuiltinTool(d, 'plan')).toBe(true);
  });

  it('supports Chinese risk keywords', async () => {
    const d = await decomposeTask({ userMessage: '風險評估' });
    expect(hasBuiltinTool(d, 'risk')).toBe(true);
  });

  it('marks dynamic_tool steps with requires_review', async () => {
    const d = await decomposeTask({ userMessage: 'Build a custom solver for lot sizing' });
    const dynamicStep = d.subtasks.find(s => s.workflow_type === 'dynamic_tool');
    if (dynamicStep) {
      expect(dynamicStep.requires_review).toBe(true);
      expect(dynamicStep.estimated_tier).toBe('tier_a');
    }
  });

  it('complex multi-step instruction', async () => {
    const d = await decomposeTask({
      userMessage: 'Forecast demand, assess risk, generate a replenishment plan, and export to Excel with a summary report',
    });
    expect(d.subtasks.length).toBeGreaterThanOrEqual(4);
    expect(d.report_format).toBe('xlsx');
  });

  it('all builtin_tool steps have builtin_tool_id', async () => {
    const d = await decomposeTask({ userMessage: 'Run demand forecast and plan' });
    for (const step of d.subtasks) {
      if (step.workflow_type === 'builtin_tool') {
        expect(step.builtin_tool_id).toBeTruthy();
      }
    }
  });
});

// ── validateDecomposition ────────────────────────────────────────────────────

describe('validateDecomposition', () => {
  it('validates a correct decomposition', () => {
    const d = {
      subtasks: [
        { name: 'run_forecast', workflow_type: 'builtin_tool', depends_on: [] },
        { name: 'run_plan', workflow_type: 'builtin_tool', depends_on: ['run_forecast'] },
      ],
    };
    const { valid, errors } = validateDecomposition(d);
    expect(valid).toBe(true);
    expect(errors.length).toBe(0);
  });

  it('rejects empty subtasks', () => {
    const { valid } = validateDecomposition({ subtasks: [] });
    expect(valid).toBe(false);
  });

  it('rejects missing name', () => {
    const { valid, errors } = validateDecomposition({
      subtasks: [{ workflow_type: 'forecast', depends_on: [] }],
    });
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('missing name'))).toBe(true);
  });

  it('rejects unknown workflow_type', () => {
    const { valid, errors } = validateDecomposition({
      subtasks: [{ name: 'x', workflow_type: 'teleport', depends_on: [] }],
    });
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('unknown workflow_type'))).toBe(true);
  });

  it('accepts builtin_tool workflow_type', () => {
    const { valid } = validateDecomposition({
      subtasks: [{ name: 'run_forecast', workflow_type: 'builtin_tool', depends_on: [] }],
    });
    expect(valid).toBe(true);
  });

  it('rejects duplicate step names', () => {
    const { valid, errors } = validateDecomposition({
      subtasks: [
        { name: 'a', workflow_type: 'forecast', depends_on: [] },
        { name: 'a', workflow_type: 'plan', depends_on: [] },
      ],
    });
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('Duplicate'))).toBe(true);
  });
});

// ── topologicalSort ──────────────────────────────────────────────────────────

describe('topologicalSort', () => {
  it('sorts steps by dependency order', () => {
    const steps = [
      { name: 'report', workflow_type: 'report', depends_on: ['run_plan'] },
      { name: 'run_plan', workflow_type: 'builtin_tool', depends_on: ['run_forecast'] },
      { name: 'run_forecast', workflow_type: 'builtin_tool', depends_on: [] },
    ];

    const sorted = topologicalSort(steps);
    const names = sorted.map(s => s.name);
    expect(names.indexOf('run_forecast')).toBeLessThan(names.indexOf('run_plan'));
    expect(names.indexOf('run_plan')).toBeLessThan(names.indexOf('report'));
  });

  it('handles steps with no dependencies', () => {
    const steps = [
      { name: 'a', depends_on: [] },
      { name: 'b', depends_on: [] },
      { name: 'c', depends_on: [] },
    ];
    const sorted = topologicalSort(steps);
    expect(sorted.length).toBe(3);
  });

  it('handles diamond dependencies', () => {
    const steps = [
      { name: 'd', depends_on: ['b', 'c'] },
      { name: 'b', depends_on: ['a'] },
      { name: 'c', depends_on: ['a'] },
      { name: 'a', depends_on: [] },
    ];
    const sorted = topologicalSort(steps);
    const names = sorted.map(s => s.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('c'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('d'));
  });
});

// ── getCatalogSummary ───────────────────────────────────────────────────────

describe('getCatalogSummary', () => {
  it('returns a non-empty string with tool IDs', () => {
    const summary = getCatalogSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(100);
    expect(summary).toContain('run_forecast');
    expect(summary).toContain('run_plan');
  });
});
