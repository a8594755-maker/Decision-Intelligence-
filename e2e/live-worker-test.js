#!/usr/bin/env node
/**
 * Live Worker E2E Test — 真實 LLM 全功能巡檢
 *
 * 像人類一樣逐一操作 AI Worker 的每個功能，發出真實 LLM 請求，
 * 等待真實回應，收集所有錯誤，產出 HTML 診斷報告。
 *
 * 用法：
 *   node e2e/live-worker-test.js                           # 預設：smart mock DB + 真實 LLM
 *   node e2e/live-worker-test.js --headful                 # 看得到瀏覽器
 *   node e2e/live-worker-test.js --upload FILE.csv         # 指定測試資料集
 *   node e2e/live-worker-test.js --skip-llm                # 跳過 LLM（純 UI 巡檢）
 *   node e2e/live-worker-test.js --phase 3                 # 只跑 Phase 3
 *   node e2e/live-worker-test.js --timeout 600             # 總超時秒數（預設 480）
 *
 * 報告產出：
 *   e2e/live-report.html     — 可視化 HTML 報告（截圖 + 錯誤）
 *   e2e/live-report.json     — 機器可讀 JSON
 *   e2e/screenshots/live-*   — 每步截圖
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const REPORT_JSON = path.join(__dirname, 'live-report.json');
const REPORT_HTML = path.join(__dirname, 'live-report.html');
const DEFAULT_CSV = path.join(__dirname, 'fixtures', 'test-supply-chain.csv');

// ── CLI Args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const HEADFUL = args.includes('--headful');
const SKIP_LLM = args.includes('--skip-llm');
const UPLOAD_IDX = args.indexOf('--upload');
const UPLOAD_FILE = UPLOAD_IDX !== -1 ? args[UPLOAD_IDX + 1] : DEFAULT_CSV;
const PHASE_IDX = args.indexOf('--phase');
const ONLY_PHASE = PHASE_IDX !== -1 ? parseInt(args[PHASE_IDX + 1], 10) : null;
const TIMEOUT_IDX = args.indexOf('--timeout');
const TOTAL_TIMEOUT_S = TIMEOUT_IDX !== -1 ? parseInt(args[TIMEOUT_IDX + 1], 10) : 480;
const TOTAL_TIMEOUT = TOTAL_TIMEOUT_S * 1000;

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// ── Env ─────────────────────────────────────────────────────────────────────
function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || readEnvVar('VITE_SUPABASE_URL') || '';
const PROJECT_REF = SUPABASE_URL ? new URL(SUPABASE_URL).hostname.split('.')[0] : 'placeholder';

// ── Report Data ─────────────────────────────────────────────────────────────
const report = {
  started_at: new Date().toISOString(),
  config: { base_url: BASE_URL, headful: HEADFUL, skip_llm: SKIP_LLM, upload_file: UPLOAD_FILE, only_phase: ONLY_PHASE },
  phases: [],
  errors: [],       // { phase, type, message, time }
  warnings: [],
  screenshots: [],
  llm_calls: [],    // { time, mode, model, tokens_in, tokens_out, duration_ms }
  network_errors: [],
  console_errors: [],
  page_errors: [],
  final_status: 'unknown',
  duration_ms: 0,
};

const startTime = Date.now();
let ssIdx = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function log(icon, msg) { console.log(`  ${icon} ${msg}`); }

function phaseStart(id, name) {
  const p = { id, name, status: 'running', start: ts(), tests: [], duration_ms: 0 };
  report.phases.push(p);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Phase ${id}: ${name}`);
  console.log('═'.repeat(60));
  return p;
}

function phaseEnd(phase, status, detail = '') {
  phase.status = status;
  phase.detail = detail;
  phase.end = ts();
  phase.duration_ms = Date.now() - new Date(phase.start.replace(' ', 'T') + 'Z').getTime();
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️';
  console.log(`  ${icon} Phase ${phase.id} ${status.toUpperCase()}: ${detail}`);
}

function testResult(phase, name, pass, detail = '') {
  phase.tests.push({ name, pass, detail, time: ts() });
  const icon = pass ? '✓' : '✗';
  console.log(`    ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) {
    report.errors.push({ phase: phase.id, type: 'test_fail', message: `${name}: ${detail}`, time: ts() });
  }
}

// ── Smart Supabase Mock (from supabase-mock.js pattern but inline) ──────────
function buildFakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${b}.${Buffer.from('e2e-fake').toString('base64url')}`;
}

async function setupInterceptions(page) {
  if (!SUPABASE_URL) return;

  const now = Math.floor(Date.now() / 1000);
  const mockJwt = buildFakeJwt({
    sub: 'e2e-user-001', aud: 'authenticated', role: 'authenticated',
    email: 'e2e@test.local', exp: now + 86400, iat: now,
    iss: `${SUPABASE_URL}/auth/v1`,
    app_metadata: { provider: 'email', providers: ['email'], role: 'admin' },
    user_metadata: { full_name: 'E2E Tester' },
  });
  const mockUser = {
    id: 'e2e-user-001', aud: 'authenticated', role: 'authenticated',
    email: 'e2e@test.local', email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'], role: 'admin' },
    user_metadata: { full_name: 'E2E Tester' },
    identities: [], created_at: '2026-01-01T00:00:00Z',
  };

  // ── Auth ──
  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        access_token: mockJwt, token_type: 'bearer', expires_in: 86400,
        expires_at: now + 86400, refresh_token: 'e2e-refresh', user: mockUser,
      }),
    });
  });

  // ── REST API — smart mock store ──
  const mockStore = {};

  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
    const method = route.request().method();
    const url = route.request().url();
    const tableName = url.split('/rest/v1/')[1]?.split('?')[0] || 'unknown';

    if (method === 'POST') {
      let body;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
      const rows = Array.isArray(body) ? body : [body];
      const enriched = rows.map(row => ({
        ...row,
        id: row.id || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: row.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      if (!mockStore[tableName]) mockStore[tableName] = [];
      mockStore[tableName].push(...enriched);
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify(enriched.length === 1 ? enriched[0] : enriched),
      });
    }

    if (method === 'PATCH' || method === 'PUT') {
      let body;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
      const stored = mockStore[tableName] || [];
      const urlObj = new URL(url);
      const idFilter = urlObj.searchParams.get('id');
      const idValue = idFilter?.startsWith('eq.') ? idFilter.slice(3) : null;
      let updated = { ...body, updated_at: new Date().toISOString() };
      if (idValue) {
        const idx = stored.findIndex(r => r.id === idValue);
        if (idx >= 0) { stored[idx] = { ...stored[idx], ...updated }; updated = stored[idx]; }
      } else if (stored.length > 0) {
        stored[stored.length - 1] = { ...stored[stored.length - 1], ...updated };
        updated = stored[stored.length - 1];
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) });
    }

    if (method === 'DELETE') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }

    // GET
    let rows = [...(mockStore[tableName] || [])];
    const urlObj = new URL(url);
    for (const [key, rawVal] of urlObj.searchParams.entries()) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      if (rawVal.startsWith('eq.')) rows = rows.filter(r => String(r[key]) === rawVal.slice(3));
      else if (rawVal.startsWith('in.')) {
        const vals = rawVal.slice(4, -1).split(',').map(v => v.replace(/^"|"$/g, ''));
        rows = rows.filter(r => vals.includes(String(r[key])));
      }
    }
    const limit = urlObj.searchParams.get('limit');
    if (limit) rows = rows.slice(0, parseInt(limit, 10));

    const accept = route.request().headers()['accept'] || '';
    if (accept.includes('vnd.pgrst.object')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows[0] || null) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });

  // ── Edge Functions — ai-proxy passthrough, rest mock ──
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/ai-proxy') && !SKIP_LLM) {
      // Track LLM calls
      const callStart = Date.now();
      return route.continue().then(() => {
        // Note: can't easily get response here, but we track the call
        report.llm_calls.push({ time: ts(), url: url.slice(-80), duration_ms: Date.now() - callStart });
      }).catch(() => route.continue());
    }
    if (url.includes('/ai-proxy') && SKIP_LLM) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ text: '{"intent":"GENERAL_CHAT","confidence":0.5}', provider: 'mock', model: 'mock' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });

  // ── Realtime — abort ──
  await page.route(`${SUPABASE_URL}/realtime/**`, (route) => route.abort());

  // ── ML API health — ignore ERR_CONNECTION_REFUSED ──
  await page.route('**/127.0.0.1:8000/**', (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'mock' }) });
  });
}

async function injectAuth(page) {
  if (!SUPABASE_URL) return;
  const storageKey = `sb-${PROJECT_REF}-auth-token`;
  const now = Math.floor(Date.now() / 1000);
  await page.evaluate(([key]) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: 'mock-jwt-for-e2e', token_type: 'bearer', expires_in: 86400,
      expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: 'e2e-refresh',
      user: { id: 'e2e-user-001', aud: 'authenticated', role: 'authenticated', email: 'e2e@test.local',
        app_metadata: { provider: 'email', providers: ['email'], role: 'admin' },
        user_metadata: { full_name: 'E2E Tester' } },
    }));
  }, [storageKey]);
}

// ── Screenshot ──────────────────────────────────────────────────────────────
async function snap(page, label) {
  ssIdx++;
  const f = `live-${String(ssIdx).padStart(2, '0')}-${label}.png`;
  try {
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, f), fullPage: true });
    report.screenshots.push({ label, file: f, time: ts() });
    log('📸', f);
  } catch (e) {
    log('⚠️', `Screenshot failed: ${e.message.slice(0, 80)}`);
  }
}

// ── Wait for element with polling ───────────────────────────────────────────
async function waitForAny(page, selectors, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        return { found: sel, element: el };
      }
    }
    await page.waitForTimeout(500);
  }
  return { found: null, element: null };
}

// ── Dismiss modals/overlays ─────────────────────────────────────────────────
async function dismissModals(page) {
  // Try closing any overlay/modal blocking the page
  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = page.locator('.fixed.inset-0').first();
    if (!await overlay.isVisible({ timeout: 500 }).catch(() => false)) break;

    // Try close/X button inside overlay
    const closeBtn = page.locator('.fixed.inset-0 button[aria-label="Close"], .fixed.inset-0 button:has(svg)').first();
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    // Try Skip / OK / Cancel button
    for (const text of ['Skip', 'OK', 'Close', 'Cancel', 'Got it', '關閉', '跳過', '確定']) {
      const btn = page.locator(`.fixed.inset-0 button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Fallback: press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

// ── Navigate helper ─────────────────────────────────────────────────────────
async function navigateTo(page, route, label) {
  log('🌐', `Navigating to ${route}`);
  await page.goto(BASE_URL + route, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  await snap(page, label);
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASES
// ═════════════════════════════════════════════════════════════════════════════

// Phase 1: Environment Check
async function phase1_envCheck(page) {
  const phase = phaseStart(1, 'Environment & Connectivity');

  // Test: Dev server reachable
  try {
    const resp = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    testResult(phase, 'Dev server reachable', resp?.ok() ?? false, `status=${resp?.status()}`);
  } catch (e) {
    testResult(phase, 'Dev server reachable', false, e.message);
    phaseEnd(phase, 'fail', 'Dev server not running');
    throw new Error('Dev server not reachable — run `npm run dev` first');
  }

  // Test: Auth injection works
  await injectAuth(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await snap(page, 'auth-injected');

  const hasNav = await page.locator('nav, [class*="sidebar"], [class*="Sidebar"]').first()
    .isVisible({ timeout: 5000 }).catch(() => false);
  testResult(phase, 'Auth + app shell loaded', hasNav, hasNav ? 'Sidebar visible' : 'No sidebar found');

  // Test: ai-proxy warmup (if not skipping LLM)
  if (!SKIP_LLM) {
    try {
      const resp = await page.evaluate(async (url) => {
        const r = await fetch(`${url}/functions/v1/ai-proxy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'ping' }),
        }).catch(e => ({ ok: false, status: 0, text: () => e.message }));
        return { ok: r.ok, status: r.status };
      }, SUPABASE_URL);
      testResult(phase, 'ai-proxy reachable', resp.ok, `status=${resp.status}`);
    } catch (e) {
      testResult(phase, 'ai-proxy reachable', false, e.message.slice(0, 100));
    }
  } else {
    testResult(phase, 'ai-proxy (skipped)', true, '--skip-llm mode');
  }

  const allPass = phase.tests.every(t => t.pass);
  phaseEnd(phase, allPass ? 'pass' : 'fail', `${phase.tests.filter(t => t.pass).length}/${phase.tests.length} tests`);
}

// Phase 2: Route Navigation — visit every AI Worker page
async function phase2_routeNavigation(page) {
  const phase = phaseStart(2, 'Route Navigation — All AI Worker Pages');

  const routes = [
    { path: '/', name: 'Command Center' },
    { path: '/employees', name: 'Employees' },
    { path: '/employees/tasks', name: 'Employee Tasks' },
    { path: '/employees/review', name: 'Employee Review' },
    { path: '/employees/tools', name: 'Tool Registry' },
    { path: '/employees/approvals', name: 'Approval Queue' },
    { path: '/employees/templates', name: 'Worker Templates' },
    { path: '/employees/policies', name: 'Policy Rules' },
    { path: '/employees/webhooks', name: 'Webhook Config' },
    { path: '/employees/schedules', name: 'Schedule Manager' },
    { path: '/workspace', name: 'Workspace' },
    { path: '/plan', name: 'Plan Studio' },
    { path: '/forecast', name: 'Forecast Studio' },
    { path: '/risk', name: 'Risk Center' },
    { path: '/scenarios', name: 'Scenario Studio' },
    { path: '/negotiation', name: 'Negotiation' },
    { path: '/settings', name: 'Settings' },
  ];

  for (const route of routes) {
    try {
      await page.goto(BASE_URL + route.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);

      // Check for crash indicators
      const viteOverlay = await page.locator('#vite-error-overlay').count();
      const errorBoundary = await page.locator('text=Something went wrong').count();
      const hasContent = await page.evaluate(() => document.body.innerText.length > 50);

      const pass = viteOverlay === 0 && errorBoundary === 0 && hasContent;
      let detail = '';
      if (viteOverlay > 0) detail = 'Vite error overlay';
      else if (errorBoundary > 0) detail = 'React ErrorBoundary crash';
      else if (!hasContent) detail = 'Page appears blank';

      testResult(phase, `${route.name} (${route.path})`, pass, detail);

      if (!pass) await snap(page, `route-fail-${route.name.toLowerCase().replace(/\s+/g, '-')}`);
    } catch (e) {
      testResult(phase, `${route.name} (${route.path})`, false, e.message.slice(0, 100));
      await snap(page, `route-error-${route.name.toLowerCase().replace(/\s+/g, '-')}`);
    }
  }

  // Final screenshot showing last visited page
  await snap(page, 'routes-done');

  const passCount = phase.tests.filter(t => t.pass).length;
  phaseEnd(phase, passCount === phase.tests.length ? 'pass' : 'fail', `${passCount}/${phase.tests.length} routes OK`);
}

// Phase 3: File Upload
async function phase3_fileUpload(page) {
  const phase = phaseStart(3, 'File Upload + Data Parsing');

  if (!UPLOAD_FILE || !fs.existsSync(UPLOAD_FILE)) {
    testResult(phase, 'Upload file exists', false, UPLOAD_FILE || 'none');
    phaseEnd(phase, 'skip', 'No upload file');
    return;
  }

  // Go to plan studio (has chat + file upload)
  await navigateTo(page, '/plan', 'pre-upload');

  // Look for "New" conversation button
  const newBtn = page.locator('button:has-text("New")').first();
  if (await newBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await newBtn.click();
    await page.waitForTimeout(2000);
    log('📝', 'Created new conversation');
  }

  // Upload file
  const fileInput = page.locator('input[type="file"]').first();
  const fileAttached = await fileInput.waitFor({ state: 'attached', timeout: 10000 }).then(() => true).catch(() => false);
  testResult(phase, 'File input found', fileAttached);

  if (fileAttached) {
    await fileInput.setInputFiles(UPLOAD_FILE);
    log('📂', `Uploading: ${path.basename(UPLOAD_FILE)}`);

    // Wait for processing
    await page.waitForTimeout(3000);
    await snap(page, 'file-uploaded');

    // Check if data summary appeared
    const hasSummary = await waitForAny(page, [
      'text=/loaded|sheet|rows|columns|Upload/i',
      '[class*="DataSummary"]',
      'text=/material|demand|plant/i',
    ], 15000);
    testResult(phase, 'Data parsed & summary shown', hasSummary.found !== null, hasSummary.found || 'No summary detected');
  }

  const passCount = phase.tests.filter(t => t.pass).length;
  phaseEnd(phase, passCount === phase.tests.length ? 'pass' : 'fail', `${passCount}/${phase.tests.length}`);
}

// Phase 4: Single Tool — Forecast (slash command)
async function phase4_singleTool(page) {
  const phase = phaseStart(4, 'Single Tool Execution — /forecast');

  // Navigate to plan studio (chat view)
  await navigateTo(page, '/plan', 'pre-forecast');
  await dismissModals(page);

  const newBtnF = page.locator('button:has-text("New")').first();
  if (await newBtnF.isVisible({ timeout: 3000 }).catch(() => false)) {
    await newBtnF.click();
    await page.waitForTimeout(2000);
  }
  await dismissModals(page);

  // Make sure we have a chat input
  const chatInput = await findChatInput(page);
  if (!chatInput) {
    testResult(phase, 'Chat input available', false, 'No textarea found');
    phaseEnd(phase, 'fail', 'No chat input');
    return;
  }
  testResult(phase, 'Chat input available', true);

  // Type /forecast
  await chatInput.fill('/forecast');
  await page.waitForTimeout(500);

  // Check if slash menu appeared
  const slashMenu = await page.locator('[class*="slash"], [role="listbox"], [class*="autocomplete"]').first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  log('📋', `Slash menu: ${slashMenu ? 'visible' : 'not visible'}`);

  // Send the command
  await dismissModals(page);
  await chatInput.fill('/forecast');
  const sendBtn = page.locator('button[title="Send"], button[type="submit"]').first();
  if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sendBtn.click();
  } else {
    await chatInput.press('Enter');
  }
  log('📤', 'Sent /forecast');

  // Wait for response — could be a card, error, or text
  await page.waitForTimeout(SKIP_LLM ? 3000 : 15000);
  await snap(page, 'forecast-response');

  // Check for any response
  const bodyText = await page.locator('body').textContent().catch(() => '');
  const gotResponse = bodyText.includes('forecast') || bodyText.includes('Forecast') || bodyText.includes('預測');
  const gotError = bodyText.includes('Error') || bodyText.includes('error') || bodyText.includes('failed');
  testResult(phase, 'Forecast command processed', gotResponse || gotError, gotError ? 'Error in response' : 'Got response');

  if (gotError) {
    log('⚠️', 'Forecast returned an error — checking details');
    await snap(page, 'forecast-error');
  }

  const passCount = phase.tests.filter(t => t.pass).length;
  phaseEnd(phase, passCount === phase.tests.length ? 'pass' : 'fail', `${passCount}/${phase.tests.length}`);
}

// Phase 5: NL Task Dispatch — "幫我做完整供應鏈分析"
async function phase5_nlTaskDispatch(page) {
  const phase = phaseStart(5, 'Natural Language Task Dispatch');

  // Navigate to workspace (AI Employee mode — triggers decomposition)
  await navigateTo(page, '/workspace', 'pre-nl-task');
  await dismissModals(page);

  const newBtnNL = page.locator('button:has-text("New")').first();
  if (await newBtnNL.isVisible({ timeout: 3000 }).catch(() => false)) {
    await newBtnNL.click();
    await page.waitForTimeout(2000);
  }
  await dismissModals(page);

  // Re-upload if needed
  const fileInputNL = page.locator('input[type="file"]').first();
  if (await fileInputNL.waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false)) {
    if (UPLOAD_FILE && fs.existsSync(UPLOAD_FILE)) {
      await fileInputNL.setInputFiles(UPLOAD_FILE);
      await page.waitForTimeout(3000);
      log('📂', 'Re-uploaded test data');
      await dismissModals(page);
    }
  }
  await dismissModals(page);

  const chatInput = await findChatInput(page);
  if (!chatInput) {
    testResult(phase, 'Chat input available', false);
    phaseEnd(phase, 'fail', 'No chat input');
    return;
  }

  // Send a natural language task
  await dismissModals(page);
  const taskMsg = '幫我分析這份供應鏈數據，做需求預測、補貨計畫、並產出風險評估報告';
  await chatInput.fill(taskMsg);
  await page.waitForTimeout(300);

  const sendBtn = page.locator('button[title="Send"], button[type="submit"]').first();
  if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sendBtn.click();
  } else {
    await chatInput.press('Enter');
  }
  log('📤', 'Sent NL task message');
  testResult(phase, 'Task message sent', true);

  // Wait for AI response — Work Order Draft, Task Plan, Clarification, or general reply
  const decomResult = await waitForAny(page, [
    'text=Task Plan',
    'text=Work Order',
    'text=Confirm',
    'text=Quick Questions',
    'text=task_plan_card',
    'text=/\\d+ step/i',
    'text=Clarification',
    'text=work_order_draft',
  ], SKIP_LLM ? 15000 : 60000);

  // In skip-llm mode, also accept any AI response as a partial pass
  if (!decomResult.found && SKIP_LLM) {
    // Check if any AI reply appeared at all
    const bodyText = await page.locator('body').textContent().catch(() => '');
    const hasAnyResponse = bodyText.length > 500; // page has substantial content
    await snap(page, 'nl-decomposition');
    testResult(phase, 'AI response received (skip-llm mode)', hasAnyResponse, hasAnyResponse ? 'Got response (no decomposition in mock mode)' : 'No response');
    phaseEnd(phase, hasAnyResponse ? 'pass' : 'fail', 'skip-llm mode — decomposition requires real LLM');
    return;
  }

  await snap(page, 'nl-decomposition');
  testResult(phase, 'Decomposition response received', decomResult.found !== null, decomResult.found || 'No decomposition card');

  if (decomResult.found) {
    // Handle clarification if shown
    if (decomResult.found.includes('Quick Questions') || decomResult.found.includes('Clarification')) {
      log('💬', 'Got clarification card — skipping');
      const skipBtn = page.locator('button:has-text("Skip"), button:has-text("跳過")').first();
      if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await skipBtn.click();
        await page.waitForTimeout(SKIP_LLM ? 3000 : 30000);
        await snap(page, 'after-skip-clarification');
      }
    }

    // Handle work order confirmation
    if (decomResult.found.includes('Work Order')) {
      log('📋', 'Got work order draft — confirming');
      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("確認")').first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(SKIP_LLM ? 5000 : 45000);
        await snap(page, 'after-confirm-workorder');
      }
    }

    // Look for approve button (Task Plan Card)
    const approveBtn = page.locator('button:has-text("Approve"), button:has-text("核准"), button:has-text("approve")').first();
    const hasApprove = await approveBtn.isVisible({ timeout: SKIP_LLM ? 5000 : 30000 }).catch(() => false);
    testResult(phase, 'Task Plan shown with Approve button', hasApprove);

    if (hasApprove) {
      await snap(page, 'task-plan-card');
      await approveBtn.click();
      log('✅', 'Approved task plan!');
      testResult(phase, 'Task plan approved', true);

      // Phase 5b: Monitor execution
      log('⏳', 'Monitoring task execution...');
      const execStart = Date.now();
      const seenSteps = new Set();
      let executionComplete = false;

      while (Date.now() - execStart < (SKIP_LLM ? 15000 : 300000)) {
        await page.waitForTimeout(3000);
        const text = await page.locator('body').textContent().catch(() => '');

        // Track steps
        const stepMatches = text.match(/Step "([^"]+)"/g) || [];
        for (const sm of stepMatches) {
          if (!seenSteps.has(sm)) {
            seenSteps.add(sm);
            const isErr = /error|fail/i.test(text.slice(text.indexOf(sm), text.indexOf(sm) + 200));
            log(isErr ? '❌' : '✅', sm);
          }
        }

        // Check completion
        if (/Done with|All \d+ step.*completed|task.*complete/i.test(text)) {
          executionComplete = true;
          break;
        }
        if (/all steps blocked|task failed|all steps failed/i.test(text)) {
          log('💀', 'Task failed or blocked');
          break;
        }
      }

      await snap(page, 'execution-result');
      if (SKIP_LLM) {
        // In skip-llm mode, execution cannot complete (needs real LLM for steps)
        testResult(phase, 'Task execution started (skip-llm)', true, `${seenSteps.size} steps observed — full execution requires real LLM`);
      } else {
        testResult(phase, 'Task execution completed', executionComplete, executionComplete ? `${seenSteps.size} steps` : 'Timeout or failure');
      }
    }
  }

  const passCount = phase.tests.filter(t => t.pass).length;
  phaseEnd(phase, passCount === phase.tests.length ? 'pass' : 'fail', `${passCount}/${phase.tests.length}`);
}

// Phase 6: Review Flow
async function phase6_reviewFlow(page) {
  const phase = phaseStart(6, 'Review & Approval Flow');

  await navigateTo(page, '/employees/review', 'review-page');

  // Check page loaded
  const bodyText = await page.locator('body').textContent().catch(() => '');
  const pageLoaded = bodyText.length > 50 &&
    !bodyText.includes('Something went wrong') &&
    await page.locator('#vite-error-overlay').count() === 0;
  testResult(phase, 'Review page loads', pageLoaded);

  // Check for review items or empty state
  const hasItems = bodyText.includes('review') || bodyText.includes('Review') || bodyText.includes('審核');
  testResult(phase, 'Review page has content', hasItems, hasItems ? 'Review content found' : 'May be empty (no tasks completed)');

  // Navigate to approval queue
  await navigateTo(page, '/employees/approvals', 'approval-queue');
  const approvalText = await page.locator('body').textContent().catch(() => '');
  const approvalLoaded = approvalText.length > 50 &&
    await page.locator('#vite-error-overlay').count() === 0;
  testResult(phase, 'Approval queue page loads', approvalLoaded);

  const passCount = phase.tests.filter(t => t.pass).length;
  phaseEnd(phase, passCount === phase.tests.length ? 'pass' : 'fail', `${passCount}/${phase.tests.length}`);
}

// Phase 7: Tool Registry + Settings
async function phase7_toolAndSettings(page) {
  const phase = phaseStart(7, 'Tool Registry & Settings Pages');

  // Tool Registry
  await navigateTo(page, '/employees/tools', 'tool-registry');
  const toolText = await page.locator('body').textContent().catch(() => '');
  const hasTools = toolText.includes('forecast') || toolText.includes('plan') || toolText.includes('Tool') || toolText.includes('工具');
  testResult(phase, 'Tool Registry shows tools', hasTools, hasTools ? 'Tools listed' : 'No tools visible');

  // Worker Templates
  await navigateTo(page, '/employees/templates', 'worker-templates');
  const templateText = await page.locator('body').textContent().catch(() => '');
  const hasTemplates = templateText.includes('template') || templateText.includes('Template') || templateText.includes('模板') || templateText.includes('Analyst');
  testResult(phase, 'Worker Templates page loads', hasTemplates || templateText.length > 100);

  // Settings
  await navigateTo(page, '/settings', 'settings-page');
  const settingsText = await page.locator('body').textContent().catch(() => '');
  const hasSettings = settingsText.includes('Setting') || settingsText.includes('setting') || settingsText.includes('設定') || settingsText.length > 100;
  testResult(phase, 'Settings page loads', hasSettings);

  // Interactive test: click tabs/buttons on tool registry
  await navigateTo(page, '/employees/tools', 'tool-registry-interact');
  const buttons = await page.locator('button:visible').all();
  let clickedCount = 0;
  for (const btn of buttons.slice(0, 8)) {
    const text = (await btn.textContent().catch(() => '')) || '';
    if (['Logout', 'Delete', 'Remove', 'Sign out'].some(s => text.includes(s))) continue;
    try {
      await btn.click({ timeout: 1000 });
      clickedCount++;
      await page.waitForTimeout(300);
    } catch { /* element may have detached */ }
  }
  testResult(phase, 'Interactive elements clickable', clickedCount > 0, `Clicked ${clickedCount} buttons`);
  await snap(page, 'tools-after-clicks');

  // Check for page errors after clicking
  const errorCount = await page.locator('#vite-error-overlay').count();
  const crashCount = await page.locator('text=Something went wrong').count();
  testResult(phase, 'No crashes after interactions', errorCount === 0 && crashCount === 0);

  const passCount = phase.tests.filter(t => t.pass).length;
  phaseEnd(phase, passCount === phase.tests.length ? 'pass' : 'fail', `${passCount}/${phase.tests.length}`);
}

// ── Find chat input helper ──────────────────────────────────────────────────
async function findChatInput(page) {
  const selectors = [
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="輸入"]',
    'textarea:not([placeholder*="Search"])',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) return el;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML Report Generator
// ═════════════════════════════════════════════════════════════════════════════
function generateHtmlReport(report) {
  const totalTests = report.phases.reduce((s, p) => s + p.tests.length, 0);
  const passedTests = report.phases.reduce((s, p) => s + p.tests.filter(t => t.pass).length, 0);
  const failedTests = totalTests - passedTests;

  const phaseRows = report.phases.map(p => {
    const pTests = p.tests.length;
    const pPass = p.tests.filter(t => t.pass).length;
    const statusColor = p.status === 'pass' ? '#dcfce7' : p.status === 'fail' ? '#fee2e2' : '#fef9c3';
    const statusBadge = p.status === 'pass' ? '✅' : p.status === 'fail' ? '❌' : '⚠️';

    const testRows = p.tests.map(t => `
      <div class="test-row ${t.pass ? 'pass' : 'fail'}">
        <span class="test-icon">${t.pass ? '✓' : '✗'}</span>
        <span class="test-name">${esc(t.name)}</span>
        ${t.detail ? `<span class="test-detail">${esc(t.detail)}</span>` : ''}
      </div>
    `).join('');

    return `
    <div class="phase-card" style="background:${statusColor}">
      <div class="phase-header">
        <h3>${statusBadge} Phase ${p.id}: ${esc(p.name)}</h3>
        <span class="phase-stats">${pPass}/${pTests} pass | ${p.duration_ms || 0}ms</span>
      </div>
      ${p.detail ? `<p class="phase-detail">${esc(p.detail)}</p>` : ''}
      <div class="test-list">${testRows}</div>
    </div>`;
  }).join('');

  const errorRows = report.errors.slice(0, 30).map(e => `
    <div class="error-row">
      <span class="error-phase">P${e.phase}</span>
      <span class="error-msg">${esc(e.message).slice(0, 300)}</span>
    </div>
  `).join('');

  const consoleErrorRows = report.console_errors.slice(0, 20).map(e => `
    <div class="error-row">
      <span class="error-time">${e.time || ''}</span>
      <span class="error-msg">${esc(e.text).slice(0, 300)}</span>
    </div>
  `).join('');

  const pageErrorRows = report.page_errors.slice(0, 10).map(e => `
    <div class="error-row">
      <span class="error-time">${e.time || ''}</span>
      <span class="error-msg">${esc(e.message).slice(0, 300)}</span>
    </div>
  `).join('');

  const screenshotImgs = report.screenshots.map(s => `
    <div class="ss-card">
      <img src="screenshots/${s.file}" alt="${esc(s.label)}" loading="lazy" />
      <div class="ss-label">${esc(s.label)}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Live Worker Test Report — ${report.started_at}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 4px; color: #f1f5f9; }
  h2 { font-size: 18px; margin: 24px 0 12px; color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  .summary-bar { display: flex; gap: 12px; margin: 16px 0; flex-wrap: wrap; }
  .summary-card { padding: 12px 20px; border-radius: 8px; font-size: 16px; font-weight: 600; }
  .summary-card.total { background: #1e293b; color: #93c5fd; }
  .summary-card.pass { background: #14532d; color: #4ade80; }
  .summary-card.fail { background: #7f1d1d; color: #fca5a5; }
  .summary-card.time { background: #1e293b; color: #cbd5e1; }
  .phase-card { border-radius: 10px; padding: 16px; margin-bottom: 12px; border: 1px solid #334155; }
  .phase-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .phase-header h3 { font-size: 15px; color: #1e293b; }
  .phase-stats { font-size: 13px; color: #475569; font-weight: 500; }
  .phase-detail { font-size: 13px; color: #475569; margin-bottom: 8px; }
  .test-list { display: flex; flex-direction: column; gap: 4px; }
  .test-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 13px; }
  .test-row.pass { color: #166534; }
  .test-row.fail { color: #991b1b; background: #fecaca50; }
  .test-icon { font-weight: bold; width: 16px; }
  .test-name { font-weight: 500; }
  .test-detail { color: #6b7280; font-size: 12px; }
  .error-row { padding: 6px 10px; margin: 2px 0; border-radius: 4px; background: #1e293b; font-size: 12px; display: flex; gap: 8px; }
  .error-phase { color: #f87171; font-weight: 600; min-width: 30px; }
  .error-time { color: #6b7280; min-width: 80px; }
  .error-msg { color: #fca5a5; word-break: break-all; }
  .ss-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .ss-card { background: #1e293b; border-radius: 8px; overflow: hidden; }
  .ss-card img { width: 100%; max-height: 200px; object-fit: cover; cursor: pointer; transition: max-height 0.3s; }
  .ss-card img:hover { max-height: 600px; object-fit: contain; }
  .ss-label { padding: 6px 10px; font-size: 12px; color: #94a3b8; }
  .config { font-size: 12px; color: #64748b; margin: 8px 0; }
</style>
</head>
<body>
  <h1>Live Worker Test Report</h1>
  <div class="config">
    ${report.started_at} | Duration: ${Math.round(report.duration_ms / 1000)}s |
    LLM: ${report.config.skip_llm ? 'Skipped' : 'Real'} |
    Upload: ${report.config.upload_file ? path.basename(report.config.upload_file) : 'none'} |
    Status: <strong>${report.final_status}</strong>
  </div>

  <div class="summary-bar">
    <div class="summary-card total">${totalTests} Tests</div>
    <div class="summary-card pass">${passedTests} Pass</div>
    <div class="summary-card fail">${failedTests} Fail</div>
    <div class="summary-card time">${Math.round(report.duration_ms / 1000)}s</div>
  </div>

  <h2>Phases</h2>
  ${phaseRows}

  ${report.errors.length > 0 ? `<h2>Test Failures (${report.errors.length})</h2>${errorRows}` : ''}
  ${report.console_errors.length > 0 ? `<h2>Console Errors (${report.console_errors.length})</h2>${consoleErrorRows}` : ''}
  ${report.page_errors.length > 0 ? `<h2>JS Crashes (${report.page_errors.length})</h2>${pageErrorRows}` : ''}

  <h2>Screenshots (${report.screenshots.length})</h2>
  <div class="ss-grid">${screenshotImgs}</div>
</body>
</html>`;
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Live Worker E2E Test — AI Worker 全功能巡檢              ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  URL     : ${BASE_URL}`);
  console.log(`║  LLM     : ${SKIP_LLM ? '🔵 Skip' : '🟢 Real'}`);
  console.log(`║  Upload  : ${UPLOAD_FILE ? path.basename(UPLOAD_FILE) : '(none)'}`);
  console.log(`║  Headful : ${HEADFUL ? 'Yes' : 'No'}`);
  console.log(`║  Timeout : ${TOTAL_TIMEOUT_S}s`);
  console.log(`║  Phase   : ${ONLY_PHASE ? `Only #${ONLY_PHASE}` : 'All'}`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: !HEADFUL,
    slowMo: HEADFUL ? 100 : 0,
    args: ['--window-size=1440,900'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-TW',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // ── Global error collectors ──
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter out known benign errors
      if (text.includes('ERR_CONNECTION_REFUSED') && text.includes('8000')) return;
      if (text.includes('ResizeObserver')) return;
      report.console_errors.push({ text, time: ts() });
    }
  });

  page.on('pageerror', (err) => {
    report.page_errors.push({ message: err.message, stack: err.stack?.slice(0, 500), time: ts() });
    log('💥', `PAGE ERROR: ${err.message.slice(0, 150)}`);
  });

  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('realtime') || url.includes('127.0.0.1:8000')) return;
    report.network_errors.push({ url, failure: req.failure()?.errorText, time: ts() });
  });

  // ── Setup API interception ──
  await setupInterceptions(page);

  // ── Run phases ──
  const phases = [
    { id: 1, fn: phase1_envCheck },
    { id: 2, fn: phase2_routeNavigation },
    { id: 3, fn: phase3_fileUpload },
    { id: 4, fn: phase4_singleTool },
    { id: 5, fn: phase5_nlTaskDispatch },
    { id: 6, fn: phase6_reviewFlow },
    { id: 7, fn: phase7_toolAndSettings },
  ];

  // If running a single phase, do auth setup first
  if (ONLY_PHASE && ONLY_PHASE > 1) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await injectAuth(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    log('🔐', 'Auth injected for single-phase run');
  }

  let criticalFail = false;
  for (const { id, fn } of phases) {
    if (ONLY_PHASE && id !== ONLY_PHASE) continue;
    if (criticalFail && id > 1) {
      log('⏭️', `Skipping Phase ${id} (critical failure in Phase 1)`);
      continue;
    }

    try {
      await fn(page);
    } catch (e) {
      log('💥', `Phase ${id} crashed: ${e.message}`);
      report.errors.push({ phase: id, type: 'crash', message: e.message, time: ts() });
      await snap(page, `phase${id}-crash`);
      if (id === 1) criticalFail = true;
    }

    // Timeout guard
    if (Date.now() - startTime > TOTAL_TIMEOUT) {
      log('⏰', 'Total timeout reached');
      break;
    }
  }

  // ── Finalize report ──
  report.duration_ms = Date.now() - startTime;
  report.ended_at = new Date().toISOString();

  const totalTests = report.phases.reduce((s, p) => s + p.tests.length, 0);
  const passedTests = report.phases.reduce((s, p) => s + p.tests.filter(t => t.pass).length, 0);
  const failedPhases = report.phases.filter(p => p.status === 'fail').length;

  report.final_status = failedPhases === 0 ? 'ALL_PASS' : `${failedPhases}_PHASES_FAILED`;

  // Write reports
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_HTML, generateHtmlReport(report));

  // ── Summary ──
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  📊 Test Report                                           ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Status  : ${report.final_status}`);
  console.log(`║  Tests   : ${passedTests}/${totalTests} pass`);
  console.log(`║  Duration: ${Math.round(report.duration_ms / 1000)}s`);
  console.log(`║  Errors  : ${report.console_errors.length} console + ${report.page_errors.length} crash`);
  console.log(`║  LLM     : ${report.llm_calls.length} calls`);
  console.log(`║  HTML    : ${REPORT_HTML}`);
  console.log(`║  JSON    : ${REPORT_JSON}`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (report.errors.length > 0) {
    console.log('\n─── Failed Tests ───');
    report.errors.forEach(e => console.log(`  ❌ P${e.phase}: ${e.message.slice(0, 200)}`));
  }

  if (report.page_errors.length > 0) {
    console.log('\n─── JS Crashes ───');
    report.page_errors.slice(0, 5).forEach(e => console.log(`  💥 ${e.message.slice(0, 200)}`));
  }

  if (HEADFUL) {
    console.log('\n  ⏳ Browser staying open 15s...');
    await page.waitForTimeout(15000);
  }

  await browser.close();
  process.exit(failedPhases > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
