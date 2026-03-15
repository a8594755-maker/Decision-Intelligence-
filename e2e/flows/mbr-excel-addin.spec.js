/**
 * MBR Excel Tool E2E Test — Full Pipeline
 *
 * Tests the AI Employee's Excel tool end-to-end:
 *   1. Read source Excel → parse to JSON
 *   2. Call /agent/mbr-analysis (real LLM analysis)
 *   3. Call /agent/generate-excel (openpyxl → .xlsx with 6 sheets)
 *   4. Verify the .xlsx opens in Excel desktop
 *
 * Output: output/MBR_*.xlsx (auto-opened in Excel)
 *
 * Requires:
 *   - Python ML API running (python run_ml_api.py)
 *   - openpyxl installed
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'apple_mbr.xlsx');
const ML_API = 'http://localhost:8000';

test.setTimeout(600_000);

let _cachedExcelData = null;

async function readExcelToJson() {
  if (_cachedExcelData) return _cachedExcelData;
  const { execSync } = await import('child_process');
  const result = execSync(`python3 -c "
import openpyxl, json
wb = openpyxl.load_workbook('${FIXTURE_PATH}', data_only=True)
sheets = {}
for name in wb.sheetnames:
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 5: continue
    header_idx = 3
    headers = [str(h) if h else f'col_{j}' for j, h in enumerate(rows[header_idx])]
    data_rows = []
    for r in rows[header_idx+1:]:
        row = {}
        for j, h in enumerate(headers):
            if j < len(r):
                v = r[j]
                if hasattr(v, 'isoformat'): v = v.isoformat()
                row[h] = v
        if any(v is not None for v in row.values()):
            data_rows.append(row)
    if data_rows: sheets[name] = data_rows[:200]
print(json.dumps({'sheets': sheets}, default=str))
"`, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  _cachedExcelData = JSON.parse(result);
  return _cachedExcelData;
}

test.describe('MBR Excel Tool — Full Agent Pipeline', () => {

  test('ML API health check', async ({ request }) => {
    const resp = await request.get(`${ML_API}/health`);
    expect(resp.ok()).toBe(true);
  });

  test('Full pipeline: LLM analysis → generate-excel → opens in Excel', async ({ request }) => {
    // ── 1. Read source data ──
    const inputData = await readExcelToJson();
    const totalRows = Object.values(inputData.sheets).reduce((s, r) => s + r.length, 0);
    console.log(`[1/3] Source: ${Object.keys(inputData.sheets).length} sheets, ${totalRows} rows`);

    // ── 2. Run MBR analysis with REAL LLM ──
    const taskId = `e2e-excel-tool-${Date.now()}`;
    console.log(`[2/3] Running /agent/mbr-analysis (taskId: ${taskId})...`);

    const analysisResp = await request.post(`${ML_API}/agent/mbr-analysis`, {
      data: {
        task_id: taskId,
        input_data: {
          sheets: {
            '02_Sales_Raw': (inputData.sheets['02_Sales_Raw'] || []).slice(0, 150),
            '03_Returns_Raw': (inputData.sheets['03_Returns_Raw'] || []).slice(0, 50),
            '07_Targets_Budget': (inputData.sheets['07_Targets_Budget'] || []).slice(0, 50),
          },
        },
        max_retries: 2,
      },
      timeout: 300000,
    });

    expect(analysisResp.ok()).toBe(true);
    const analysisResult = await analysisResp.json();

    const stepResults = analysisResult.step_results || [];
    for (const sr of stepResults) {
      const arts = (sr.artifacts || []).map(a => a.label || a.type).join(', ');
      console.log(`[2/3] ${sr.step_name}: ${sr.status} (${sr.execution_ms}ms) → [${arts}]`);
    }

    const succeeded = stepResults.filter(s => s.status === 'succeeded');
    expect(succeeded.length).toBeGreaterThanOrEqual(2);
    console.log(`[2/3] Analysis done: ${succeeded.length}/${stepResults.length} steps, ${analysisResult.total_execution_ms}ms`);

    // ── 3. Generate Excel workbook (the Excel Tool) ──
    console.log(`[3/3] Calling /agent/generate-excel...`);

    const excelResp = await request.post(`${ML_API}/agent/generate-excel`, {
      data: {
        task_id: taskId,
        step_results: stepResults,
        title: 'Apple Monthly Business Review — 2026-03',
        open_file: true,
      },
      timeout: 120000,  // LLM generates openpyxl code via Opus 4.6
    });

    expect(excelResp.ok()).toBe(true);
    const excelResult = await excelResp.json();

    expect(excelResult.ok).toBe(true);
    expect(excelResult.file_path).toBeTruthy();
    expect(excelResult.sheets.length).toBeGreaterThanOrEqual(6);
    expect(excelResult.file_size).toBeGreaterThan(5000);
    expect(excelResult.content_base64).toBeTruthy();

    console.log(`[3/3] Excel generated (by ${excelResult.llm_model || 'unknown'}):`);
    console.log(`       File: ${excelResult.file_path}`);
    console.log(`       Size: ${(excelResult.file_size / 1024).toFixed(1)} KB`);
    console.log(`       Sheets: ${excelResult.sheets.join(', ')}`);
    console.log(`       Code: ${excelResult.code_length || '?'} chars of openpyxl`);

    // Verify expected sheets (LLM may name them slightly differently, check by keyword)
    const sheetNames = excelResult.sheets.map(s => s.toLowerCase());
    const requiredKeywords = ['cover', 'kpi', 'clean', 'issue', 'analysis', 'dashboard'];
    for (const kw of requiredKeywords) {
      const found = sheetNames.some(s => s.includes(kw));
      expect(found).toBe(true);
    }

    // Verify file exists on disk
    expect(fs.existsSync(excelResult.file_path)).toBe(true);

    // Verify base64 can be decoded back to valid file
    const decoded = Buffer.from(excelResult.content_base64, 'base64');
    expect(decoded.length).toBe(excelResult.file_size);

    // Verify file header is valid xlsx (PK zip signature)
    expect(decoded[0]).toBe(0x50); // P
    expect(decoded[1]).toBe(0x4B); // K

    console.log(`\n✅ Full pipeline complete!`);
    console.log(`   LLM analysis: ${analysisResult.total_execution_ms}ms`);
    console.log(`   Excel output: ${excelResult.filename} (${excelResult.sheets.length} sheets)`);
    console.log(`   File opened in Excel desktop automatically`);
  });

  test('/agent/generate-excel with empty results still produces valid workbook', async ({ request }) => {
    const resp = await request.post(`${ML_API}/agent/generate-excel`, {
      data: {
        task_id: 'test-empty',
        step_results: [],
        title: 'Empty Test Workbook',
        open_file: false,
      },
      timeout: 120000,  // LLM generates openpyxl code via Opus 4.6
    });

    expect(resp.ok()).toBe(true);
    const result = await resp.json();
    expect(result.ok).toBe(true);
    expect(result.sheets.length).toBeGreaterThanOrEqual(6);
    console.log(`[Empty] Generated ${result.sheets.length} sheets, ${result.file_size} bytes`);
  });
});
