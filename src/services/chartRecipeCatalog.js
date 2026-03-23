/**
 * chartRecipeCatalog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified catalog of 50 predefined chart recipes.
 *
 * Each recipe contains:
 *   - Metadata (id, name, description, tags, chartType)
 *   - Pre-written Python code (executed via /execute-tool, no LLM generation)
 *
 * This catalog is consumed by:
 *   1. chartRecipeExecutor.js  — picks recipe → sends Python code to backend
 *   2. ChartCatalogPanel.jsx   — renders 50 clickable cards in the UI
 *   3. chatAgentLoop.js        — injects compact recipe index into LLM prompt
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { TREND_RECIPES } from './chartRecipes_trend.js';
import { DISTRIBUTION_RECIPES } from './chartRecipes_distribution.js';
import { COMPOSITION_RECIPES } from './chartRecipes_composition.js';
import { CORRELATION_RECIPES } from './chartRecipes_correlation.js';
import { GEO_RECIPES } from './chartRecipes_geo.js';
import { TIME_PATTERN_RECIPES } from './chartRecipes_timePattern.js';
import { ADVANCED_RECIPES } from './chartRecipes_advanced.js';

// ── Merged Catalog ──────────────────────────────────────────────────────────

export const CHART_RECIPES = Object.freeze([
  ...TREND_RECIPES,
  ...DISTRIBUTION_RECIPES,
  ...COMPOSITION_RECIPES,
  ...CORRELATION_RECIPES,
  ...GEO_RECIPES,
  ...TIME_PATTERN_RECIPES,
  ...ADVANCED_RECIPES,
]);

// ── Category Metadata ───────────────────────────────────────────────────────

export const RECIPE_CATEGORIES = Object.freeze([
  { id: 'trend',        name: 'Trends & Time Series',    name_zh: '趨勢與時間序列',     icon: 'TrendingUp' },
  { id: 'distribution', name: 'Distribution & Compare',  name_zh: '分布與比較',         icon: 'BarChart3' },
  { id: 'composition',  name: 'Composition & Share',     name_zh: '佔比與組成',         icon: 'PieChart' },
  { id: 'correlation',  name: 'Correlation & Relations', name_zh: '關聯與相關性',       icon: 'ScatterChart' },
  { id: 'geo',          name: 'Geographic',              name_zh: '地理空間',           icon: 'Globe' },
  { id: 'time_pattern', name: 'Time Patterns & Cycles',  name_zh: '時間模式與週期',     icon: 'Clock' },
  { id: 'advanced',     name: 'Advanced Analysis',       name_zh: '進階分析',           icon: 'Brain' },
]);

// ── Lookup Helpers ──────────────────────────────────────────────────────────

const _recipeMap = new Map(CHART_RECIPES.map(r => [r.id, r]));

/**
 * Find a recipe by ID. Falls back to fuzzy matching if exact ID not found
 * (LLMs sometimes hallucinate slight ID variations like adding/dropping words).
 * @param {string} recipeId
 * @returns {object|null}
 */
export function getRecipeById(recipeId) {
  if (!recipeId) return null;
  const exact = _recipeMap.get(recipeId);
  if (exact) return exact;

  // Fuzzy fallback: find the recipe whose ID has the highest token overlap
  const inputTokens = new Set(recipeId.split(/[_\-\s]+/).filter(Boolean));
  let bestMatch = null;
  let bestScore = 0;

  for (const [id, recipe] of _recipeMap) {
    const idTokens = id.split(/[_\-\s]+/);
    const overlap = idTokens.filter(t => inputTokens.has(t)).length;
    // Require at least 2 matching tokens and >50% overlap with the shorter ID
    const minLen = Math.min(idTokens.length, inputTokens.size);
    if (overlap >= 2 && overlap / minLen > 0.5 && overlap > bestScore) {
      bestScore = overlap;
      bestMatch = recipe;
    }
  }

  if (bestMatch) {
    console.info(`[chartRecipeCatalog] Fuzzy matched "${recipeId}" → "${bestMatch.id}"`);
  }
  return bestMatch;
}

/**
 * Get recipes for a given category.
 * @param {string} categoryId
 * @returns {object[]}
 */
export function getRecipesByCategory(categoryId) {
  return CHART_RECIPES.filter(r => r.category === categoryId);
}

/**
 * Get a lightweight catalog (no Python code) suitable for UI rendering.
 * @returns {object[]}
 */
export function getRecipeCatalogForUI() {
  return CHART_RECIPES.map(({ pythonCode, ...rest }) => rest);
}

/**
 * Build a compact recipe index string for injection into the LLM system prompt.
 * ~2KB — enough for the LLM to pick the right recipe_id.
 *
 * @returns {string}
 */
export function getRecipeIndexForPrompt() {
  const groups = {};
  for (const r of CHART_RECIPES) {
    if (!groups[r.category]) groups[r.category] = [];
    groups[r.category].push(r.id);
  }

  const lines = [
    '── Chart Recipe Catalog ──',
    'Call generate_chart(recipe_id) to generate any of these predefined charts.',
    'Each chart runs pre-written analysis on the loaded dataset.',
    '',
  ];

  for (const cat of RECIPE_CATEGORIES) {
    const ids = groups[cat.id] || [];
    lines.push(`${cat.name_zh} (${cat.name}):`);
    for (const id of ids) {
      const r = _recipeMap.get(id);
      const tags = (r.tags || []).join(',');
      lines.push(`  - ${id} [${r.chartType}]: ${r.name_zh}${tags ? ` (${tags})` : ''}`);
    }
    lines.push('');
  }

  lines.push('Pass optional params to customize (e.g., period, metric). Most recipes work without params.');
  return lines.join('\n');
}
