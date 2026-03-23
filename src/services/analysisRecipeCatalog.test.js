import { describe, it, expect } from 'vitest';
import {
  RECIPE_CATALOG,
  selectRecipe,
  buildRecipePrompt,
} from './analysisRecipeCatalog.js';

// ── RECIPE_CATALOG ──────────────────────────────────────────────────────────

describe('RECIPE_CATALOG', () => {
  it('contains at least 2 recipes', () => {
    expect(RECIPE_CATALOG.length).toBeGreaterThanOrEqual(2);
  });

  it('each recipe has required fields', () => {
    for (const recipe of RECIPE_CATALOG) {
      expect(recipe.id).toBeTruthy();
      expect(recipe.domain).toBeTruthy();
      expect(recipe.triggerConcepts).toBeInstanceOf(Array);
      expect(recipe.triggerTaskTypes).toBeInstanceOf(Array);
      expect(recipe.steps).toBeInstanceOf(Array);
      expect(recipe.steps.length).toBeGreaterThan(0);
      for (const step of recipe.steps) {
        expect(step.id).toBeTruthy();
        expect(step.tool).toBeTruthy();
        expect(step.title).toBeTruthy();
        expect(step.instructions).toBeTruthy();
      }
    }
  });

  it('safety_stock_optimization has 8 steps (including visualization and excel)', () => {
    const recipe = RECIPE_CATALOG.find(r => r.id === 'safety_stock_optimization');
    expect(recipe).toBeTruthy();
    expect(recipe.steps).toHaveLength(8);
    // Verify visualization step exists and uses generate_chart
    const vizStep = recipe.steps.find(s => s.id === 'visualization');
    expect(vizStep).toBeTruthy();
    expect(vizStep.tool).toBe('run_python_analysis');
  });

  it('no recipe contains Olist-specific references', () => {
    const olistPatterns = /\bolist\b/i;
    for (const recipe of RECIPE_CATALOG) {
      for (const step of recipe.steps) {
        expect(olistPatterns.test(step.instructions), `Step "${step.id}" in "${recipe.id}" mentions Olist`).toBe(false);
      }
      for (const disclosure of recipe.proxyDisclosures || []) {
        expect(olistPatterns.test(disclosure), `Proxy disclosure in "${recipe.id}" mentions Olist`).toBe(false);
      }
    }
  });
});

// ── selectRecipe ────────────────────────────────────────────────────────────

describe('selectRecipe', () => {
  it('selects safety_stock_optimization for safety_stock + recommendation', () => {
    const recipe = selectRecipe('supply_chain', ['safety_stock'], 'recommendation');
    expect(recipe).toBeTruthy();
    expect(recipe.id).toBe('safety_stock_optimization');
  });

  it('selects safety_stock_optimization for reorder_point + diagnostic', () => {
    const recipe = selectRecipe('supply_chain', ['reorder_point'], 'diagnostic');
    expect(recipe).toBeTruthy();
    expect(recipe.id).toBe('safety_stock_optimization');
  });

  it('selects demand_classification for eoq + recommendation', () => {
    const recipe = selectRecipe('supply_chain', ['eoq'], 'recommendation');
    expect(recipe).toBeTruthy();
    expect(recipe.id).toBe('demand_classification');
  });

  it('prefers recipe with higher concept overlap', () => {
    // safety_stock + replenishment → safety_stock_optimization has 2 matches
    const recipe = selectRecipe('supply_chain', ['safety_stock', 'replenishment'], 'recommendation');
    expect(recipe).toBeTruthy();
    expect(recipe.id).toBe('safety_stock_optimization');
  });

  it('returns null for non-matching task type', () => {
    const recipe = selectRecipe('supply_chain', ['safety_stock'], 'lookup');
    expect(recipe).toBeNull();
  });

  it('returns null for non-matching domain', () => {
    const recipe = selectRecipe('finance', ['safety_stock'], 'recommendation');
    expect(recipe).toBeNull();
  });

  it('returns null for null domain', () => {
    expect(selectRecipe(null, [], 'recommendation')).toBeNull();
  });

  it('returns null for empty concepts', () => {
    expect(selectRecipe('supply_chain', [], 'recommendation')).toBeNull();
  });

  it('handles null matchedConcepts gracefully', () => {
    expect(selectRecipe('supply_chain', null, 'recommendation')).toBeNull();
  });

  it('matches when taskType is null (no filter)', () => {
    const recipe = selectRecipe('supply_chain', ['safety_stock'], null);
    expect(recipe).toBeTruthy();
    expect(recipe.id).toBe('safety_stock_optimization');
  });
});

// ── buildRecipePrompt ───────────────────────────────────────────────────────

describe('buildRecipePrompt', () => {
  const recipe = RECIPE_CATALOG.find(r => r.id === 'safety_stock_optimization');

  it('includes methodology title', () => {
    const prompt = buildRecipePrompt(recipe);
    expect(prompt).toContain('Prescribed Analysis Methodology');
    expect(prompt).toContain('Safety Stock');
  });

  it('includes all step titles and tools', () => {
    const prompt = buildRecipePrompt(recipe);
    expect(prompt).toContain('Step 1: Data Assessment (tool: query_sap_data)');
    expect(prompt).toContain('Step 2: Stationarity Check');
    expect(prompt).toContain('run_python_analysis');
    expect(prompt).toContain('Step 7: Key Visualizations (tool: run_python_analysis)');
    expect(prompt).toContain('Step 8: Excel Report Generation');
    expect(prompt).toContain('generate_analysis_workbook');
  });

  it('includes tool selection guidance for Python steps', () => {
    const prompt = buildRecipePrompt(recipe);
    expect(prompt).toContain('MUST use run_python_analysis');
    expect(prompt).toContain('SQL (query_sap_data) is for data retrieval only');
  });

  it('includes canonical formulas', () => {
    const prompt = buildRecipePrompt(recipe);
    expect(prompt).toContain('CANONICAL FORMULAS');
    expect(prompt).toContain('SS = Z × √(LT × σ²_d + d̄² × σ²_LT)');
    expect(prompt).toContain('ROP = d̄ × LT + SS');
  });

  it('includes proxy disclosures', () => {
    const prompt = buildRecipePrompt(recipe);
    expect(prompt).toContain('MANDATORY PROXY DISCLOSURES');
    expect(prompt).toContain('lead time');
    expect(prompt).toContain('sensitivity analysis');
  });

  it('includes iteration budget', () => {
    const prompt = buildRecipePrompt(recipe);
    expect(prompt).toContain('ITERATION BUDGET');
  });

  it('returns empty string for null recipe', () => {
    expect(buildRecipePrompt(null)).toBe('');
  });
});
