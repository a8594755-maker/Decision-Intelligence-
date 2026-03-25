/**
 * sapForecastBridgeService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic bridge: SQL query → forecast engine → compare actuals.
 *
 * Works with ANY data loaded into sapDataQueryService (Olist CSV, Supabase,
 * or any future data source). The LLM writes the SQL query that produces
 * demand_fg format; this service handles the rest.
 *
 * Required SQL output columns:
 *   material_code  — what to forecast (product category, SKU, etc.)
 *   plant_id       — location dimension (state, warehouse, etc.)
 *   time_bucket    — YYYY-MM format
 *   demand_qty     — numeric demand value
 *
 * Flow:
 *   1. Execute user-provided SQL via DuckDB → demand_fg rows
 *   2. Build synthetic datasetProfileRow with _inlineRawRows
 *   3. Call runForecastFromDatasetProfile()
 *   4. Optionally run a second SQL for actuals and compare
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { executeQuery } from '../sap-erp/sapDataQueryService.js';
import { runForecastFromDatasetProfile } from './chatForecastService.js';
import { callLLM } from '../ai-infra/aiEmployeeLLMService.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SHEET_NAME = 'sap_demand';
const MIN_DEMAND_ROWS = 8;
const REQUIRED_COLUMNS = ['material_code', 'plant_id', 'time_bucket', 'demand_qty'];

const ML_API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_ML_API_URL
  ? import.meta.env.VITE_ML_API_URL : 'http://localhost:8000';

// Valid model choices for the Python ML API
const VALID_MODELS = ['auto', 'compare', 'prophet', 'lightgbm', 'chronos', 'xgboost', 'ets', 'naive'];
const COMPARE_MODELS = ['prophet', 'lightgbm', 'chronos']; // Models to run in compare mode
const MODEL_LABELS = {
  auto: 'Auto (best fit)',
  compare: 'Multi-Model Comparison',
  prophet: 'Prophet',
  lightgbm: 'LightGBM',
  chronos: 'Chronos',
  xgboost: 'XGBoost',
  ets: 'ETS',
  naive: 'Naive (JS built-in)',
};

// ── Default SQL Templates (Olist) ───────────────────────────────────────────

function defaultTrainingSql(start, end, groupBy) {
  if (groupBy === 'seller_state') {
    return `
      SELECT
        s.seller_state AS material_code,
        'BR' AS plant_id,
        SUBSTR(o.order_purchase_timestamp, 1, 7) AS time_bucket,
        COUNT(*) AS demand_qty
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN sellers s ON oi.seller_id = s.seller_id
      WHERE o.order_status = 'delivered'
        AND SUBSTR(o.order_purchase_timestamp, 1, 7) >= '${escapeStr(start)}'
        AND SUBSTR(o.order_purchase_timestamp, 1, 7) <= '${escapeStr(end)}'
      GROUP BY s.seller_state, SUBSTR(o.order_purchase_timestamp, 1, 7)
      ORDER BY s.seller_state, SUBSTR(o.order_purchase_timestamp, 1, 7)
    `;
  }
  return `
    SELECT
      p.product_category_name AS material_code,
      'BR' AS plant_id,
      SUBSTR(o.order_purchase_timestamp, 1, 7) AS time_bucket,
      COUNT(*) AS demand_qty
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.order_id
    JOIN products p ON oi.product_id = p.product_id
    WHERE o.order_status = 'delivered'
      AND SUBSTR(o.order_purchase_timestamp, 1, 7) >= '${escapeStr(start)}'
      AND SUBSTR(o.order_purchase_timestamp, 1, 7) <= '${escapeStr(end)}'
      AND p.product_category_name IS NOT NULL
    GROUP BY p.product_category_name, SUBSTR(o.order_purchase_timestamp, 1, 7)
    ORDER BY p.product_category_name, SUBSTR(o.order_purchase_timestamp, 1, 7)
  `;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run forecast from any SAP data via SQL.
 *
 * The LLM provides a SQL query that returns demand_fg-format rows.
 * If no SQL is provided, falls back to Olist default query.
 *
 * @param {object} params
 * @param {string} [params.demand_sql]      - SQL that returns (material_code, plant_id, time_bucket, demand_qty). If omitted, uses Olist default.
 * @param {string} [params.actuals_sql]     - SQL for actual data to compare against. If omitted and compare_actuals=true, auto-generates from demand_sql with shifted dates.
 * @param {string} [params.training_start]  - YYYY-MM start (used for default SQL only), default '2017-01'
 * @param {string} [params.training_end]    - YYYY-MM end (used for default SQL only), default '2017-12'
 * @param {number} [params.forecast_months] - Months to forecast, default 6
 * @param {boolean} [params.compare_actuals] - Compare with actual data, default true
 * @param {string} [params.group_by]        - 'category' or 'seller_state' (for default SQL only), default 'category'
 * @param {number} [params.top_n]           - Top N groups by volume, default 15
 * @param {string} [params.userId]          - User ID (injected by tool adapter)
 * @returns {Promise<object>}
 */
export async function forecastFromSapData({
  demand_sql = null,
  actuals_sql = null,
  training_start = '2017-01',
  training_end = '2017-12',
  forecast_months = 6,
  compare_actuals = true,
  group_by = 'category',
  top_n = 15,
  forecast_model = 'auto',
  userId = 'system',
  user_query = '',
} = {}) {
  // Normalize model choice
  const model = VALID_MODELS.includes(forecast_model?.toLowerCase()) ? forecast_model.toLowerCase() : 'auto';
  console.log('[sapForecastBridge] Starting with params:', {
    has_custom_sql: !!demand_sql, training_start, training_end, forecast_months, compare_actuals, group_by, top_n, model
  });

  // ── Step 1: Query demand data ──
  const trainingSql = demand_sql || defaultTrainingSql(training_start, training_end, group_by);
  const rawResult = await executeQuery({ sql: trainingSql });
  if (!rawResult.success) {
    return { success: false, error: `SQL execution failed: ${rawResult.error}`, sql_used: trainingSql.trim() };
  }
  if (rawResult.truncated) {
    console.warn(`[sapForecastBridge] ⚠️ Query result was truncated: ${rawResult.rowCount} total rows, only ${rawResult.rows.length} returned`);
  }
  const demandRows = (rawResult.rows || [])
    .map(row => ({
      material_code: String(row.material_code || '').trim(),
      plant_id: String(row.plant_id || 'DEFAULT').trim(),
      time_bucket: String(row.time_bucket || '').trim(),
      demand_qty: Number(row.demand_qty) || 0,
    }))
    .filter(row => row.material_code && row.time_bucket && row.demand_qty > 0);

  if (demandRows.length < MIN_DEMAND_ROWS) {
    return {
      success: false,
      error: `Insufficient demand data: only ${demandRows.length} rows found. Need at least ${MIN_DEMAND_ROWS}.`,
      hint: 'Try expanding the date range, using a broader grouping, or check your SQL returns rows with columns: material_code, plant_id, time_bucket, demand_qty.',
      sql_used: trainingSql.trim(),
    };
  }

  console.log(`[sapForecastBridge] Got ${demandRows.length} demand rows (total in DB: ${rawResult.rowCount})`);

  // ── Filter to top N groups ──
  const groupTotals = new Map();
  for (const row of demandRows) {
    const key = row.material_code;
    groupTotals.set(key, (groupTotals.get(key) || 0) + row.demand_qty);
  }
  const topGroups = new Set(
    [...groupTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top_n)
      .map(([k]) => k)
  );
  const filteredRows = demandRows.filter(r => topGroups.has(r.material_code));

  console.log(`[sapForecastBridge] Filtered to top ${top_n} groups: ${filteredRows.length} rows`);

  // ── Step 2: Run forecast ──
  let forecastResult;
  let usedModel = model;
  let multiModelResults = null; // For compare mode

  if (model === 'compare') {
    // ── Compare mode: run models sequentially to avoid rate-limit (each model does N serial API calls) ──
    console.log(`[sapForecastBridge] Compare mode: running ${COMPARE_MODELS.join(', ')} sequentially`);
    multiModelResults = {};
    let firstSuccess = null;
    const failures = [];
    for (const modelName of COMPARE_MODELS) {
      try {
        const val = await runMlApiForecast({
          rows: filteredRows, topGroups, model: modelName, forecast_months, training_start, training_end,
        });
        const groupCount = val?.groups?.length || val?.forecast_series?.groups?.length || 0;
        console.log(`[sapForecastBridge] ✅ ${modelName} succeeded — ${groupCount} groups`);
        multiModelResults[modelName] = val;
        if (!firstSuccess) firstSuccess = val;
      } catch (err) {
        const errMsg = err?.message || 'Unknown error';
        console.warn(`[sapForecastBridge] ❌ ${modelName} failed: ${errMsg}`);
        failures.push(`${modelName}: ${errMsg}`);
        multiModelResults[modelName] = null;
      }
    }
    if (!firstSuccess) {
      return { success: false, error: `All models failed in compare mode: ${failures.join('; ')}`, demandRowCount: filteredRows.length };
    }
    forecastResult = firstSuccess; // Use first successful result for comparison structure
    usedModel = 'compare';
  } else if (model === 'naive') {
    // Use JS built-in naive/MA models
    const profileRow = buildSyntheticProfile({ rows: filteredRows, training_start, training_end, userId });
    try {
      forecastResult = await runForecastFromDatasetProfile({
        userId, datasetProfileRow: profileRow, horizonPeriods: forecast_months, settings: {},
      });
    } catch (err) {
      return { success: false, error: `Forecast engine error: ${err.message}`, demandRowCount: filteredRows.length, uniqueGroups: topGroups.size };
    }
    usedModel = 'naive';
  } else {
    // Use Python ML API (single model: Prophet/LightGBM/Chronos/Auto)
    try {
      forecastResult = await runMlApiForecast({
        rows: filteredRows, topGroups, model, forecast_months, training_start, training_end,
      });
      usedModel = forecastResult._usedModel || model;
    } catch (err) {
      console.warn(`[sapForecastBridge] ML API failed (${err.message}), falling back to JS naive`);
      const profileRow = buildSyntheticProfile({ rows: filteredRows, training_start, training_end, userId });
      try {
        forecastResult = await runForecastFromDatasetProfile({
          userId, datasetProfileRow: profileRow, horizonPeriods: forecast_months, settings: {},
        });
        usedModel = 'naive (fallback)';
      } catch (fallbackErr) {
        return { success: false, error: `Forecast failed: ML API: ${err.message}, JS fallback: ${fallbackErr.message}` };
      }
    }
  }

  // ── Step 4: Compare with actuals ──
  let comparison = null;
  if (compare_actuals) {
    const forecastStart = nextMonth(training_end);
    const forecastEnd = addMonths(forecastStart, forecast_months - 1);

    if (actuals_sql) {
      // User provided custom actuals SQL
      comparison = await compareWithCustomSql({ forecastResult, actualsSql: actuals_sql, topGroups });
    } else if (!demand_sql) {
      // Using default Olist SQL — auto-generate actuals query
      const autoActualsSql = defaultTrainingSql(forecastStart, forecastEnd, group_by);
      comparison = await compareWithCustomSql({ forecastResult, actualsSql: autoActualsSql, topGroups });
    } else {
      comparison = {
        available: false,
        message: 'Custom demand_sql was provided but no actuals_sql. Provide actuals_sql to enable comparison.',
      };
    }
  }

  // ── Build artifacts for inline chat rendering ──
  const artifacts = [];

  // Model info artifact (for UI display)
  artifacts.push({
    artifact_type: 'metadata',
    label: `Forecast Model: ${MODEL_LABELS[usedModel] || usedModel}`,
    data: [{ model: usedModel, label: MODEL_LABELS[usedModel] || usedModel }],
  });

  // Demand summary table
  const demandSummaryRows = [...topGroups].map(group => {
    const rows = filteredRows.filter(r => r.material_code === group);
    const total = rows.reduce((s, r) => s + r.demand_qty, 0);
    const months = new Set(rows.map(r => r.time_bucket)).size;
    return { group, total_demand: total, months, avg_monthly: Math.round(total / Math.max(months, 1)) };
  });
  artifacts.push({
    artifact_type: 'table',
    label: `Demand Summary (${training_start} to ${training_end})`,
    data: demandSummaryRows,
  });

  // Forecast series (if available)
  const forecastGroups = forecastResult?.forecast_series?.groups || forecastResult?.groups || [];
  if (forecastGroups.length > 0) {
    // Build time-series table for charting
    const seriesRows = [];
    for (const group of forecastGroups.slice(0, 5)) {
      for (const pt of group.points || []) {
        seriesRows.push({
          group: group.material_code,
          period: pt.time_bucket,
          actual: pt.is_forecast ? null : (pt.actual ?? pt.demand_qty ?? pt.p50),
          forecast: pt.is_forecast ? (pt.p50 ?? pt.forecast ?? 0) : null,
          type: pt.is_forecast ? 'forecast' : 'history',
        });
      }
    }
    if (seriesRows.length > 0) {
      artifacts.push({
        artifact_type: 'table',
        label: 'Forecast Series (Top 5 Groups)',
        data: seriesRows,
      });
    }
  }

  // ── Multi-model comparison chart ──
  if (multiModelResults && compare_actuals) {
    // Get actuals aggregated by period
    const forecastStart = nextMonth(training_end);
    const forecastEnd = addMonths(forecastStart, forecast_months - 1);
    let actualRows = [];
    if (!demand_sql) {
      const autoActualsSql = defaultTrainingSql(forecastStart, forecastEnd, group_by);
      try { actualRows = await executeDemandSql(autoActualsSql); } catch {}
    }
    const actualByPeriod = new Map();
    for (const r of actualRows) {
      // Only include groups that were actually forecast (top N) — otherwise actuals >> forecasts
      if (!topGroups.has(r.material_code)) continue;
      actualByPeriod.set(r.time_bucket, (actualByPeriod.get(r.time_bucket) || 0) + r.demand_qty);
    }

    // Build chart data: period + actual + one column per model
    const periodSet = new Set();
    for (let i = 0; i < forecast_months; i++) periodSet.add(addMonths(forecastStart, i));
    const chartData = [...periodSet].sort().map(p => ({ period: p, actual: actualByPeriod.get(p) || 0 }));

    // Per-model MAPE tracking
    const modelMapes = {};

    for (const [modelName, result] of Object.entries(multiModelResults)) {
      if (!result) continue;
      const groups = result.forecast_series?.groups || result.groups || [];
      // Aggregate forecast by period
      const modelByPeriod = new Map();
      for (const g of groups) {
        for (const pt of (g.points || []).filter(p => p.is_forecast)) {
          modelByPeriod.set(pt.time_bucket, (modelByPeriod.get(pt.time_bucket) || 0) + (pt.p50 ?? pt.forecast ?? 0));
        }
      }
      const label = MODEL_LABELS[modelName] || modelName;
      let totalAbsErr = 0, totalActual = 0;
      for (const row of chartData) {
        const fv = modelByPeriod.get(row.period) || 0;
        row[label] = Math.round(fv);
        if (row.actual > 0) {
          totalAbsErr += Math.abs(fv - row.actual);
          totalActual += row.actual;
        }
      }
      modelMapes[label] = totalActual > 0 ? Math.round((totalAbsErr / totalActual) * 1000) / 10 : null;
    }

    // MAPE summary line
    const mapeLabels = Object.entries(modelMapes)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${v}%`).join(' | ');

    artifacts.push({
      artifact_type: 'line chart',
      label: `Multi-Model Forecast vs Actuals — ${mapeLabels}`,
      data: chartData,
    });

    // Per-model detail table
    const detailRows = [];
    for (const row of chartData) {
      for (const [modelName] of Object.entries(multiModelResults).filter(([, v]) => v)) {
        const label = MODEL_LABELS[modelName] || modelName;
        const fv = row[label] || 0;
        const actual = row.actual || 0;
        const absErr = Math.abs(fv - actual);
        detailRows.push({
          period: row.period, model: label, forecast: fv, actual,
          abs_error: Math.round(absErr),
          pct_error: actual > 0 ? Math.round((absErr / actual) * 1000) / 10 : null,
        });
      }
    }
    artifacts.push({
      artifact_type: 'table',
      label: `Model Comparison — ${mapeLabels}`,
      data: detailRows,
    });
  } else if (comparison?.available && comparison.details?.length > 0) {
    // Single model comparison
    artifacts.push({
      artifact_type: 'table',
      label: `Forecast vs Actuals — MAPE: ${comparison.overall_mape ?? 'N/A'}%`,
      data: comparison.details,
    });

    const periodMap = new Map();
    for (const d of comparison.details) {
      const existing = periodMap.get(d.time_bucket) || { period: d.time_bucket, forecast: 0, actual: 0 };
      existing.forecast += d.forecast_p50 || 0;
      existing.actual += d.actual || 0;
      periodMap.set(d.time_bucket, existing);
    }
    const chartData = [...periodMap.values()].sort((a, b) => a.period.localeCompare(b.period));
    if (chartData.length > 0) {
      artifacts.push({
        artifact_type: 'line chart',
        label: `Forecast vs Actuals — Overall MAPE: ${comparison.overall_mape ?? 'N/A'}%`,
        data: chartData,
      });
    }
  }

  // ── Analysis Report: deterministic numbers + LLM qualitative interpretation ──
  // Architecture: JS computes ALL numbers (grade, MAPE, trends). LLM only writes
  // qualitative text (why, so-what, recommendations). Numbers never pass through LLM.
  try {
    const chartArt = artifacts.find(a => a.artifact_type === 'line chart' && a.label?.includes('Multi-Model'));
    const tableArt = artifacts.find(a => a.artifact_type === 'table' && a.label?.includes('Model Comparison'));
    const mapeFromLabel = chartArt?.label?.match(/Prophet:\s*([\d.]+)%.*?LightGBM:\s*([\d.]+)%.*?Chronos:\s*([\d.]+)%/);

    // ── Step A: JS computes all numbers (deterministic, no LLM) ──
    const report = _computeReportNumbers({
      demandRows: filteredRows, topGroups, forecastResult, comparison,
      multiModelResults, training_start, training_end, forecast_months,
      aggregateMapes: mapeFromLabel
        ? { Prophet: parseFloat(mapeFromLabel[1]), LightGBM: parseFloat(mapeFromLabel[2]), Chronos: parseFloat(mapeFromLabel[3]) }
        : null,
      comparisonTableData: tableArt?.data || [],
      usedModel,
    });

    // ── Step B: LLM provides qualitative interpretation only (no numbers) ──
    const queryLang = /[\u4e00-\u9fff]/.test(user_query) ? 'zh' : 'en';
    const langInstruction = queryLang === 'zh'
      ? 'Response language: 繁體中文'
      : 'Response language: English';

    const contextForLLM = _buildLLMContext(report);

    const { text: llmText, model: llmModel } = await callLLM({
      taskType: 'synthesis',
      systemPrompt: `You are a senior supply chain analyst. The user just ran a demand forecast.

${langInstruction}

IMPORTANT: All numbers (MAPE, grade, trends) are already computed and will be displayed separately.
Your job is ONLY to provide qualitative interpretation — the "why" and "so what" behind the numbers.

DO NOT output any numbers, percentages, or statistics. They are already shown to the user.

Reply ONLY with JSON:
{
  "trend_interpretation": "1-2 sentences: what do the trends mean for business? Why is demand growing/declining?",
  "anomaly_explanation": "1 sentence: if any period has unusually high error, what might explain it? (seasonality, promotions, external events). Say 'null' if no anomalies.",
  "category_insight": "1-2 sentences: cross-category observation the user can't see from individual charts (e.g. correlation, substitution, seasonal differences)",
  "recommendations": ["2-3 specific actionable recommendations, each ≤ 35 words, referencing category names from the data"]
}

Rules:
- NO numbers, NO percentages — they are computed by code and shown separately
- Focus on causality, business context, and actionable next steps
- Recommendations must name specific categories and actions (not "consider adjusting")
- Reply with JSON only`,
      prompt: contextForLLM,
      temperature: 0.3,
      maxTokens: 800,
      jsonMode: true,
    });

    // ── Step C: Merge deterministic numbers + LLM text into final report ──
    let llmParsed = {};
    try { llmParsed = JSON.parse(llmText) || {}; } catch { /* use empty */ }

    const finalReport = {
      // All numbers from JS (deterministic, guaranteed correct)
      grade: report.grade,
      grade_reason: report.grade_reason,
      mape_by_model: report.mape_by_model,
      best_model: report.best_model,
      category_trends: report.category_trends,
      worst_period: report.worst_period,
      // Qualitative text from LLM (no numbers)
      trend_interpretation: llmParsed.trend_interpretation || null,
      anomaly_explanation: llmParsed.anomaly_explanation || null,
      category_insight: llmParsed.category_insight || null,
      recommendations: llmParsed.recommendations || [],
      _meta: {
        model: llmModel || 'unknown',
        generated_at: new Date().toISOString(),
        data_sources: [
          `Olist e-commerce dataset (${training_start || '2016'}–${training_end || '2018'})`,
          `ML models: ${usedModel === 'compare' ? 'Prophet / LightGBM / Chronos' : (MODEL_LABELS[usedModel] || usedModel)}`,
        ],
      },
    };

    artifacts.push({
      artifact_type: 'analysis',
      label: '📊 Forecast Analysis',
      data: [finalReport],
    });
  } catch (err) {
    console.warn('[sapForecastBridge] Analysis report failed (non-blocking):', err.message);
  }

  return {
    success: true,
    artifacts,
    forecast_model: usedModel,
    forecast_model_label: MODEL_LABELS[usedModel] || usedModel,
    training_period: { start: training_start, end: training_end },
    forecast_months,
    group_by: demand_sql ? 'custom_sql' : group_by,
    demand_summary: {
      total_rows: filteredRows.length,
      unique_groups: topGroups.size,
      top_groups: [...topGroups].slice(0, 10),
    },
    forecast: forecastResult,
    comparison,
  };
}

// ── Deterministic Report Numbers (no LLM, guaranteed correct) ────────────────

function _computeReportNumbers({ demandRows, topGroups, comparison, aggregateMapes, comparisonTableData, training_start, training_end, forecast_months, usedModel }) {
  // 1. MAPE by model (from chart label — already computed by ML API)
  const mape_by_model = aggregateMapes || {};
  const mapeValues = Object.values(mape_by_model).filter(v => v != null);
  const avgMape = mapeValues.length > 0 ? mapeValues.reduce((a, b) => a + b, 0) / mapeValues.length : null;

  // 2. Best model
  let best_model = null;
  if (Object.keys(mape_by_model).length > 0) {
    best_model = Object.entries(mape_by_model).sort((a, b) => a[1] - b[1])[0];
    best_model = { name: best_model[0], mape: best_model[1] };
  }

  // 3. Grade (deterministic — no LLM opinion)
  let grade, grade_reason;
  if (avgMape == null) {
    grade = '?'; grade_reason = 'No MAPE data available';
  } else if (avgMape < 10) {
    grade = 'A'; grade_reason = `Average MAPE ${avgMape.toFixed(1)}% — excellent accuracy across all models`;
  } else if (avgMape < 20) {
    grade = 'B'; grade_reason = `Average MAPE ${avgMape.toFixed(1)}% — good accuracy, minor deviations`;
  } else if (avgMape < 35) {
    grade = 'C'; grade_reason = `Average MAPE ${avgMape.toFixed(1)}% — moderate accuracy, needs tuning`;
  } else {
    grade = 'D'; grade_reason = `Average MAPE ${avgMape.toFixed(1)}% — poor accuracy, model revision needed`;
  }

  // 4. Per-category trends (JS computed)
  const category_trends = [];
  for (const group of topGroups) {
    const rows = demandRows.filter(r => r.material_code === group)
      .sort((a, b) => a.time_bucket.localeCompare(b.time_bucket));
    if (rows.length < 2) continue;
    const first = rows[0].demand_qty, last = rows[rows.length - 1].demand_qty;
    const total = rows.reduce((s, r) => s + r.demand_qty, 0);
    const growth_pct = first > 0 ? Math.round((last / first - 1) * 100) : 0;
    category_trends.push({ category: group, first_month: first, last_month: last, growth_pct, total });
  }

  // 5. Worst period (highest error)
  let worst_period = null;
  if (comparisonTableData?.length > 0) {
    const sorted = [...comparisonTableData].filter(r => r.pct_error != null).sort((a, b) => b.pct_error - a.pct_error);
    if (sorted.length > 0) {
      worst_period = { period: sorted[0].period, model: sorted[0].model, pct_error: sorted[0].pct_error };
    }
  }

  return {
    grade, grade_reason,
    mape_by_model, best_model, avg_mape: avgMape,
    category_trends, worst_period,
    training_period: `${training_start} ~ ${training_end}`,
    forecast_months, category_count: topGroups.size,
  };
}

// ── Context for LLM (numbers included as read-only reference, LLM must NOT output numbers) ──

function _buildLLMContext(report) {
  const lines = [];
  lines.push(`Forecast period: ${report.training_period}, ${report.forecast_months}m horizon, ${report.category_count} categories`);
  lines.push(`Grade: ${report.grade} (${report.grade_reason})`);

  if (report.best_model) {
    lines.push(`Best model: ${report.best_model.name} (MAPE ${report.best_model.mape}%)`);
  }

  if (report.worst_period) {
    lines.push(`Worst period: ${report.worst_period.period} (${report.worst_period.model}, error ${report.worst_period.pct_error}%)`);
  }

  lines.push(`\nCategory trends:`);
  for (const t of report.category_trends.slice(0, 10)) {
    const dir = t.growth_pct > 20 ? 'GROWING' : t.growth_pct < -20 ? 'DECLINING' : 'STABLE';
    lines.push(`  ${t.category}: ${dir} (${t.first_month}→${t.last_month}, total=${t.total})`);
  }

  return lines.join('\n');
}

// ── Execute & Validate Demand SQL ───────────────────────────────────────────

async function executeDemandSql(sql) {
  const result = await executeQuery({ sql });
  if (!result.success) {
    throw new Error(`SQL execution failed: ${result.error}`);
  }

  if (result.rows.length === 0) return [];

  // Validate that required columns exist
  const firstRow = result.rows[0];
  const missing = REQUIRED_COLUMNS.filter(col => !(col in firstRow));
  if (missing.length > 0) {
    throw new Error(
      `SQL result missing required columns: ${missing.join(', ')}. ` +
      `Your SQL must return columns: ${REQUIRED_COLUMNS.join(', ')}. ` +
      `Got columns: ${Object.keys(firstRow).join(', ')}`
    );
  }

  // Coerce demand_qty to number, filter out nulls
  return result.rows
    .map(row => ({
      material_code: String(row.material_code || '').trim(),
      plant_id: String(row.plant_id || 'DEFAULT').trim(),
      time_bucket: String(row.time_bucket || '').trim(),
      demand_qty: Number(row.demand_qty) || 0,
    }))
    .filter(row => row.material_code && row.time_bucket && row.demand_qty > 0);
}

// ── ML API Forecast ─────────────────────────────────────────────────────────

async function runMlApiForecast({ rows, topGroups, model, forecast_months, training_start, training_end }) {
  // Group rows by material_code, build time series per group
  const groupMap = new Map();
  for (const row of rows) {
    if (!topGroups.has(row.material_code)) continue;
    if (!groupMap.has(row.material_code)) groupMap.set(row.material_code, []);
    groupMap.get(row.material_code).push(row);
  }

  const forecastGroups = [];
  let usedModel = model;

  for (const [materialCode, groupRows] of groupMap) {
    // Sort by time_bucket and extract demand values
    const sorted = [...groupRows].sort((a, b) => a.time_bucket.localeCompare(b.time_bucket));
    const history = sorted.map(r => r.demand_qty);
    const buckets = sorted.map(r => r.time_bucket);

    if (history.length < 3) continue; // Skip groups with too little data

    // Call ML API /demand-forecast
    // horizonDays = forecast_months because history is monthly data (each point = 1 month)
    const modelType = model === 'auto' ? null : model;
    const resp = await fetch(`${ML_API_BASE}/demand-forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        materialCode,
        horizonDays: forecast_months,
        modelType,
        history,
        includeComparison: true,
        granularity: 'month',
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ML API ${resp.status} for ${materialCode}: ${errText.slice(0, 200)}`);
    }

    const result = await resp.json();
    if (result.error) throw new Error(`ML API error for ${materialCode}: ${result.error}`);

    console.log(`[sapForecastBridge] ML API response for ${materialCode} (${model}):`,
      'keys=', Object.keys(result),
      'forecast keys=', Object.keys(result.forecast || {}),
      'predictions len=', (result.forecast?.predictions || []).length
    );

    // Track which model was actually used (response shape: result.forecast.model)
    const forecastObj = result.forecast || {};
    if (forecastObj.model) {
      usedModel = forecastObj.model.toLowerCase();
    }

    // Build forecast points in the format expected by compareWithCustomSql
    const points = [];

    // History points
    for (let i = 0; i < buckets.length; i++) {
      points.push({
        time_bucket: buckets[i],
        demand_qty: history[i],
        actual: history[i],
        p50: history[i],
        is_forecast: false,
      });
    }

    // Forecast points — ML API returns:
    //   result.forecast.predictions: [float, ...]  (flat array)
    //   result.forecast.p10/p50/p90: [float, ...]  (quantile arrays)
    //   result.points: [{date, p10, p50, p90}, ...]
    const predictions = forecastObj.predictions || forecastObj.p50 || [];
    const p10Array = forecastObj.p10 || [];
    const p90Array = forecastObj.p90 || [];
    const forecastStart = nextMonth(training_end);

    for (let i = 0; i < forecast_months; i++) {
      const bucket = addMonths(forecastStart, i);
      const p50 = predictions[i] ?? 0;
      const p10 = p10Array[i] ?? null;
      const p90 = p90Array[i] ?? null;

      points.push({
        time_bucket: bucket,
        p50: Math.round(p50),
        p10: p10 != null ? Math.round(p10) : null,
        p90: p90 != null ? Math.round(p90) : null,
        forecast: Math.round(p50),
        is_forecast: true,
      });
    }

    forecastGroups.push({ material_code: materialCode, points });
  }

  return {
    forecast_series: { groups: forecastGroups },
    groups: forecastGroups,
    _usedModel: usedModel,
  };
}

// ── Compare with Actuals ────────────────────────────────────────────────────

async function compareWithCustomSql({ forecastResult, actualsSql, topGroups }) {
  let actualRows;
  try {
    actualRows = await executeDemandSql(actualsSql);
  } catch (err) {
    return {
      available: false,
      message: `Failed to query actuals: ${err.message}`,
    };
  }

  if (actualRows.length === 0) {
    return {
      available: false,
      message: 'No actual data found for the forecast period.',
    };
  }

  // Build lookup: material_code|time_bucket → actual_qty
  const actualMap = new Map();
  for (const row of actualRows) {
    const key = `${row.material_code}|${row.time_bucket}`;
    actualMap.set(key, (actualMap.get(key) || 0) + row.demand_qty);
  }

  // Extract forecast points and compare
  const comparisons = [];
  let totalAbsError = 0;
  let totalActual = 0;
  let matchCount = 0;

  const forecastGroups = forecastResult?.forecast_series?.groups || forecastResult?.groups || [];
  for (const group of forecastGroups) {
    const materialCode = group.material_code;
    if (!topGroups.has(materialCode)) continue;

    const forecastPoints = (group.points || []).filter(p => p.is_forecast);
    for (const point of forecastPoints) {
      const key = `${materialCode}|${point.time_bucket}`;
      const actual = actualMap.get(key);
      if (actual != null) {
        const forecast = point.p50 ?? point.forecast ?? 0;
        const absError = Math.abs(forecast - actual);
        const pctError = actual > 0 ? (absError / actual) * 100 : null;

        comparisons.push({
          material_code: materialCode,
          time_bucket: point.time_bucket,
          forecast_p50: Math.round(forecast),
          actual,
          abs_error: Math.round(absError),
          pct_error: pctError != null ? Math.round(pctError * 10) / 10 : null,
        });

        totalAbsError += absError;
        totalActual += actual;
        matchCount++;
      }
    }
  }

  const overallMape = totalActual > 0 ? ((totalAbsError / totalActual) * 100) : null;

  return {
    available: true,
    actual_data_points: actualRows.length,
    matched_comparisons: matchCount,
    overall_mape: overallMape != null ? Math.round(overallMape * 10) / 10 : null,
    details: comparisons.slice(0, 50),
    summary: matchCount > 0
      ? `Compared ${matchCount} forecast points against actuals. Overall MAPE: ${overallMape != null ? overallMape.toFixed(1) : 'N/A'}%`
      : 'No matching forecast-actual pairs found for comparison.',
  };
}

// ── Build Synthetic Dataset Profile ─────────────────────────────────────────

function buildSyntheticProfile({ rows, training_start, training_end, userId }) {
  const colNames = ['time_bucket', 'material_code', 'plant_id', 'demand_qty'];

  return {
    id: `local-sap-forecast-${Date.now()}`,
    user_id: userId,
    user_file_id: null,
    fingerprint: `sap-demand-${training_start}-${training_end}`,
    profile_json: {
      file_name: `SAP Demand Data (${training_start} to ${training_end})`,
      global: {
        workflow_guess: { label: 'A', confidence: 0.95, reason: 'Demand forecast from SAP data' },
        time_range_guess: { start: training_start, end: training_end },
        minimal_questions: [],
      },
      sheets: [{
        sheet_name: SHEET_NAME,
        likely_role: 'demand_fg',
        confidence: 1.0,
        original_headers: colNames,
        normalized_headers: colNames,
        grain_guess: {
          keys: ['material_code', 'plant_id'],
          time_column: 'time_bucket',
          granularity: 'monthly',
        },
        column_semantics: colNames.map(col => ({
          column: col,
          normalized: col,
          guessed_type: col === 'demand_qty' ? 'number' : 'string',
          non_null_ratio: 1.0,
        })),
        quality_checks: {
          missingness: 0,
          missingness_by_column: {},
          negative_number_columns: [],
          type_issues: [],
          duplicates_risk: {},
        },
        notes: ['Auto-generated from SAP data via sapForecastBridgeService'],
      }],
    },
    contract_json: {
      datasets: [{
        sheet_name: SHEET_NAME,
        upload_type: 'demand_fg',
        mapping: {
          material_code: 'material_code',
          plant_id: 'plant_id',
          demand_qty: 'demand_qty',
          time_bucket: 'time_bucket',
        },
        requiredCoverage: 1.0,
        missing_required_fields: [],
        validation: { status: 'pass', reasons: [] },
      }],
      requiredCoverage: 1.0,
      missing_required_fields: [],
      validation: { status: 'pass', reasons: [] },
    },
    _inlineRawRows: rows,
    _local: true,
  };
}

// ── Utility Helpers ─────────────────────────────────────────────────────────

function escapeStr(s) {
  return String(s).replace(/[^0-9\-]/g, '').slice(0, 7);
}

function nextMonth(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function addMonths(yearMonth, count) {
  let [y, m] = yearMonth.split('-').map(Number);
  m += count;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
