/**
 * chartRecipeCatalog.test.js — Tests for the chart recipe catalog
 */

import { describe, it, expect } from 'vitest';
import {
  CHART_RECIPES,
  RECIPE_CATEGORIES,
  getRecipeById,
  getRecipesByCategory,
  getRecipeCatalogForUI,
  getRecipeIndexForPrompt,
} from './chartRecipeCatalog.js';

describe('chartRecipeCatalog', () => {
  // ── Catalog Integrity ──────────────────────────────────────────────────

  it('should have exactly 50 recipes', () => {
    expect(CHART_RECIPES.length).toBe(50);
  });

  it('should have unique IDs for all recipes', () => {
    const ids = CHART_RECIPES.map(r => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every recipe should have required fields', () => {
    for (const recipe of CHART_RECIPES) {
      expect(recipe.id, `${recipe.id} missing id`).toBeTruthy();
      expect(recipe.name, `${recipe.id} missing name`).toBeTruthy();
      expect(recipe.name_zh, `${recipe.id} missing name_zh`).toBeTruthy();
      expect(recipe.category, `${recipe.id} missing category`).toBeTruthy();
      expect(recipe.description, `${recipe.id} missing description`).toBeTruthy();
      expect(recipe.chartType, `${recipe.id} missing chartType`).toBeTruthy();
      expect(recipe.pythonCode, `${recipe.id} missing pythonCode`).toBeTruthy();
      expect(Array.isArray(recipe.tags), `${recipe.id} tags should be array`).toBe(true);
    }
  });

  it('every recipe category should be in RECIPE_CATEGORIES', () => {
    const validCategories = new Set(RECIPE_CATEGORIES.map(c => c.id));
    for (const recipe of CHART_RECIPES) {
      expect(validCategories.has(recipe.category), `${recipe.id} has unknown category '${recipe.category}'`).toBe(true);
    }
  });

  it('every recipe pythonCode should contain def run(', () => {
    for (const recipe of CHART_RECIPES) {
      expect(recipe.pythonCode).toContain('def run(');
    }
  });

  it('every recipe pythonCode should return artifacts', () => {
    for (const recipe of CHART_RECIPES) {
      expect(
        recipe.pythonCode.includes('artifacts') || recipe.pythonCode.includes('"result"'),
        `${recipe.id} pythonCode should produce artifacts`
      ).toBe(true);
    }
  });

  // ── Category Distribution ─────────────────────────────────────────────

  it('should have 7 categories defined', () => {
    expect(RECIPE_CATEGORIES.length).toBe(7);
  });

  it('should have recipes in each category', () => {
    for (const cat of RECIPE_CATEGORIES) {
      const count = CHART_RECIPES.filter(r => r.category === cat.id).length;
      expect(count, `Category '${cat.id}' should have at least 1 recipe`).toBeGreaterThan(0);
    }
  });

  it('trend category should have 6 recipes', () => {
    expect(getRecipesByCategory('trend').length).toBe(6);
  });

  it('distribution category should have 8 recipes', () => {
    expect(getRecipesByCategory('distribution').length).toBe(8);
  });

  it('composition category should have 5 recipes', () => {
    expect(getRecipesByCategory('composition').length).toBe(5);
  });

  it('correlation category should have 7 recipes', () => {
    expect(getRecipesByCategory('correlation').length).toBe(7);
  });

  it('geo category should have 5 recipes', () => {
    expect(getRecipesByCategory('geo').length).toBe(5);
  });

  it('time_pattern category should have 4 recipes', () => {
    expect(getRecipesByCategory('time_pattern').length).toBe(4);
  });

  it('advanced category should have 15 recipes', () => {
    expect(getRecipesByCategory('advanced').length).toBe(15);
  });

  // ── Lookup Helpers ────────────────────────────────────────────────────

  it('getRecipeById should return recipe for valid ID', () => {
    const recipe = getRecipeById('monthly_revenue_order_trend');
    expect(recipe).toBeTruthy();
    expect(recipe.category).toBe('trend');
  });

  it('getRecipeById should return null for unknown ID', () => {
    expect(getRecipeById('nonexistent_recipe')).toBeNull();
  });

  it('getRecipeById should fuzzy-match LLM-hallucinated IDs', () => {
    // LLM added "order" → weekday_hour_order_heatmap instead of weekday_hour_heatmap
    const recipe = getRecipeById('weekday_hour_order_heatmap');
    expect(recipe).toBeTruthy();
    expect(recipe.id).toBe('weekday_hour_heatmap');
  });

  it('getRecipeById should not fuzzy-match with only 1 token overlap', () => {
    // "revenue" alone overlaps many recipes — should not match
    expect(getRecipeById('revenue')).toBeNull();
  });

  it('getRecipeCatalogForUI should exclude pythonCode', () => {
    const uiCatalog = getRecipeCatalogForUI();
    expect(uiCatalog.length).toBe(50);
    for (const r of uiCatalog) {
      expect(r.pythonCode).toBeUndefined();
      expect(r.id).toBeTruthy();
      expect(r.name).toBeTruthy();
    }
  });

  // ── Prompt Index ──────────────────────────────────────────────────────

  it('getRecipeIndexForPrompt should return compact text', () => {
    const index = getRecipeIndexForPrompt();
    expect(typeof index).toBe('string');
    expect(index.length).toBeGreaterThan(100);
    expect(index.length).toBeLessThan(5000); // Should be compact
    expect(index).toContain('generate_chart');
    expect(index).toContain('monthly_revenue_order_trend');
  });

  it('prompt index should list all 50 recipe IDs', () => {
    const index = getRecipeIndexForPrompt();
    for (const recipe of CHART_RECIPES) {
      expect(index, `Missing recipe ${recipe.id} in prompt index`).toContain(recipe.id);
    }
  });

  // ── Chart Types ───────────────────────────────────────────────────────

  it('should use valid chart types', () => {
    const validTypes = new Set([
      'line', 'bar', 'horizontal_bar', 'area', 'pie', 'donut',
      'scatter', 'bubble', 'stacked_bar', 'grouped_bar', 'histogram',
      'lorenz', 'heatmap', 'treemap', 'radar', 'funnel', 'sankey',
      'waterfall', 'pareto',
    ]);
    for (const recipe of CHART_RECIPES) {
      expect(
        validTypes.has(recipe.chartType),
        `${recipe.id} uses unknown chartType '${recipe.chartType}'`
      ).toBe(true);
    }
  });
});
