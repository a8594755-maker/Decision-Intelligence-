// @product: ai-employee
import { describe, it, expect } from 'vitest';

import {
  BUILTIN_TOOLS,
  TOOL_CATEGORY,
  getBuiltinTool,
  listBuiltinTools,
  findToolsByQuery,
  buildCatalogPromptSummary,
  resolveDependencies,
  isPythonApiTool,
} from './builtinToolCatalog';

// ── Catalog integrity ───────────────────────────────────────────────────────

describe('BUILTIN_TOOLS catalog', () => {
  it('has at least 15 tools', () => {
    expect(BUILTIN_TOOLS.length).toBeGreaterThanOrEqual(15);
  });

  it('all tools have required fields', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.category).toBeTruthy();
      expect(tool.module).toBeTruthy();
      expect(tool.method).toBeTruthy();
      expect(tool.tier).toMatch(/^tier_[abc]$/);
      expect(Array.isArray(tool.keywords_en)).toBe(true);
      expect(Array.isArray(tool.keywords_zh)).toBe(true);
      expect(Array.isArray(tool.output_artifacts)).toBe(true);
      expect(Array.isArray(tool.depends_on)).toBe(true);
      expect(typeof tool.needs_dataset_profile).toBe('boolean');
    }
  });

  it('has unique tool IDs', () => {
    const ids = BUILTIN_TOOLS.map(t => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('dependencies reference valid tool IDs', () => {
    const ids = new Set(BUILTIN_TOOLS.map(t => t.id));
    for (const tool of BUILTIN_TOOLS) {
      for (const dep of tool.depends_on) {
        expect(ids.has(dep)).toBe(true);
      }
    }
  });

  it('has all expected categories', () => {
    const cats = new Set(BUILTIN_TOOLS.map(t => t.category));
    expect(cats.has(TOOL_CATEGORY.CORE_PLANNING)).toBe(true);
    expect(cats.has(TOOL_CATEGORY.RISK)).toBe(true);
    expect(cats.has(TOOL_CATEGORY.SCENARIO)).toBe(true);
    expect(cats.has(TOOL_CATEGORY.NEGOTIATION)).toBe(true);
  });
});

// ── getBuiltinTool ──────────────────────────────────────────────────────────

describe('getBuiltinTool', () => {
  it('returns tool by ID', () => {
    const tool = getBuiltinTool('run_forecast');
    expect(tool).toBeTruthy();
    expect(tool.name).toBe('Demand Forecast');
  });

  it('returns null for unknown ID', () => {
    expect(getBuiltinTool('nonexistent')).toBeNull();
  });
});

// ── listBuiltinTools ────────────────────────────────────────────────────────

describe('listBuiltinTools', () => {
  it('returns all tools without filter', () => {
    const all = listBuiltinTools();
    expect(all.length).toBe(BUILTIN_TOOLS.length);
  });

  it('filters by category', () => {
    const risk = listBuiltinTools({ category: TOOL_CATEGORY.RISK });
    expect(risk.length).toBeGreaterThanOrEqual(2);
    expect(risk.every(t => t.category === TOOL_CATEGORY.RISK)).toBe(true);
  });
});

// ── findToolsByQuery ────────────────────────────────────────────────────────

describe('findToolsByQuery', () => {
  it('finds forecast tool by English keyword', () => {
    const results = findToolsByQuery('demand forecast');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('run_forecast');
  });

  it('finds plan tool by Chinese keyword', () => {
    const results = findToolsByQuery('補貨計畫');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(t => t.id === 'run_plan')).toBe(true);
  });

  it('finds BOM tool', () => {
    const results = findToolsByQuery('BOM explosion component');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('run_bom_explosion');
  });

  it('finds negotiation tool', () => {
    const results = findToolsByQuery('supplier negotiation');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('run_negotiation');
  });

  it('finds risk tool by Chinese', () => {
    const results = findToolsByQuery('風險評估');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(t => t.category === TOOL_CATEGORY.RISK)).toBe(true);
  });

  it('finds cost forecast tool', () => {
    const results = findToolsByQuery('cost forecast procurement');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(t => t.id === 'run_cost_forecast')).toBe(true);
  });

  it('finds simulation tool', () => {
    const results = findToolsByQuery('monte carlo simulation');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('run_simulation');
  });

  it('returns empty for empty query', () => {
    expect(findToolsByQuery('')).toEqual([]);
    expect(findToolsByQuery(null)).toEqual([]);
  });

  it('respects maxResults', () => {
    const results = findToolsByQuery('plan forecast risk', { maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters by category', () => {
    const results = findToolsByQuery('forecast', { category: TOOL_CATEGORY.CORE_PLANNING });
    expect(results.every(t => t.category === TOOL_CATEGORY.CORE_PLANNING)).toBe(true);
  });
});

// ── resolveDependencies ─────────────────────────────────────────────────────

describe('resolveDependencies', () => {
  it('returns tool with no deps', () => {
    const result = resolveDependencies(['run_risk_analysis']);
    expect(result).toEqual(['run_risk_analysis']);
  });

  it('includes forecast dependency for plan', () => {
    const result = resolveDependencies(['run_plan']);
    expect(result.indexOf('run_forecast')).toBeLessThan(result.indexOf('run_plan'));
  });

  it('resolves transitive dependencies', () => {
    const result = resolveDependencies(['run_cost_forecast']);
    // cost_forecast → run_plan → run_forecast
    expect(result.indexOf('run_forecast')).toBeLessThan(result.indexOf('run_plan'));
    expect(result.indexOf('run_plan')).toBeLessThan(result.indexOf('run_cost_forecast'));
  });

  it('deduplicates when multiple tools share deps', () => {
    const result = resolveDependencies(['run_plan', 'run_risk_aware_plan']);
    const forecastCount = result.filter(id => id === 'run_forecast').length;
    expect(forecastCount).toBe(1);
  });

  it('handles unknown tool IDs gracefully', () => {
    const result = resolveDependencies(['nonexistent', 'run_forecast']);
    expect(result).toContain('run_forecast');
  });
});

// ── buildCatalogPromptSummary ───────────────────────────────────────────────

describe('buildCatalogPromptSummary', () => {
  it('returns a string with all tool IDs', () => {
    const summary = buildCatalogPromptSummary();
    expect(typeof summary).toBe('string');
    expect(summary).toContain('run_forecast');
    expect(summary).toContain('run_plan');
    expect(summary).toContain('run_bom_explosion');
    expect(summary).toContain('run_negotiation');
  });

  it('includes dependency info', () => {
    const summary = buildCatalogPromptSummary();
    expect(summary).toContain('[requires:');
  });
});

// ── isPythonApiTool ─────────────────────────────────────────────────────────

describe('isPythonApiTool', () => {
  it('returns true for Python tools', () => {
    expect(isPythonApiTool('run_ml_forecast')).toBe(true);
    expect(isPythonApiTool('run_lp_solver')).toBe(true);
    expect(isPythonApiTool('run_simulation')).toBe(true);
  });

  it('returns false for JS tools', () => {
    expect(isPythonApiTool('run_forecast')).toBe(false);
    expect(isPythonApiTool('run_plan')).toBe(false);
  });

  it('returns false for unknown tool', () => {
    expect(isPythonApiTool('nonexistent')).toBe(false);
  });
});
