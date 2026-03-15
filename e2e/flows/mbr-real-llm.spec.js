/**
 * MBR Real LLM E2E Test
 *
 * Tests the full MBR analysis pipeline with REAL LLM responses.
 * Sends actual Excel data → ML API → LLM generates code → sandbox executes → artifacts.
 *
 * This test WAITS for LLM completion and ASSERTS on actual output quality.
 *
 * Requires:
 *   - Python ML API running (python run_ml_api.py)
 *   - Supabase Edge Function ai-proxy deployed (for LLM routing)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'apple_mbr.xlsx');
const ML_API = 'http://localhost:8000';

// 10 minutes — LLM calls are slow
test.setTimeout(600_000);

// Cache parsed Excel data across tests (parsed once, reused)
let _cachedExcelData = null;

/**
 * Read Excel file and convert to JSON sheet map via Python.
 * Returns { sheets: { sheetName: [{col: val, ...}, ...], ... } }
 */
async function readExcelToJson() {
  if (_cachedExcelData) return _cachedExcelData;
  const { execSync } = await import('child_process');
  const result = execSync(`python3 -c "
import openpyxl, json, sys
wb = openpyxl.load_workbook('${FIXTURE_PATH}', data_only=True)
sheets = {}
for name in wb.sheetnames:
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 5:
        continue
    headers = []
    header_idx = 3
    for j, h in enumerate(rows[header_idx]):
        headers.append(str(h) if h else f'col_{j}')
    data_rows = []
    for r in rows[header_idx+1:]:
        row = {}
        for j, h in enumerate(headers):
            if j < len(r):
                v = r[j]
                if hasattr(v, 'isoformat'):
                    v = v.isoformat()
                row[h] = v
        if any(v is not None for v in row.values()):
            data_rows.append(row)
    if data_rows:
        sheets[name] = data_rows[:200]
print(json.dumps({'sheets': sheets}, default=str))
"`, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  _cachedExcelData = JSON.parse(result);
  return _cachedExcelData;
}

/**
 * Call /execute-tool with retry on LLM-generated code failures.
 * LLM code gen is non-deterministic — SyntaxError / runtime errors can occur.
 */
async function executeToolWithRetry(request, payload, { maxRetries = 2, label = '' } = {}) {
  let lastResult;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await request.post(`${ML_API}/execute-tool`, {
      data: payload,
      timeout: 120000,
    });
    expect(resp.ok()).toBe(true);
    lastResult = await resp.json();

    console.log(`[${label}] Attempt ${attempt}: ok=${lastResult.ok}, artifacts=${lastResult.artifacts?.length || 0}, ${lastResult.execution_ms}ms`);

    if (lastResult.ok) return lastResult;

    // Log error and retry
    console.log(`[${label}] Error (attempt ${attempt}): ${lastResult.error?.slice(0, 300)}`);
    if (attempt < maxRetries) {
      console.log(`[${label}] Retrying...`);
    }
  }
  return lastResult;
}

test.describe('MBR Real LLM Pipeline', () => {

  test('ML API health check', async ({ request }) => {
    const resp = await request.get(`${ML_API}/health`);
    expect(resp.ok()).toBe(true);
    const health = await resp.json();
    expect(health.status).toBe('healthy');
    console.log('[Health] ML API is healthy');
  });

  test('Step 1: Clean data — real LLM generates Python code', async ({ request }) => {
    const inputData = await readExcelToJson();
    const sheetNames = Object.keys(inputData.sheets);
    console.log(`[Step 1] Loaded ${sheetNames.length} sheets: ${sheetNames.join(', ')}`);

    const result = await executeToolWithRetry(request, {
      tool_hint: `You are given a multi-sheet Excel workbook with messy data (intentional errors).
Sheets: ${sheetNames.join(', ')}

Task: Clean the '02_Sales_Raw' sheet:
1. Discover all column names using df.columns.tolist()
2. Remove rows where ALL values are null
3. Standardize date columns to datetime format
4. Standardize region/country/channel to Title Case
5. Flag outlier values (negative prices, qty > 1000)
6. Return a dict with 'result' key containing a summary, and 'artifacts' key containing:
   - A 'cleaned_data' artifact with the first 20 cleaned rows as a list of dicts
   - A 'data_issues_log' artifact listing all issues found

CRITICAL: The run() function MUST return a dict with 'result' and 'artifacts' keys.
Use df.columns.tolist() to discover actual column names — do NOT hardcode column names.`,
      input_data: { sheets: { '02_Sales_Raw': inputData.sheets['02_Sales_Raw'] || [] } },
      llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 4096 },
    }, { label: 'Step 1' });

    expect(result.ok).toBe(true);
    expect(result.artifacts?.length).toBeGreaterThan(0);
    expect(result.llm_provider).toBe('anthropic');
    console.log('[Step 1] Artifact types:', result.artifacts.map(a => a.type || a.artifact_type || 'unknown'));
  });

  test('Step 2: Calculate KPIs — real LLM computes metrics', async ({ request }) => {
    const inputData = await readExcelToJson();

    const result = await executeToolWithRetry(request, {
      tool_hint: `You have multi-sheet data from an Apple MBR workbook.

Task: Calculate KPI Summary for MBR:
1. Use df.columns.tolist() to discover actual column names for each sheet
2. Calculate: Total Revenue, Total Units Sold, Average Selling Price (ASP)
3. Calculate: Gross Margin % (if COGS data available)
4. Calculate: Return Rate (returns / sales)
5. Calculate: Discount Rate (average discount %)
6. Group by month if date column exists
7. Return as structured KPI table

CRITICAL:
- Use df.columns.tolist() first to discover column names
- Handle missing columns gracefully with try/except
- Keep the code simple — avoid overly complex aggregations
- The run() function MUST return a dict with 'result' (summary string) and 'artifacts' (list of dicts with 'type' and 'data' keys)`,
      input_data: {
        sheets: {
          '02_Sales_Raw': (inputData.sheets['02_Sales_Raw'] || []).slice(0, 150),
          '03_Returns_Raw': (inputData.sheets['03_Returns_Raw'] || []).slice(0, 50),
          '07_Targets_Budget': (inputData.sheets['07_Targets_Budget'] || []).slice(0, 50),
        },
      },
      llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 4096 },
    }, { maxRetries: 3, label: 'Step 2' });

    expect(result.ok).toBe(true);
    expect(result.artifacts?.length).toBeGreaterThan(0);
  });

  test('Step 3: Pivot analysis — real LLM performs dimensional analysis', async ({ request }) => {
    const inputData = await readExcelToJson();

    const result = await executeToolWithRetry(request, {
      tool_hint: `Multi-sheet Apple MBR data.

Task: Perform pivot analysis on sales data:
1. Use df.columns.tolist() first to discover all column names
2. Revenue by Region (top 5 regions)
3. Revenue by Product (top 5 products)
4. Revenue by Channel
5. Monthly trend (if date column exists)
6. Identify anomalies: regions/products with unusually high/low performance

CRITICAL:
- Use df.columns.tolist() to discover actual column names — do NOT hardcode
- If a column doesn't exist, skip that analysis gracefully
- Keep the code simple — under 100 lines
- Return dict with 'result' (text summary) and 'artifacts' (list of analysis dicts)
- Each artifact should have 'type' and 'data' keys`,
      input_data: {
        sheets: {
          '02_Sales_Raw': (inputData.sheets['02_Sales_Raw'] || []).slice(0, 150),
        },
      },
      llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 4096 },
    }, { label: 'Step 3' });

    expect(result.ok).toBe(true);
    expect(result.artifacts?.length).toBeGreaterThan(0);
  });

  test('Full 3-step sync agent loop — data clean → KPI → pivot', async ({ request }) => {
    const inputData = await readExcelToJson();
    const taskId = `e2e-mbr-full-${Date.now()}`;

    console.log(`[Full Loop] Starting 3-step pipeline, taskId: ${taskId}`);

    const resp = await request.post(`${ML_API}/agent/run`, {
      data: {
        task_id: taskId,
        steps: [
          {
            name: 'clean_data',
            tool_hint: `Clean the '02_Sales_Raw' sheet:
1. Use df.columns.tolist() to discover column names
2. Remove fully-null rows, standardize dates, Title Case text columns
3. Flag outliers (negative values, extreme quantities)
Return dict with 'result' (summary) and 'artifacts' (cleaned data sample + issues log).
CRITICAL: Use df.columns.tolist() — do NOT hardcode column names. Keep code under 80 lines.`,
          },
          {
            name: 'calculate_kpis',
            tool_hint: `Calculate MBR KPIs from the data:
1. Use df.columns.tolist() to discover columns
2. Total Revenue, Units Sold, ASP, Discount Rate
3. Revenue by region, by product (top 5 each)
Return dict with 'result' (summary) and 'artifacts' (KPI table).
CRITICAL: Use df.columns.tolist() — do NOT hardcode column names. Keep code under 80 lines.`,
          },
          {
            name: 'pivot_analysis',
            tool_hint: `Pivot analysis on sales data:
1. Use df.columns.tolist() to discover columns
2. Monthly revenue trend, region comparison, channel mix
3. Generate 3-5 management insights (margin erosion, return rate issues, inventory risk)
Return dict with 'result' (summary with insights) and 'artifacts' (pivot tables).
CRITICAL: Use df.columns.tolist() — do NOT hardcode column names. Keep code under 80 lines.`,
          },
        ],
        input_data: {
          sheets: {
            '02_Sales_Raw': (inputData.sheets['02_Sales_Raw'] || []).slice(0, 150),
            '03_Returns_Raw': (inputData.sheets['03_Returns_Raw'] || []).slice(0, 50),
            '07_Targets_Budget': (inputData.sheets['07_Targets_Budget'] || []).slice(0, 50),
          },
        },
        llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 4096 },
      },
      timeout: 300000,
    });

    expect(resp.ok()).toBe(true);
    const result = await resp.json();

    console.log('[Full Loop] Result:', JSON.stringify({
      ok: result.ok,
      steps_completed: result.steps_completed,
      steps_total: result.steps_total,
      total_ms: result.total_execution_ms,
    }));

    // Log per-step details
    const stepResults = result.step_results || [];
    for (const sr of stepResults) {
      console.log(`[Full Loop] Step "${sr.step_name}": ${sr.status}, artifacts: ${sr.artifacts?.length || 0}, ${sr.execution_ms}ms`);
      if (sr.status !== 'succeeded') {
        console.log(`  Error: ${sr.error?.slice(0, 300)}`);
      }
    }

    const succeededSteps = stepResults.filter(s => s.status === 'succeeded');
    console.log(`[Full Loop] ${succeededSteps.length}/${stepResults.length} steps succeeded`);

    // At least 2 of 3 steps must succeed (LLM flakiness tolerance)
    expect(succeededSteps.length).toBeGreaterThanOrEqual(2);

    // First step (clean_data) must always succeed
    expect(stepResults[0]?.status).toBe('succeeded');
    expect(stepResults[0]?.artifacts?.length).toBeGreaterThan(0);

    // Count total artifacts
    const totalArtifacts = stepResults.reduce((sum, s) => sum + (s.artifacts?.length || 0), 0);
    console.log(`[Full Loop] Total artifacts produced: ${totalArtifacts}`);
    expect(totalArtifacts).toBeGreaterThanOrEqual(3);

    // Verify LLM provider
    for (const sr of succeededSteps) {
      expect(sr.llm_provider).toBe('anthropic');
    }
  });
});
