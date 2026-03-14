#!/usr/bin/env node
/**
 * Auto-Debug Loop — Playwright 自動操作 + 錯誤收集
 *
 * 用法：
 *   node e2e/auto-debug-loop.mjs                  # Mock LLM + 無檔案上傳
 *   node e2e/auto-debug-loop.mjs --real-llm       # 真實 ai-proxy（需部署）
 *   node e2e/auto-debug-loop.mjs --upload FILE     # 上傳 Excel 檔案
 *
 * 完整測試：
 *   node e2e/auto-debug-loop.mjs --upload ~/Downloads/apple_monthly_business_review_case.xlsx
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(__dirname, 'debug-report.json');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const USE_REAL_LLM = args.includes('--real-llm');
const UPLOAD_IDX = args.indexOf('--upload');
const UPLOAD_FILE = UPLOAD_IDX !== -1 ? args[UPLOAD_IDX + 1] : null;

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// ─── The full MBR analysis prompt ────────────────────────────────────────────
const TASK_MESSAGE = `你是 Apple 業務分析團隊的 entry level analyst，主管要你準備本月月會（Monthly Business Review）使用的分析資料。

請在分析中完成：

1. Raw_Data — 保留原始資料
2. Cleaned_Data — 整理後可分析的主資料表（欄位格式一致、日期可排序、名稱統一、異常值標記）
3. Data_Issues_Log — 列出資料問題與處理方式
4. KPI_Summary — 核心指標摘要（Total Revenue, Units Sold, Gross Profit, Gross Margin%, ASP, Return Rate, Discount Rate, Sales vs Target, Revenue by Month/Region/Product/Channel, Inventory Coverage, Marketing ROAS, Ticket Volume, Resolution Time）
5. Analysis — 用 Pivot 分析：本月業績是否達標、哪些地區/產品/通路表現異常、退貨率高的原因、折扣 vs 毛利、庫存壓力
6. Dashboard — 一頁式管理報表：KPI cards、月度趨勢、地區/產品/通路比較、風險視覺化、3個重點 observation

請提出 3-5 個管理層洞察，例如 margin 被折扣侵蝕、某區退貨率偏高、庫存積壓風險等。`;

const STEP_TIMEOUT = 120_000;
const TOTAL_TIMEOUT = 420_000; // 7min for full flow with upload

// ─── Read env vars ───────────────────────────────────────────────────────────
function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || readEnvVar('VITE_SUPABASE_URL') || '';
const PROJECT_REF = SUPABASE_URL ? new URL(SUPABASE_URL).hostname.split('.')[0] : 'placeholder';

// ─── Mock LLM Responses ─────────────────────────────────────────────────────

const MOCK_DECOMPOSITION = {
  subtasks: [
    { name: 'clean_data', workflow_type: 'python_tool', description: 'Clean and validate all sheets using pandas', builtin_tool_id: null, depends_on: [], tool_hint: 'Read all sheets from input_data. Fix date formats, standardize SKU/Product/Region/Channel names, handle missing values with fillna, remove duplicates, flag anomalies. Output cleaned_data artifact and data_quality_summary.', estimated_tier: 'tier_b' },
    { name: 'data_issues_log', workflow_type: 'python_tool', description: 'Document all data quality issues found', builtin_tool_id: null, depends_on: ['clean_data'], tool_hint: 'From cleaning results in prior_artifacts, create a structured log of: issue type, affected field, count, treatment method, remaining risk. Return as list of dicts.', estimated_tier: 'tier_c' },
    { name: 'calculate_kpis', workflow_type: 'python_tool', description: 'Calculate all KPI metrics using pandas aggregation', builtin_tool_id: null, depends_on: ['clean_data'], tool_hint: 'Using cleaned data from prior artifacts, calculate: Total Revenue, Units Sold, Gross Profit, Gross Margin%, ASP, Return Rate, Discount Rate, Sales vs Target achievement. Break down by Month, Region, Product Family, Channel. Also calculate Inventory Coverage, Marketing ROAS, Ticket Volume, Avg Resolution Time.', estimated_tier: 'tier_a' },
    { name: 'analyze_performance', workflow_type: 'python_tool', description: 'Pivot analysis and management insights', builtin_tool_id: null, depends_on: ['calculate_kpis'], tool_hint: 'Using KPI data from prior artifacts, create pivot tables by Region×Product, Channel×Month. Analyze: target achievement, high return rate causes, discount vs margin, inventory pressure. Identify top 3-5 management insights.', estimated_tier: 'tier_a' },
    { name: 'generate_dashboard', workflow_type: 'python_report', description: 'Generate PDF dashboard with charts and KPI cards', builtin_tool_id: null, depends_on: ['data_issues_log', 'calculate_kpis', 'analyze_performance'], tool_hint: null, estimated_tier: 'tier_a' },
  ],
  report_format: 'pdf',
  confidence: 0.92,
  needs_clarification: false,
  clarification_questions: [],
};

// ─── Mock Python API Responses ──────────────────────────────────────────────
// When python_tool steps hit localhost:8000/execute-tool, we intercept and
// return mock results (since Python FastAPI may not be running during E2E tests).

const MOCK_PYTHON_TOOL_RESPONSES = {
  clean_data: {
    ok: true,
    result: { cleaned_rows: 9850, issues_found: 42, sheets_processed: ['Sales_Data', 'Returns', 'Inventory', 'Marketing', 'Support_Tickets', 'Targets'], quality_score: 0.94 },
    artifacts: [
      { type: 'cleaned_data', label: 'Cleaned_Data', data: Array.from({ length: 20 }, (_, i) => ({ row_id: i + 1, order_date: '2026-01-15', product: 'iPhone 16 Pro', region: ['North America', 'Europe', 'Greater China', 'Japan'][i % 4], channel: ['Online', 'Retail', 'Partner'][i % 3], units: Math.round(50 + Math.random() * 200), revenue: Math.round(30000 + Math.random() * 100000), discount_pct: Math.round(Math.random() * 15 * 100) / 100, return_flag: i % 7 === 0 ? 'Y' : 'N' })) },
      { type: 'data_quality', label: 'Data_Quality_Summary', data: { total_rows: 10571, cleaned_rows: 9850, duplicates_removed: 312, nulls_filled: 187, format_fixes: 222, quality_score: 0.94 } },
    ],
    metadata: { description: 'Cleaned 9850 rows from 6 sheets, found 42 issues', artifact_count: 2, total_rows: 9850 },
    code: 'import pandas as pd\n# mock code',
    stdout: '', stderr: '', execution_ms: 3200,
  },
  data_issues_log: {
    ok: true,
    result: { total_issues: 42 },
    artifacts: [
      { type: 'data_issues', label: 'Data_Issues_Log', data: [
        { issue_type: 'Date format inconsistent', field: 'order_date', count: 124, treatment: 'Converted to yyyy-mm-dd', risk: 'Low' },
        { issue_type: 'SKU naming mismatch', field: 'product_name', count: 63, treatment: 'Mapped to standard catalog', risk: 'Low' },
        { issue_type: 'Duplicate transactions', field: 'order_id+sku', count: 41, treatment: 'Removed 27 exact dupes, kept 14 for review', risk: 'Medium' },
        { issue_type: 'Negative revenue values', field: 'net_revenue', count: 18, treatment: 'Classified as cancellations', risk: 'Low' },
        { issue_type: 'Missing region', field: 'region', count: 35, treatment: 'Inferred from store_id lookup', risk: 'Medium' },
        { issue_type: 'Outlier unit price', field: 'unit_price', count: 8, treatment: 'Flagged, not removed', risk: 'High' },
      ] },
    ],
    metadata: { description: 'Documented 42 data quality issues across 6 categories', artifact_count: 1, total_rows: 6 },
    code: 'import pandas as pd\n# mock code', stdout: '', stderr: '', execution_ms: 1200,
  },
  calculate_kpis: {
    ok: true,
    result: { kpi_count: 14 },
    artifacts: [
      { type: 'kpi_summary', label: 'KPI_Summary', data: [
        { metric: 'Total Revenue', value: 2847500000, unit: 'USD', period: '2026-01' },
        { metric: 'Units Sold', value: 8523000, unit: 'units', period: '2026-01' },
        { metric: 'Gross Profit', value: 1231000000, unit: 'USD', period: '2026-01' },
        { metric: 'Gross Margin %', value: 43.2, unit: '%', period: '2026-01' },
        { metric: 'ASP', value: 334.12, unit: 'USD', period: '2026-01' },
        { metric: 'Return Rate', value: 4.8, unit: '%', period: '2026-01' },
        { metric: 'Discount Rate', value: 12.3, unit: '%', period: '2026-01' },
        { metric: 'Target Achievement', value: 97.2, unit: '%', period: '2026-01' },
        { metric: 'Inventory Coverage', value: 6.2, unit: 'weeks', period: '2026-01' },
        { metric: 'Marketing ROAS', value: 4.8, unit: 'x', period: '2026-01' },
        { metric: 'Ticket Volume', value: 12500, unit: 'tickets', period: '2026-01' },
        { metric: 'Avg Resolution Time', value: 18.3, unit: 'hours', period: '2026-01' },
      ] },
      { type: 'revenue_breakdown', label: 'Revenue_By_Region', data: [
        { region: 'North America', revenue: 1138000000, units: 3410000, margin_pct: 45.1, target_pct: 101.2 },
        { region: 'Europe', revenue: 854000000, units: 2557000, margin_pct: 42.8, target_pct: 96.5 },
        { region: 'Greater China', revenue: 569000000, units: 1705000, margin_pct: 38.5, target_pct: 89.3 },
        { region: 'Japan', revenue: 285000000, units: 851000, margin_pct: 46.2, target_pct: 103.7 },
      ] },
    ],
    metadata: { description: '14 KPIs calculated with regional breakdown', artifact_count: 2, total_rows: 16 },
    code: 'import pandas as pd\n# mock code', stdout: '', stderr: '', execution_ms: 4100,
  },
  analyze_performance: {
    ok: true,
    result: { insight_count: 5, risk_areas: 3 },
    artifacts: [
      { type: 'pivot_analysis', label: 'Analysis', data: [
        { dimension: 'Region × Product', finding: 'Greater China iPhone revenue down 8% YoY, highest discount rate (18.5%)', severity: 'High' },
        { dimension: 'Channel × Month', finding: 'Online channel grew 12% but return rate 6.2% vs retail 3.1%', severity: 'Medium' },
        { dimension: 'Product × Returns', finding: 'iPhone Pro Max return rate 8.2% in Europe, 2x average — display quality issue', severity: 'High' },
        { dimension: 'Inventory × SKU', finding: 'iPad base model at 14 weeks of supply vs 6-week target — overstock risk', severity: 'High' },
        { dimension: 'Marketing × ROAS', finding: 'Social media (6.2x) outperforms display ads (2.1x) — reallocate budget', severity: 'Medium' },
      ] },
      { type: 'insights', label: 'Management_Insights', data: [
        { insight: 'Revenue grew 3.2% YoY but gross margin declined 1.8pp due to aggressive discounting in Greater China', priority: 1 },
        { insight: 'iPhone Pro Max return rate in Europe (8.2%) is 2x average — 47 support tickets cite display issues', priority: 2 },
        { insight: 'Services revenue exceeded target by 12% driven by AppleCare+ attach rate improvement', priority: 3 },
        { insight: 'iPad inventory at 14 weeks of supply vs 6-week target — $120M overstock risk on base model', priority: 4 },
        { insight: 'Marketing ROAS for social (6.2x) significantly outperforms display ads (2.1x) — $5M reallocation opportunity', priority: 5 },
      ] },
    ],
    metadata: { description: 'Pivot analysis complete: 5 key findings, 5 management insights', artifact_count: 2, total_rows: 10 },
    code: 'import pandas as pd\n# mock code', stdout: '', stderr: '', execution_ms: 5400,
  },
};

const MOCK_PYTHON_REPORT_RESPONSE = {
  ok: true,
  pdf_base64: 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4K', // tiny valid PDF header
  html_preview: '<html><body><h1>MBR Dashboard</h1><p>Mock preview</p></body></html>',
  artifacts: [
    { type: 'pdf_report', label: 'MBR Dashboard (PDF)', data: { pdf_base64: 'mock', size_bytes: 45000 } },
    { type: 'html_report', label: 'MBR Dashboard (HTML)', data: { html: '<h1>MBR</h1>' } },
    { type: 'chart_images', label: 'Dashboard Charts', data: { charts: [{ label: 'Revenue Trend' }, { label: 'Regional Comparison' }], count: 2 } },
  ],
  execution_ms: 6200,
};

function generateMockCode(stepName) {
  const codeMap = {
    clean_data: `export function run(input) {
  const sheets = input.sheets || input.data || [];
  return {
    success: true,
    result: {
      total_rows: 5000, cleaned_rows: 4850, issues_found: 150,
      sheets_processed: ['Sales','Returns','Inventory','Marketing','Support Tickets','Targets'],
      quality_score: 0.92
    },
    artifacts: { cleaned_data: { status: 'ok', rows: 4850 } }
  };
}`,
    data_issues_log: `export function run(input) {
  const issues = [
    { issue_type: 'Date format inconsistent', field: 'order_date', count: 124, treatment: 'Converted to yyyy-mm-dd', risk: 'Low' },
    { issue_type: 'SKU naming mismatch', field: 'sku/product_name', count: 63, treatment: 'Mapped to standard names', risk: 'Low' },
    { issue_type: 'Duplicate transactions', field: 'order_id+sku', count: 41, treatment: 'Removed 27, kept 14 for review', risk: 'Medium' },
    { issue_type: 'Negative sales values', field: 'net_sales', count: 18, treatment: 'Classified as cancellations', risk: 'Low' },
    { issue_type: 'Missing region', field: 'region', count: 35, treatment: 'Inferred from store_id where possible', risk: 'Medium' },
  ];
  return { success: true, result: { issues, total_issues: issues.reduce((s,i) => s+i.count, 0) }, artifacts: { data_issues_log: issues } };
}`,
    calculate_kpis: `export function run(input) {
  const kpis = {
    total_revenue: 2847500000, total_units: 8523000, gross_profit: 1231000000,
    gross_margin_pct: 43.2, avg_selling_price: 334.12, return_rate: 4.8,
    discount_rate: 12.3, target_achievement: 97.2,
    revenue_by_region: { 'North America': 1138000000, 'Europe': 854000000, 'Greater China': 569000000, 'Japan': 285000000 },
    revenue_by_product: { 'iPhone': 1489000000, 'Services': 629000000, 'Mac': 307000000, 'iPad': 205000000, 'Wearables': 217000000 },
    inventory_coverage_weeks: 6.2, marketing_roas: 4.8, ticket_volume: 12500, avg_resolution_hours: 18.3
  };
  return { success: true, result: kpis, artifacts: { kpi_summary: kpis } };
}`,
    analyze_performance: `export function run(input) {
  const insights = [
    'Revenue grew 3.2% YoY but gross margin declined 1.8pp due to aggressive discounting in Greater China',
    'iPhone Pro Max return rate in Europe (8.2%) is 2x average — likely linked to 47 support tickets about display issues',
    'Services revenue exceeded target by 12% driven by AppleCare+ attach rate improvement',
    'iPad inventory at 14 weeks of supply vs 6-week target — significant overstock risk on base model',
    'Marketing ROAS for social media campaigns (6.2x) significantly outperformed display ads (2.1x)'
  ];
  return { success: true, result: { insights, risk_areas: ['Greater China margins', 'iPad inventory', 'iPhone Pro Max quality'] }, artifacts: { analysis: { insights } } };
}`,
  };
  return codeMap[stepName] || `export function run(input) {
  return { success: true, result: { message: 'Step ${stepName} completed' }, artifacts: {} };
}`;
}

let aiProxyCallCount = 0;

function buildAiProxyHandler() {
  return async (route) => {
    let parsed;
    try { parsed = JSON.parse(route.request().postData() || '{}'); } catch { parsed = {}; }
    const mode = parsed?.mode;
    const payload = parsed?.payload || parsed;
    aiProxyCallCount++;

    if (mode === 'ping') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'OK', provider: 'mock', model: 'mock' }) });
    }

    if (mode === 'di_prompt') {
      const prompt = payload?.prompt || '';
      if (prompt.includes('task planner') || prompt.includes('subtasks') || prompt.includes('decompose') || prompt.includes('workflow_type') || aiProxyCallCount <= 2) {
        console.log(`  🤖 [Mock] Decomposition (call #${aiProxyCallCount})`);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: JSON.stringify(MOCK_DECOMPOSITION), provider: 'gemini', model: 'gemini-2.0-flash', usage: { input_tokens: 500, output_tokens: 800 } }) });
      }
      // AI Review response
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: JSON.stringify({ approved: true, score: 0.92, suggestions: [] }), provider: 'gemini', model: 'gemini-2.0-flash', usage: { input_tokens: 200, output_tokens: 100 } }) });
    }

    // Code generation
    if (['gemini_generate', 'anthropic_chat', 'openai_chat', 'deepseek_chat'].includes(mode)) {
      const prompt = payload?.prompt || payload?.message || '';
      let stepName = 'unknown';
      if (prompt.includes('clean') || prompt.includes('quality') || prompt.includes('validate')) stepName = 'clean_data';
      else if (prompt.includes('issue') || prompt.includes('log') || prompt.includes('problem')) stepName = 'data_issues_log';
      else if (prompt.includes('KPI') || prompt.includes('kpi') || prompt.includes('metric') || prompt.includes('revenue')) stepName = 'calculate_kpis';
      else if (prompt.includes('analy') || prompt.includes('insight') || prompt.includes('performance')) stepName = 'analyze_performance';
      else if (prompt.includes('report') || prompt.includes('dashboard')) stepName = 'generate_report';

      console.log(`  🤖 [Mock] Code for: ${stepName} (call #${aiProxyCallCount})`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: generateMockCode(stepName), provider: 'gemini', model: 'gemini-2.0-flash', usage: { input_tokens: 300, output_tokens: 400 } }) });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'OK', provider: 'mock', model: 'mock' }) });
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildFakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${b}.${Buffer.from('e2e-fake').toString('base64url')}`;
}

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (UPLOAD_FILE && !fs.existsSync(UPLOAD_FILE)) {
    console.error(`❌ File not found: ${UPLOAD_FILE}`);
    process.exit(2);
  }

  const report = {
    started_at: new Date().toISOString(), base_url: BASE_URL, task_message: TASK_MESSAGE.slice(0, 200),
    upload_file: UPLOAD_FILE, use_real_llm: USE_REAL_LLM,
    phases: [], console_logs: [], console_errors: [], console_warnings: [],
    page_errors: [], network_errors: [], step_events: [], screenshots: [],
    final_status: 'unknown', summary: '',
  };

  const startTime = Date.now();

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🔍 Auto-Debug Loop — AI Employee Full E2E               ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  URL    : ${BASE_URL}`);
  console.log(`║  LLM    : ${USE_REAL_LLM ? '🟢 Real' : '🔵 Mock'}`);
  console.log(`║  Upload : ${UPLOAD_FILE ? path.basename(UPLOAD_FILE) : '(none)'}`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 150,
    args: ['--window-size=1400,900'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-TW' });
  const page = await context.newPage();

  // ─── Console collectors ─────────────────────────────────────────────────
  page.on('console', (msg) => {
    const entry = { time: ts(), type: msg.type(), text: msg.text() };
    if (msg.type() === 'error') {
      report.console_errors.push(entry);
      console.log(`  ❌ ERROR: ${msg.text().slice(0, 180)}`);
    } else if (msg.type() === 'warning') {
      report.console_warnings.push(entry);
    } else {
      report.console_logs.push(entry);
      const t = msg.text();
      if (t.includes('[aiProxy]') || t.includes('Step ') || t.includes('[DSV]') ||
          t.includes('decompos') || t.includes('agent loop') || t.includes('upload')) {
        console.log(`  📝 ${t.slice(0, 140)}`);
      }
    }
  });

  page.on('pageerror', (err) => {
    report.page_errors.push({ time: ts(), message: err.message, stack: err.stack?.slice(0, 500) });
    console.log(`  💥 PAGE ERROR: ${err.message.slice(0, 180)}`);
  });

  page.on('requestfailed', (req) => {
    if (!req.url().includes('realtime') && !req.url().includes('127.0.0.1:8000')) {
      report.network_errors.push({ time: ts(), url: req.url(), failure: req.failure()?.errorText });
    }
  });

  let ssIdx = 0;
  async function snap(label) {
    ssIdx++;
    const f = `${String(ssIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, f), fullPage: true });
    report.screenshots.push({ label, file: f, time: ts() });
    console.log(`  📸 ${f}`);
  }

  function phase(name, status = 'started', detail = '') {
    report.phases.push({ name, status, detail, time: ts() });
    const icon = status === 'ok' ? '✅' : status === 'error' ? '❌' : '🔄';
    console.log(`\n${icon} [${name}] ${detail}`);
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Setup mocks
    // ═══════════════════════════════════════════════════════════════════════
    phase('setup');

    if (SUPABASE_URL) {
      const now = Math.floor(Date.now() / 1000);
      const mockJwt = buildFakeJwt({ sub: 'e2e-user-001', aud: 'authenticated', role: 'authenticated', email: 'e2e@test.local', exp: now + 86400, iat: now, iss: `${SUPABASE_URL}/auth/v1`, app_metadata: { provider: 'email', providers: ['email'], role: 'admin' }, user_metadata: { full_name: 'E2E Tester' } });
      const mockUser = { id: 'e2e-user-001', aud: 'authenticated', role: 'authenticated', email: 'e2e@test.local', email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'], role: 'admin' }, user_metadata: { full_name: 'E2E Tester' }, identities: [], created_at: '2026-01-01T00:00:00Z' };

      await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
        const url = route.request().url();
        if (url.includes('/token') || url.includes('/user') || url.includes('/session')) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: mockJwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'e2e-refresh', user: mockUser }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
        const method = route.request().method();
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          return route.fulfill({ status: 201, contentType: 'application/json', body: route.request().postData() || '{}' });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      });

      await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) => {
        const url = route.request().url();
        if (url.includes('/ai-proxy')) {
          if (USE_REAL_LLM) return route.continue();
          return buildAiProxyHandler()(route);
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await page.route(`${SUPABASE_URL}/realtime/**`, (route) => route.abort());
    }

    // ── Mock Python API (localhost:8000) ──────────────────────────────────────
    // Intercept /execute-tool and /generate-report so we don't need the actual
    // Python FastAPI running during E2E tests.
    if (!USE_REAL_LLM) {
      await page.route('**/execute-tool', async (route) => {
        let parsed;
        try { parsed = JSON.parse(route.request().postData() || '{}'); } catch { parsed = {}; }
        const hint = (parsed.tool_hint || '').toLowerCase();

        let stepKey = 'clean_data';
        if (hint.includes('issue') || hint.includes('log') || hint.includes('quality issue')) stepKey = 'data_issues_log';
        else if (hint.includes('kpi') || hint.includes('metric') || hint.includes('revenue')) stepKey = 'calculate_kpis';
        else if (hint.includes('analy') || hint.includes('pivot') || hint.includes('insight') || hint.includes('performance')) stepKey = 'analyze_performance';
        else if (hint.includes('clean') || hint.includes('validate') || hint.includes('standardize')) stepKey = 'clean_data';

        const response = MOCK_PYTHON_TOOL_RESPONSES[stepKey] || MOCK_PYTHON_TOOL_RESPONSES.clean_data;
        console.log(`  🐍 [Mock Python] /execute-tool → ${stepKey} (${response.artifacts?.length || 0} artifacts)`);

        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      });

      await page.route('**/generate-report', async (route) => {
        console.log(`  🐍 [Mock Python] /generate-report → PDF + HTML`);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_PYTHON_REPORT_RESPONSE),
        });
      });
    }

    phase('setup', 'ok');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Navigate + auth
    // ═══════════════════════════════════════════════════════════════════════
    phase('navigate');
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');

    if (SUPABASE_URL) {
      await page.evaluate(([key]) => {
        const now = Math.floor(Date.now() / 1000);
        localStorage.setItem(key, JSON.stringify({
          access_token: 'mock-jwt-for-e2e', token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'e2e-refresh',
          user: { id: 'e2e-user-001', aud: 'authenticated', role: 'authenticated', email: 'e2e@test.local', app_metadata: { provider: 'email', providers: ['email'], role: 'admin' }, user_metadata: { full_name: 'E2E Tester' } },
        }));
      }, [`sb-${PROJECT_REF}-auth-token`]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    await snap('page-loaded');
    phase('navigate', 'ok');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Upload file (if provided)
    // ═══════════════════════════════════════════════════════════════════════
    if (UPLOAD_FILE) {
      phase('upload_file');

      // Need to open a conversation first — click "+ New"
      const newBtn = page.locator('button:has-text("New")').first();
      if (await newBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await newBtn.click();
        console.log('  📝 Created new conversation');
        await page.waitForTimeout(2000);
      }

      // Find the hidden file input (it has class="hidden" so we need 'attached' not 'visible')
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: 'attached', timeout: 15000 });

      // Upload via setInputFiles (Playwright magic — no need to click)
      await fileInput.setInputFiles(UPLOAD_FILE);
      console.log(`  📂 Uploading: ${path.basename(UPLOAD_FILE)}`);

      // Wait for upload processing
      // Look for "Processing..." then the completion message
      const uploadDone = page.locator('text=/loaded|sheet|rows|Upload complete/i');
      await uploadDone.waitFor({ state: 'visible', timeout: 60000 });

      await page.waitForTimeout(2000); // Let UI settle
      await snap('file-uploaded');
      phase('upload_file', 'ok', path.basename(UPLOAD_FILE));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: Send task message
    // ═══════════════════════════════════════════════════════════════════════
    phase('send_message');

    const chatInputSels = ['textarea[placeholder*="Message"]', 'textarea[placeholder*="message"]', 'textarea:not([placeholder*="Search"])'];
    let chatInput = null;
    for (const sel of chatInputSels) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { chatInput = el; break; }
    }

    if (!chatInput) {
      const newBtn = page.locator('button:has-text("New")').first();
      if (await newBtn.isVisible({ timeout: 3000 }).catch(() => false)) { await newBtn.click(); await page.waitForTimeout(2000); }
      for (const sel of chatInputSels) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { chatInput = el; break; }
      }
    }

    if (!chatInput) { phase('send_message', 'error', 'No chat input'); await snap('error-no-input'); throw new Error('Chat input not found'); }

    await chatInput.fill(TASK_MESSAGE);
    await page.waitForTimeout(300);
    await snap('message-typed');

    const sendBtn = page.locator('button[type="submit"][title="Send"], button[title="Send"]').first();
    if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) { await sendBtn.click(); }
    else { await chatInput.press('Enter'); }
    console.log('  📤 Task message sent!');
    phase('send_message', 'ok');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 5: Wait for decomposition
    // ═══════════════════════════════════════════════════════════════════════
    phase('decomposition');

    const clarLoc = page.locator('text=Quick Questions Before I Start');
    const planLoc = page.locator('text=Task Plan');
    let gotClar = false, gotPlan = false;

    for (let i = 0; i < 60; i++) {
      if (await clarLoc.isVisible({ timeout: 500 }).catch(() => false)) { gotClar = true; break; }
      if (await planLoc.isVisible({ timeout: 500 }).catch(() => false)) { gotPlan = true; break; }
    }

    if (gotClar) {
      console.log('  💬 ClarificationCard — skipping');
      await snap('clarification');
      const skipBtn = page.locator('button:has-text("Skip")').first();
      if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await skipBtn.click();
        for (let i = 0; i < 40; i++) { if (await planLoc.isVisible({ timeout: 1000 }).catch(() => false)) { gotPlan = true; break; } }
      }
    }

    if (gotPlan) {
      await snap('task-plan');
      const bodyText = await page.locator('body').textContent().catch(() => '');
      const steps = bodyText?.match(/(\d+)\s*step/i);
      const conf = bodyText?.match(/(\d+)%/);
      console.log(`  📋 TaskPlan: ${steps?.[1] || '?'} steps, ${conf?.[1] || '?'}%`);
      phase('decomposition', 'ok', `${steps?.[1] || '?'} steps`);
    } else {
      await snap('error-no-plan');
      const bodyText = await page.locator('body').textContent().catch(() => '');
      report.phases.push({ name: 'debug_dump', status: 'info', detail: bodyText?.slice(0, 2000), time: ts() });
      phase('decomposition', 'error', 'No TaskPlanCard');
      throw new Error('Decomposition failed — no TaskPlanCard');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 6: Approve
    // ═══════════════════════════════════════════════════════════════════════
    phase('approve');
    const approveBtn = page.locator('button:has-text("Approve"), button:has-text("approve")').first();
    if (await approveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await approveBtn.click();
      console.log('  ✅ Approved!');
      await snap('approved');
      phase('approve', 'ok');
    } else {
      await snap('error-no-approve');
      phase('approve', 'error');
      throw new Error('No Approve button');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 7: Monitor execution
    // ═══════════════════════════════════════════════════════════════════════
    phase('execution');
    const seenSteps = new Set();
    let lastStepTime = Date.now();
    let executionComplete = false;
    let lastPageText = '';

    console.log('  ⏳ Monitoring execution...\n');

    while (Date.now() - startTime < TOTAL_TIMEOUT) {
      await page.waitForTimeout(2000);
      const text = await page.locator('body').textContent().catch(() => '');

      // Parse step messages
      const re = /Step "([^"]+)":\s*([\s\S]*?)(?=Step "|$)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const name = m[1], detail = m[2].trim().slice(0, 300);
        const key = `${name}|${detail.slice(0, 50)}`;
        if (!seenSteps.has(key)) {
          seenSteps.add(key);
          lastStepTime = Date.now();
          const isErr = /error|fail|block/i.test(detail);
          const isHeal = /self-healing/i.test(detail);
          const icon = isErr ? '❌' : isHeal ? '🔧' : '✅';
          console.log(`  ${icon} Step "${name}": ${detail.slice(0, 120)}`);
          report.step_events.push({ step_name: name, detail, is_error: isErr, is_healing: isHeal, time: ts() });

          // Take screenshot on errors
          if (isErr) await snap(`step-error-${name}`).catch(() => {});
        }
      }

      if (/Done with|All \d+ step.*completed/i.test(text) && !lastPageText.includes('Done with')) {
        executionComplete = true;
        console.log('\n  🎉 Execution complete!');
        break;
      }
      if (/all steps blocked|task failed/i.test(text) && !lastPageText.includes('all steps blocked')) {
        console.log('\n  💀 All steps blocked!');
        await snap('all-blocked');
        break;
      }

      lastPageText = text;
      if (Date.now() - lastStepTime > STEP_TIMEOUT) {
        console.log('\n  ⏰ Timeout — no progress for 2min');
        await snap('timeout');
        break;
      }
    }

    await snap('final');
    phase('execution', executionComplete ? 'ok' : 'error', executionComplete ? 'Complete' : 'Failed');
    report.final_status = executionComplete ? 'SUCCESS' : 'FAILED';

  } catch (err) {
    report.final_status = 'CRASHED';
    report.summary = err.message;
    console.log(`\n  💥 CRASH: ${err.message}`);
    await snap('crash').catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Report
  // ═══════════════════════════════════════════════════════════════════════
  report.ended_at = new Date().toISOString();
  report.duration_ms = Date.now() - startTime;
  report.ai_proxy_calls = aiProxyCallCount;

  const errCount = report.console_errors.length + report.page_errors.length;
  const stepCount = report.step_events.length;
  const failedSteps = report.step_events.filter(s => s.is_error);
  const healingSteps = report.step_events.filter(s => s.is_healing);

  report.summary = `${report.final_status} | ${Math.round(report.duration_ms / 1000)}s | ${stepCount} steps (${failedSteps.length} failed) | ${errCount} errors | ${aiProxyCallCount} LLM calls`;

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  📊 Report                                                ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  ${report.summary}`);
  console.log(`║  Report: ${REPORT_PATH}`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (report.page_errors.length > 0) {
    console.log('─── JS Crashes ───');
    report.page_errors.forEach(e => console.log(`  💥 ${e.message.slice(0, 200)}`));
  }
  if (report.console_errors.length > 0) {
    console.log('─── Console Errors (top 10) ───');
    report.console_errors.slice(0, 10).forEach(e => console.log(`  ❌ ${e.text.slice(0, 200)}`));
  }
  if (failedSteps.length > 0) {
    console.log('─── Failed Steps ───');
    failedSteps.forEach(s => console.log(`  🔴 ${s.step_name}: ${s.detail.slice(0, 150)}`));
  }

  console.log('\n  ⏳ Browser open for 10s...');
  await page.waitForTimeout(10000);
  await browser.close();
  process.exit(report.final_status === 'SUCCESS' ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(2); });
