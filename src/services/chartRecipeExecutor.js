/**
 * chartRecipeExecutor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes chart recipes by sending pre-written Python code to /execute-tool.
 *
 * Key advantage: skips LLM code generation entirely → ~2s instead of ~15s.
 * The /execute-tool endpoint supports `code` field (tool_executor.py:78) which
 * bypasses the LLM generation step.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getRecipeById } from './chartRecipeCatalog.js';

const ML_API_BASE = String(import.meta.env.VITE_ML_API_BASE || 'http://localhost:8000');

function extractAnalysisArtifacts(responseData) {
  const topLevel = Array.isArray(responseData?.artifacts) ? responseData.artifacts : [];
  if (topLevel.length > 0) return topLevel;

  const nested = Array.isArray(responseData?.result?.artifacts) ? responseData.result.artifacts : [];
  return nested;
}

/**
 * Execute a chart recipe.
 *
 * @param {object} opts
 * @param {string} opts.recipe_id  — Recipe identifier from the catalog
 * @param {object} [opts.params]   — Optional parameter overrides
 * @param {string} [opts.dataset]  — Dataset to use (default: 'olist')
 * @returns {Promise<{ success: boolean, result?: object, error?: string }>}
 */
export async function executeChartRecipe({ recipe_id, params, dataset } = {}) {
  const recipe = getRecipeById(recipe_id);
  if (!recipe) {
    throw new Error(`Unknown chart recipe: "${recipe_id}". Check recipe catalog for valid IDs.`);
  }

  if (!recipe.pythonCode) {
    throw new Error(`Recipe "${recipe_id}" has no Python code.`);
  }

  try {
    const body = {
      tool_hint: recipe.description,
      code: recipe.pythonCode,
      analysis_mode: true,
      dataset: dataset || 'olist',
      input_data: { recipe_params: params || {} },
    };

    const resp = await fetch(`${ML_API_BASE}/execute-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(60_000) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        success: false,
        error: `Chart recipe execution failed (${resp.status}): ${text.slice(0, 500)}`,
        toolId: 'generate_chart',
      };
    }

    const data = await resp.json();
    if (!data.ok) {
      return {
        success: false,
        error: data.error || 'Chart recipe returned not ok',
        toolId: 'generate_chart',
      };
    }

    // Support both the canonical backend shape ({ artifacts: [...] }) and the
    // current legacy recipe shape ({ result: { artifacts: [...] } }).
    const artifacts = extractAnalysisArtifacts(data);
    const dataSourceLabel = dataset || 'olist';
    const analysisResults = artifacts
      .filter(a => a.type === 'analysis_result')
      .map(a => {
        const card = a.data;
        if (card && typeof card === 'object') {
          if (dataSourceLabel) card._dataSource = dataSourceLabel;
          card._executionMeta = {
            recipe_id,
            execution_ms: data.execution_ms,
            engine: 'Python (pre-written recipe)',
          };
        }
        return card;
      });

    return {
      success: true,
      result: analysisResults.length === 1 ? analysisResults[0] : { analyses: analysisResults, count: analysisResults.length },
      toolId: 'generate_chart',
      artifactTypes: ['analysis_result'],
      _analysisCards: analysisResults,
    };
  } catch (err) {
    console.error('[chartRecipeExecutor] Failed:', err);
    return {
      success: false,
      error: `Chart recipe failed: ${err.message}`,
      toolId: 'generate_chart',
    };
  }
}
