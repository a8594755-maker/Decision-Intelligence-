/**
 * jsToolVerifier.js — Verify JS builtin tools work end-to-end.
 *
 * Runs in the browser (via Vite). Call verifyJsTools() from a UI button or console.
 * Tests each tool with minimal input, checks:
 *   1. Does it import without error?
 *   2. Does executeTool() return { success: true }?
 *   3. Does the result have expected shape (artifacts, data)?
 *
 * Usage from browser console:
 *   import('/src/services/agent-core/jsToolVerifier.js').then(m => m.verifyJsTools())
 */

import { executeTool } from './chatToolAdapter.js';
import { BUILTIN_TOOLS, isPythonApiTool } from '../ai-infra/builtinToolCatalog.js';

const ML_API = String(import.meta.env.VITE_ML_API_URL || import.meta.env.VITE_ML_API_BASE || 'http://localhost:8000');

// ── Test Definitions ───────────────────────────────────────────────────────

// Sample data for Python API tests
const SAMPLE_SALES = [
  { date: '2025-01-01', product: 'Widget A', qty: 100, revenue: 5000, cost: 2000 },
  { date: '2025-01-02', product: 'Widget B', qty: 50, revenue: 3000, cost: 1500 },
  { date: '2025-01-03', product: 'Widget A', qty: 75, revenue: 4000, cost: 1800 },
  { date: '2025-01-04', product: 'Widget C', qty: 200, revenue: 8000, cost: 4000 },
  { date: '2025-01-05', product: 'Widget B', qty: 30, revenue: 1500, cost: 900 },
];

const SAMPLE_ANOMALY = [
  { revenue: 100 }, { revenue: 105 }, { revenue: 98 },
  { revenue: 102 }, { revenue: 95 }, { revenue: 100000 },
  { revenue: 101 }, { revenue: 97 }, { revenue: 103 },
];

const TOOL_TESTS = [
  {
    id: 'run_eda',
    pythonApi: true,
    endpoint: '/agent/eda',
    body: { sheets: { sales: SAMPLE_SALES } },
    check: (r) => r.ok && r.artifacts?.length > 0,
    description: 'EDA via Python API — column stats + correlations',
  },
  {
    id: 'run_anomaly_detection',
    pythonApi: true,
    endpoint: '/agent/anomaly',
    body: { sheets: { data: SAMPLE_ANOMALY } },
    check: (r) => r.ok,
    description: 'Anomaly detection via Python API — should flag 100000 outlier',
  },
  {
    id: 'run_data_cleaning',
    pythonApi: true,
    endpoint: '/cleaning/apply',
    body: { sheets: { data: [
      { name: 'Alice', age: 30, city: 'NYC' },
      { name: 'Bob', age: null, city: 'LA' },
      { name: 'Alice', age: 30, city: 'NYC' },
      { name: '  Charlie  ', age: 25, city: ' SF ' },
    ] } },
    check: (r) => r.ok !== false,
    description: 'Data cleaning via Python API — nulls, duplicates, whitespace',
  },
  {
    id: 'run_auto_insights',
    pythonApi: true,
    endpoint: '/agent/eda',
    body: { sheets: { sales: SAMPLE_SALES } },
    check: (r) => r.ok && r.artifacts?.length > 0,
    description: 'Auto insights via Python EDA — patterns in sales data',
  },
  {
    id: 'run_regression',
    pythonApi: true,
    endpoint: '/agent/regression',
    body: { sheets: { data: [
      { qty: 10, price: 50, revenue: 500 },
      { qty: 20, price: 50, revenue: 1000 },
      { qty: 30, price: 50, revenue: 1500 },
      { qty: 15, price: 100, revenue: 1500 },
      { qty: 25, price: 100, revenue: 2500 },
    ] } },
    check: (r) => r.ok && r.result?.r_squared > 0.9,
    description: 'OLS regression via Python API — revenue ~ qty + price (R²>0.9)',
  },
  {
    id: 'query_sap_data',
    args: {
      sql: "SELECT product_category_name, COUNT(*) as cnt FROM products GROUP BY product_category_name ORDER BY cnt DESC LIMIT 5",
    },
    context: {},
    check: (r) => r.success && r.result,
    description: 'SQL query on built-in Olist dataset',
  },
  {
    id: 'list_sap_tables',
    args: {},
    context: {},
    check: (r) => r.success,
    description: 'List available SAP/Olist tables',
  },
  {
    id: 'generate_chart',
    args: {
      recipe_id: 'revenue_by_category',
      dataset: 'olist',
    },
    context: {},
    check: (r) => r.success,
    description: 'Generate chart from predefined recipe',
  },
  {
    id: 'run_digital_twin_simulation',
    args: {
      scenario: 'normal',
      seed: 42,
      durationDays: 30,
    },
    context: {},
    check: (r) => r.success,
    description: 'Digital twin simulation (30 days, normal scenario)',
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────

/**
 * Run all JS tool verification tests.
 * Call from browser console or a UI button.
 *
 * @returns {Promise<object>} { passed, failed, total, results: [...] }
 */
export async function verifyJsTools() {
  console.log(`\n🔧 JS Tool Verification — ${TOOL_TESTS.length} tools\n`);
  const results = [];

  for (const test of TOOL_TESTS) {
    const entry = BUILTIN_TOOLS.find(t => t.id === test.id);
    if (!entry) {
      results.push({ id: test.id, pass: false, error: 'Not in catalog', ms: 0 });
      console.log(`❌ ${test.id}: NOT IN CATALOG`);
      continue;
    }

    const t0 = performance.now();
    try {
      let result;

      if (test.pythonApi) {
        // Call Python API directly
        const resp = await fetch(`${ML_API}${test.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(test.body),
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined,
        });
        result = await resp.json();
        result.success = result.ok !== false;
      } else if (isPythonApiTool(test.id) && !test.pythonApi) {
        results.push({ id: test.id, pass: null, error: 'Python API tool — use pythonApi flag', ms: 0 });
        console.log(`⏭️  ${test.id}: needs pythonApi config`);
        continue;
      } else {
        result = await executeTool(test.id, test.args, test.context);
      }

      const ms = Math.round(performance.now() - t0);
      const passed = test.check(result);

      // Extract sample output for display
      let sampleOutput = null;
      const r = result.result || {};
      if (r.artifacts?.length) {
        sampleOutput = r.artifacts.slice(0, 3).map(a => ({
          label: a.label || a.type || 'artifact',
          rows: Array.isArray(a.data) ? a.data.length : (typeof a.data === 'object' ? 1 : 0),
          preview: Array.isArray(a.data) ? a.data.slice(0, 3) : a.data,
        }));
      } else if (r.result && typeof r.result === 'object') {
        sampleOutput = [{ label: 'result', rows: 1, preview: [r.result] }];
      } else if (r.rows?.length) {
        sampleOutput = [{ label: 'query_result', rows: r.rows.length, preview: r.rows.slice(0, 5) }];
      } else if (r.tables?.length) {
        sampleOutput = [{ label: 'tables', rows: r.tables.length, preview: r.tables.slice(0, 5) }];
      } else if (typeof r === 'object' && Object.keys(r).length > 0) {
        sampleOutput = [{ label: 'raw', rows: 1, preview: [r] }];
      }

      results.push({
        id: test.id,
        pass: passed,
        ms,
        success: result.success,
        error: result.error || null,
        hasArtifacts: Boolean(r.artifacts?.length || r.result),
        description: test.description,
        sampleOutput,
        fullResult: result,
      });

      const icon = passed ? '✅' : '❌';
      console.log(`${icon} ${test.id} (${ms}ms) — ${test.description}`);
      if (!passed) console.log(`   Error: ${result.error || 'check failed'}`);
      if (result.result?.artifacts) console.log(`   Artifacts: ${result.result.artifacts.length}`);
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      results.push({ id: test.id, pass: false, ms, error: err.message, description: test.description });
      console.log(`❌ ${test.id} (${ms}ms) — EXCEPTION: ${err.message}`);
    }
  }

  const passed = results.filter(r => r.pass === true).length;
  const failed = results.filter(r => r.pass === false).length;
  const skipped = results.filter(r => r.pass === null).length;

  console.log(`\n━━━ Results: ${passed}✅ / ${failed}❌ / ${skipped}⏭️  (${results.length} total) ━━━\n`);

  return { passed, failed, skipped, total: results.length, results };
}

export default { verifyJsTools, TOOL_TESTS };
