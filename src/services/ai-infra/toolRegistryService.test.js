// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabaseClient
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
  TOOL_CATEGORIES,
  TOOL_STATUS,
  hashCode,
  registerTool,
  findToolByHint,
  getToolById,
  listTools,
  approveTool,
  deprecateTool,
  incrementUsage,
  updateQualityScore,
} from './toolRegistryService';

beforeEach(() => {
  localStorage.clear();
});

// ── Constants ────────────────────────────────────────────────────────────────

describe('TOOL_CATEGORIES', () => {
  it('has all expected categories', () => {
    expect(TOOL_CATEGORIES.SOLVER).toBe('solver');
    expect(TOOL_CATEGORIES.ML_MODEL).toBe('ml_model');
    expect(TOOL_CATEGORIES.TRANSFORM).toBe('transform');
    expect(TOOL_CATEGORIES.REPORT).toBe('report');
    expect(TOOL_CATEGORIES.ANALYSIS).toBe('analysis');
    expect(TOOL_CATEGORIES.CUSTOM).toBe('custom');
  });
});

describe('TOOL_STATUS', () => {
  it('has all expected statuses', () => {
    expect(TOOL_STATUS.DRAFT).toBe('draft');
    expect(TOOL_STATUS.ACTIVE).toBe('active');
    expect(TOOL_STATUS.DEPRECATED).toBe('deprecated');
  });
});

// ── hashCode ─────────────────────────────────────────────────────────────────

describe('hashCode', () => {
  it('returns a string hash for code', async () => {
    const hash = await hashCode('function add(a, b) { return a + b; }');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('returns same hash for same code', async () => {
    const code = 'const x = 42;';
    const h1 = await hashCode(code);
    const h2 = await hashCode(code);
    expect(h1).toBe(h2);
  });

  it('returns different hash for different code', async () => {
    const h1 = await hashCode('const a = 1;');
    const h2 = await hashCode('const a = 2;');
    expect(h1).not.toBe(h2);
  });
});

// ── registerTool ─────────────────────────────────────────────────────────────

describe('registerTool', () => {
  it('creates a draft tool by default', async () => {
    const tool = await registerTool({
      name: 'Lead Time Predictor',
      description: 'Predicts supplier lead times from delivery data',
      category: 'ml_model',
      code: 'function run(input) { return { result: 42 }; }',
    });

    expect(tool.id).toBeTruthy();
    expect(tool.name).toBe('Lead Time Predictor');
    expect(tool.category).toBe('ml_model');
    expect(tool.status).toBe('draft');
    expect(tool.usage_count).toBe(0);
    expect(tool.quality_score).toBe(0);
    expect(tool.approved_by).toBeNull();
    expect(tool.code_hash).toBeTruthy();
  });

  it('creates an active tool when approvedBy is provided', async () => {
    const tool = await registerTool({
      name: 'Sorter',
      category: 'transform',
      code: 'function run(input) { return input.sort(); }',
      approvedBy: 'user-1',
    });

    expect(tool.status).toBe('active');
    expect(tool.approved_by).toBe('user-1');
    expect(tool.approved_at).toBeTruthy();
  });

  it('stores tags', async () => {
    const tool = await registerTool({
      name: 'Risk Scorer',
      category: 'analysis',
      code: 'function run(input) { return { score: 0.5 }; }',
      tags: ['risk', 'scoring', 'supply-chain'],
    });

    expect(tool.tags).toEqual(['risk', 'scoring', 'supply-chain']);
  });
});

// ── getToolById ──────────────────────────────────────────────────────────────

describe('getToolById', () => {
  it('returns tool by id', async () => {
    const tool = await registerTool({
      name: 'Test Tool',
      category: 'custom',
      code: 'function run() {}',
    });

    const found = await getToolById(tool.id);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Test Tool');
  });

  it('returns null for nonexistent id', async () => {
    const found = await getToolById('nonexistent');
    expect(found).toBeNull();
  });
});

// ── listTools ────────────────────────────────────────────────────────────────

describe('listTools', () => {
  it('returns all tools', async () => {
    await registerTool({ name: 'Tool A', category: 'solver', code: 'a()' });
    await registerTool({ name: 'Tool B', category: 'report', code: 'b()' });

    const all = await listTools();
    expect(all.length).toBe(2);
  });

  it('filters by category', async () => {
    await registerTool({ name: 'Tool A', category: 'solver', code: 'a()' });
    await registerTool({ name: 'Tool B', category: 'report', code: 'b()' });

    const solvers = await listTools({ category: 'solver' });
    expect(solvers.length).toBe(1);
    expect(solvers[0].name).toBe('Tool A');
  });

  it('filters by status', async () => {
    await registerTool({ name: 'Draft', category: 'custom', code: 'd()' });
    await registerTool({ name: 'Active', category: 'custom', code: 'a()', approvedBy: 'u1' });

    const active = await listTools({ status: 'active' });
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('Active');
  });
});

// ── approveTool ──────────────────────────────────────────────────────────────

describe('approveTool', () => {
  it('transitions tool from draft to active', async () => {
    const tool = await registerTool({
      name: 'Pending Tool',
      category: 'transform',
      code: 'function run() {}',
    });
    expect(tool.status).toBe('draft');

    const approved = await approveTool(tool.id, 'manager-1', 0.85);
    expect(approved.status).toBe('active');
    expect(approved.approved_by).toBe('manager-1');
    expect(approved.quality_score).toBe(0.85);
  });

  it('returns null for nonexistent tool', async () => {
    const result = await approveTool('nonexistent', 'user-1');
    expect(result).toBeNull();
  });
});

// ── deprecateTool ────────────────────────────────────────────────────────────

describe('deprecateTool', () => {
  it('marks tool as deprecated', async () => {
    const tool = await registerTool({
      name: 'Old Tool',
      category: 'solver',
      code: 'function run() {}',
      approvedBy: 'u1',
    });

    const deprecated = await deprecateTool(tool.id);
    expect(deprecated.status).toBe('deprecated');
  });
});

// ── findToolByHint ───────────────────────────────────────────────────────────

describe('findToolByHint', () => {
  it('finds tool by keyword match', async () => {
    const tool = await registerTool({
      name: 'Lead Time Predictor',
      description: 'Predicts supplier lead times using delivery history',
      category: 'ml_model',
      code: 'function run(input) { return { result: 5 }; }',
      approvedBy: 'u1',
    });
    // Manually set quality_score high enough
    await updateQualityScore(tool.id, 0.85);

    const found = await findToolByHint('lead time prediction', 'ml_model');
    expect(found).toBeTruthy();
    expect(found.name).toBe('Lead Time Predictor');
  });

  it('returns null when no match', async () => {
    const found = await findToolByHint('quantum teleportation');
    expect(found).toBeNull();
  });

  it('returns null for empty hint', async () => {
    const found = await findToolByHint('');
    expect(found).toBeNull();
  });

  it('skips tools with low quality score', async () => {
    await registerTool({
      name: 'Bad Tool',
      description: 'Does prediction but poorly',
      category: 'ml_model',
      code: 'function run() { return null; }',
      approvedBy: 'u1',
    });
    // quality_score stays at 0

    const found = await findToolByHint('prediction');
    expect(found).toBeNull();
  });
});

// ── incrementUsage ───────────────────────────────────────────────────────────

describe('incrementUsage', () => {
  it('increments usage count', async () => {
    const tool = await registerTool({
      name: 'Counter',
      category: 'custom',
      code: 'function run() {}',
    });
    expect(tool.usage_count).toBe(0);

    await incrementUsage(tool.id);
    const updated = await getToolById(tool.id);
    expect(updated.usage_count).toBe(1);

    await incrementUsage(tool.id);
    const updated2 = await getToolById(tool.id);
    expect(updated2.usage_count).toBe(2);
  });
});

// ── updateQualityScore ───────────────────────────────────────────────────────

describe('updateQualityScore', () => {
  it('updates quality score', async () => {
    const tool = await registerTool({
      name: 'Scoreable',
      category: 'analysis',
      code: 'function run() {}',
    });

    await updateQualityScore(tool.id, 0.78);
    const updated = await getToolById(tool.id);
    expect(updated.quality_score).toBe(0.78);
  });

  it('clamps score to 0-1', async () => {
    const tool = await registerTool({
      name: 'Clamped',
      category: 'custom',
      code: 'function run() {}',
    });

    await updateQualityScore(tool.id, 1.5);
    const updated = await getToolById(tool.id);
    expect(updated.quality_score).toBe(1);

    await updateQualityScore(tool.id, -0.3);
    const updated2 = await getToolById(tool.id);
    expect(updated2.quality_score).toBe(0);
  });
});
