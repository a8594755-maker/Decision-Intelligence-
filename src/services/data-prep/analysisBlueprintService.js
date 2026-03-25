/**
 * analysisBlueprintService.js
 *
 * AI-driven analysis blueprint generation.
 * NO hardcoded fallback — the AI always examines the actual data schema
 * and autonomously designs the analysis plan.
 *
 * Works with ANY dataset:
 * - Uploaded data → uses dataset profile schema
 * - Pre-loaded data → uses SAP_TABLE_REGISTRY
 */

import { getSchema, executeQuery } from '../sap-erp/sapDataQueryService.js';
import { invokeAiProxy } from '../ai-infra/aiProxyService.js';
import { extractAiJson } from '../../utils/aiMappingHelper.js';

// ── Schema Description Builder ───────────────────────────────────────────────

function buildSchemaFromProfile(datasetProfile) {
  // Support both camelCase (runtime) and snake_case (DB) shapes
  const profileJson = datasetProfile?.profileJson || datasetProfile?.profile_json;
  const sheets = profileJson?.sheets;
  if (!sheets?.length) return null;
  return sheets.map(s => ({
    table: s.sheet_name,
    columns: (s.column_semantics || []).map(c => c.column),
    column_types: (s.column_semantics || []).map(c => `${c.column} (${c.guessed_type})`),
    row_count: s.row_count || 'unknown',
    grain: s.grain_guess?.keys?.join(', ') || 'unknown',
    time_column: s.grain_guess?.time_column || null,
  }));
}

async function buildSchemaDescription(datasetProfile) {
  // Priority 1: from dataset profile (any uploaded data)
  const profileSchema = buildSchemaFromProfile(datasetProfile);
  if (profileSchema?.length > 0) {
    return { schema: profileSchema, source: 'profile' };
  }
  // Priority 2: from SAP_TABLE_REGISTRY (pre-loaded data)
  try {
    const schemaResult = await getSchema();
    const tables = (schemaResult.tables || []).map(t => ({
      table: t.table_name,
      columns: t.columns,
      row_count: t.row_count || 'unknown',
      desc: t.description,
    }));
    if (tables.length > 0) return { schema: tables, source: 'registry' };
  } catch (e) {
    console.warn('[AnalysisBlueprint] getSchema() failed:', e);
  }
  return { schema: [], source: 'empty' };
}

// ── Generate Blueprint (always AI-driven, no hardcoded fallback) ─────────────

export async function generateAnalysisBlueprint({ datasetProfile } = {}) {
  const { schema, source } = await buildSchemaDescription(datasetProfile);

  if (schema.length === 0) {
    throw new Error('No data schema available. Please upload a dataset first or ensure data tables are loaded.');
  }

  // All modules are SQL-based — no hardcoded builtin analysis engines
  const builtinBlock = '\nDesign ALL modules as SQL-based.\n';

  const prompt = `You are a world-class Data Analyst. You have been given a dataset's schema below.
Your task: EXAMINE the schema carefully, THINK about what business questions this data can answer,
then DESIGN a comprehensive "Analysis Blueprint" — a structured plan of 8-14 analysis modules.

THINK STEP BY STEP:
1. What domain is this data from? (e-commerce, supply chain, finance, HR, etc.)
2. What are the key entities? (customers, orders, products, employees, etc.)
3. What relationships exist between tables?
4. What business questions can we answer? (trends, segmentation, performance, anomalies, correlations)
5. Group analyses into 3-5 logical categories (basic → advanced)

DATA SCHEMA (${schema.length} tables, source: ${source}):
${JSON.stringify(schema, null, 2)}
${builtinBlock}
REQUIREMENTS:
- Design 8-14 modules total, from basic overviews to advanced cross-domain analyses.
- For SQL modules, write valid SQLite-compatible SELECT queries using EXACT table/column names from the schema above. Use aggregations (COUNT, SUM, AVG, GROUP BY) to produce meaningful summaries, NOT just "SELECT * LIMIT 100".
- Group into 3-5 categories. Assign each a color from: amber, teal, purple, indigo, rose, cyan, emerald, green, blue.
- The first ~4 categories are "basic/core", the last 1-2 are "advanced" (will appear below a divider).
- Use Traditional Chinese (繁體中文) for all text: title, subtitle, category labels, module titles, subtitles.
- The subtitle should describe the dataset scope (e.g., data size, date range, domain).
- Include 2-4 relationship strings showing how tables connect (use → ← arrows).

OUTPUT FORMAT — return ONLY this JSON, nothing else:
{
  "title": "XXX 資料分析藍圖",
  "subtitle": "資料集摘要描述",
  "categories": [
    { "id": "cat_id", "label": "類別名稱", "color": "amber" }
  ],
  "modules": [
    {
      "id": "m1",
      "number": 1,
      "title": "模組標題",
      "subtitle": "這個分析做什麼、看什麼指標",
      "category_id": "cat_id",
      "execution": { "type": "builtin", "function_id": "revenue" }
    },
    {
      "id": "m8",
      "number": 8,
      "title": "進階模組標題",
      "subtitle": "交叉分析描述",
      "category_id": "advanced_cat_id",
      "execution": { "type": "sql", "query": "SELECT ... FROM ... GROUP BY ..." }
    }
  ],
  "relationships": [
    "orders ← order_items → products",
    "orders ← payments"
  ]
}`;

  console.log(`[AnalysisBlueprint] Generating blueprint from ${schema.length} tables (source: ${source}, olist: ${hasOlist})`);

  const response = await invokeAiProxy('chat', {
    messages: [
      { role: 'system', content: 'You are a JSON-only Data Analyst. Examine the data schema, think about what analyses are possible, then output a valid JSON blueprint. No markdown fences, no explanations — pure JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
  });

  const content = response.choices?.[0]?.message?.content || '';
  if (!content) {
    throw new Error('AI returned empty response. Please check your AI proxy configuration.');
  }

  const blueprint = extractAiJson(content);

  if (!blueprint?.modules?.length) {
    console.error('[AnalysisBlueprint] AI returned invalid structure:', content.slice(0, 500));
    throw new Error('AI returned an invalid blueprint structure. Please try again.');
  }

  // Ensure every module has status field
  blueprint.modules = blueprint.modules.map(m => ({ ...m, status: m.status || 'pending' }));

  console.log(`[AnalysisBlueprint] Generated ${blueprint.modules.length} modules in ${blueprint.categories?.length || 0} categories`);
  return blueprint;
}

// ── Execute Module ───────────────────────────────────────────────────────────

export async function executeModule(module) {
  if (!module?.execution) {
    throw new Error('Invalid module definition');
  }

  const { type } = module.execution;

  // SQL Execution
  if (type === 'sql') {
    const query = module.execution.query;
    if (!query) throw new Error('Missing SQL query');

    const result = await executeQuery({ sql: query });
    if (!result.success) throw new Error(result.error);

    return formatSqlResultAsCard(module, result.rows);
  }

  // C. Python Analysis Execution (Claude-style statistical analysis)
  if (type === 'python_analysis') {
    const toolHint = module.execution.tool_hint || module.description || module.title;
    const ML_API_BASE = String(import.meta.env?.VITE_ML_API_BASE || 'http://localhost:8000');

    const resp = await fetch(`${ML_API_BASE}/execute-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_hint: toolHint,
        analysis_mode: true,
        dataset: 'olist',
        input_data: {},
        prior_artifacts: {},
      }),
    });

    if (!resp.ok) throw new Error(`Python analysis failed (${resp.status})`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Analysis failed');

    // Return the first analysis_result artifact's data
    const analysisArtifact = (data.artifacts || []).find(a => a.type === 'analysis_result');
    if (analysisArtifact?.data) return analysisArtifact.data;

    // Fallback: wrap raw result
    return {
      analysisType: 'python_analysis',
      title: module.title,
      summary: data.result?.summary || 'Analysis completed',
      metrics: data.result || {},
      charts: [], tables: [], highlights: [], details: [],
    };
  }

  throw new Error(`Unknown execution type: ${type}`);
}

// ── Helper: Auto-format SQL Result ───────────────────────────────────────────

function formatSqlResultAsCard(module, rows) {
  const rowCount = rows.length;
  if (rowCount === 0) {
    return {
      analysisType: 'custom_sql',
      title: module.title,
      summary: 'No data found for this analysis.',
      metrics: {}, charts: [], tables: [], highlights: [], details: [],
    };
  }

  const keys = Object.keys(rows[0]);

  // Heuristic chart detection
  const charts = [];
  const timeKey = keys.find(k => /month|date|year|week|day|period|quarter/i.test(k));
  const numericKeys = keys.filter(k => typeof rows[0][k] === 'number');
  const valueKey = numericKeys.find(k => /revenue|sales|count|total|sum|amount|qty|avg|rate|score|ratio|price/i.test(k))
    || numericKeys[0]; // fallback to first numeric column

  if (timeKey && valueKey) {
    charts.push({
      type: 'line',
      title: `${module.title}`,
      data: rows.map(r => ({ x: r[timeKey], y: Number(r[valueKey]) || 0 })),
      xKey: 'x', yKey: 'y', label: valueKey,
    });
  } else if (keys.length >= 2 && valueKey) {
    const catKey = keys.find(k => k !== valueKey && typeof rows[0][k] === 'string') || keys.find(k => k !== valueKey);
    if (catKey) {
      charts.push({
        type: 'bar',
        title: `${module.title}`,
        data: rows.slice(0, 15).map(r => ({
          category: String(r[catKey]).slice(0, 25),
          value: Number(r[valueKey]) || 0,
        })),
        xKey: 'category', yKey: 'value', label: valueKey,
      });
    }
  }

  // Metrics
  const metrics = {};
  if (rowCount === 1) {
    keys.forEach(k => { metrics[formatLabel(k)] = formatValue(rows[0][k]); });
  } else {
    metrics['Records'] = rowCount.toLocaleString();
    if (valueKey) {
      const values = rows.map(r => Number(r[valueKey]) || 0);
      const total = values.reduce((a, b) => a + b, 0);
      const avg = total / values.length;
      metrics[`Total ${formatLabel(valueKey)}`] = formatValue(total);
      metrics[`Avg ${formatLabel(valueKey)}`] = formatValue(avg);
    }
  }

  return {
    analysisType: 'custom_sql',
    title: module.title,
    summary: module.subtitle || `Analysis with ${rowCount} records.`,
    metrics,
    charts,
    tables: [{
      title: 'Details',
      columns: keys.map(formatLabel),
      rows: rows.slice(0, 20).map(r => keys.map(k => formatValue(r[k]))),
    }],
    highlights: [],
    details: [],
  };
}

function formatLabel(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function formatValue(val) {
  if (typeof val === 'number') {
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return String(val ?? '');
}
