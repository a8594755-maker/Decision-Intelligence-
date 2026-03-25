// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabaseClient', () => ({ supabase: null }));

// Polyfill localStorage for Node/test environment
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
  buildGenerationPrompt,
  generateAndExecuteTool,
  executeRegisteredTool,
} from './dynamicToolExecutor';
import { registerTool, updateQualityScore, getToolById } from '../ai-infra/toolRegistryService';

beforeEach(() => {
  localStorage.clear();
});

// ── buildGenerationPrompt ────────────────────────────────────────────────────

describe('buildGenerationPrompt', () => {
  it('includes tool hint', () => {
    const prompt = buildGenerationPrompt({ toolHint: 'lead time prediction model' });
    expect(prompt).toContain('lead time prediction model');
  });

  it('includes dataset info when provided', () => {
    const prompt = buildGenerationPrompt({
      toolHint: 'analysis',
      datasetProfile: { columns: ['date', 'qty', 'plant_id'] },
    });
    expect(prompt).toContain('date');
    expect(prompt).toContain('qty');
  });

  it('includes revision instructions', () => {
    const prompt = buildGenerationPrompt({
      toolHint: 'fix this',
      revisionInstructions: ['Add cross-validation', 'Reduce features'],
    });
    expect(prompt).toContain('Add cross-validation');
    expect(prompt).toContain('Reduce features');
    expect(prompt).toContain('REVISION INSTRUCTIONS');
  });

  it('includes prior artifacts', () => {
    const prompt = buildGenerationPrompt({
      toolHint: 'plan',
      priorArtifacts: { forecast: [{ type: 'forecast_series' }] },
    });
    expect(prompt).toContain('forecast');
    expect(prompt).toContain('forecast_series');
  });
});

// ── generateAndExecuteTool ───────────────────────────────────────────────────

describe('generateAndExecuteTool', () => {
  it('executes valid code and returns result', async () => {
    const code = `
      function run(input) {
        const total = input.values.reduce((s, v) => s + v, 0);
        return {
          result: { total, avg: total / input.values.length },
          artifacts: [{ type: 'summary', label: 'stats', data: { total } }],
          metadata: { description: 'Computed sum and average' },
        };
      }
    `;

    const result = await generateAndExecuteTool({
      code,
      toolHint: 'compute statistics',
      inputData: { values: [10, 20, 30] },
    });

    expect(result.output).toBeTruthy();
    expect(result.output.result.total).toBe(60);
    expect(result.output.result.avg).toBe(20);
    expect(result.artifact_refs.length).toBe(1);
    expect(result.artifact_refs[0].type).toBe('summary');
    expect(result.execution_log.status).toBe('success');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles code errors gracefully', async () => {
    const code = `function run(input) { return input.foo.bar.baz; }`;

    const result = await generateAndExecuteTool({
      code,
      toolHint: 'broken tool',
      inputData: {},
    });

    expect(result.output).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.execution_log.status).toBe('error');
  });

  it('handles code with no artifacts', async () => {
    const code = `function run(input) { return { result: input.x * 2 }; }`;

    const result = await generateAndExecuteTool({
      code,
      toolHint: 'double',
      inputData: { x: 21 },
    });

    expect(result.output.result).toBe(42);
    expect(result.artifact_refs.length).toBe(0);
    expect(result.execution_log.status).toBe('success');
  });

  it('passes prior artifacts in sandbox input', async () => {
    const code = `
      function run(input) {
        const hasPrior = Object.keys(input._prior_artifacts || {}).length > 0;
        return { result: { hasPrior } };
      }
    `;

    const result = await generateAndExecuteTool({
      code,
      inputData: {},
      priorArtifacts: { forecast: [{ type: 'forecast_series' }] },
    });

    expect(result.output.result.hasPrior).toBe(true);
  });

  it('records execution log with code_hash', async () => {
    const code = `function run() { return { result: 1 }; }`;

    const result = await generateAndExecuteTool({ code });

    expect(result.execution_log.code_hash).toBeTruthy();
    expect(result.execution_log.code_length).toBe(code.length);
    expect(result.execution_log.started_at).toBeTruthy();
    expect(typeof result.execution_log.duration_ms).toBe('number');
  });

  it('handles code that returns nothing', async () => {
    const code = `function run() { /* no return */ }`;

    const result = await generateAndExecuteTool({ code });

    expect(result.output).toBeTruthy();
    expect(result.artifact_refs.length).toBe(0);
    expect(result.execution_log.status).toBe('success');
  });
});

// ── executeRegisteredTool ────────────────────────────────────────────────────

describe('executeRegisteredTool', () => {
  it('executes an active registered tool', async () => {
    const tool = await registerTool({
      name: 'Multiplier',
      category: 'transform',
      code: `function run(input) { return { result: input.x * input.y }; }`,
      approvedBy: 'manager-1',
    });
    await updateQualityScore(tool.id, 0.9);

    const result = await executeRegisteredTool(tool.id, { x: 7, y: 6 });

    expect(result.output.result).toBe(42);
    expect(result.execution_log.tool_id).toBe(tool.id);
    expect(result.execution_log.tool_name).toBe('Multiplier');

    // Check usage incremented
    const updated = await getToolById(tool.id);
    expect(updated.usage_count).toBe(1);
  });

  it('returns error for nonexistent tool', async () => {
    const result = await executeRegisteredTool('nonexistent');

    expect(result.error).toContain('not found');
    expect(result.output).toBeNull();
  });

  it('returns error for deprecated tool', async () => {
    const tool = await registerTool({
      name: 'Old Tool',
      category: 'custom',
      code: `function run() { return { result: 'old' }; }`,
      approvedBy: 'u1',
    });
    const { deprecateTool } = await import('../ai-infra/toolRegistryService');
    await deprecateTool(tool.id);

    const result = await executeRegisteredTool(tool.id);

    expect(result.error).toContain('deprecated');
  });
});
