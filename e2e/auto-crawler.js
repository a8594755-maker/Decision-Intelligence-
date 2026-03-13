#!/usr/bin/env node
/**
 * Autonomous UI Crawler
 *
 * Visits every route, clicks interactive elements, captures errors,
 * takes screenshots, and generates an HTML + JSON diagnostic report.
 *
 * Usage:  node e2e/auto-crawler.js
 *   or:  npm run test:auto-debug
 */

import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  collectErrors,
  checkErrorIndicators,
  discoverInteractiveElements,
  safeClick,
  waitForPageReady,
} from './helpers/crawl-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const STORAGE_STATE = path.join(__dirname, '.auth', 'storage-state.json');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

// ── Read Supabase URL for API interception ──────────────────────────────────
function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const match = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch { return null; }
}
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || readEnvVar('VITE_SUPABASE_URL') || '';

const ROUTES = [
  { path: '/', name: 'command-center' },
  { path: '/plan', name: 'plan-studio' },
  { path: '/forecast', name: 'forecast-studio' },
  { path: '/risk', name: 'risk-center' },
  { path: '/digital-twin', name: 'digital-twin' },
  { path: '/scenarios', name: 'scenario-studio' },
  { path: '/negotiation', name: 'negotiation' },
  { path: '/employees', name: 'employees' },
  { path: '/employees/tasks', name: 'employee-tasks' },
  { path: '/employees/review', name: 'employee-review' },
  { path: '/ops', name: 'ops-dashboard' },
  { path: '/sandbox', name: 'erp-sandbox' },
  { path: '/settings', name: 'settings' },
];

// ── Ensure auth state exists ────────────────────────────────────────────────
function ensureAuthState() {
  if (!fs.existsSync(STORAGE_STATE)) {
    console.log('Auth state not found. Running auth setup...');
    execSync('npx playwright test --project=setup', { stdio: 'inherit' });
  }
}

// ── Crawl a single route ────────────────────────────────────────────────────
async function crawlRoute(page, route) {
  const entry = {
    route: route.path,
    name: route.name,
    errors: [],
    warnings: [],
    indicators: [],
    elementsClicked: [],
    screenshotPath: '',
    duration: 0,
  };

  const start = Date.now();
  const { getErrors, cleanup } = collectErrors(page);

  try {
    // Navigate
    console.log(`  Navigating to ${route.path} ...`);
    await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForPageReady(page, { timeout: 8000 });

    // Screenshot
    const screenshotFile = `${route.name}.png`;
    const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotFile);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    entry.screenshotPath = screenshotFile;

    // Check error indicators
    entry.indicators = await checkErrorIndicators(page);

    // Discover and interact with elements
    const { buttons, tabs, inputs } = await discoverInteractiveElements(page);
    console.log(`    Found: ${buttons.length} buttons, ${tabs.length} tabs, ${inputs.length} inputs`);

    // Click tabs first (usually safe)
    for (const tab of tabs.slice(0, 10)) {
      const result = await safeClick(tab, page);
      if (result.clicked) {
        entry.elementsClicked.push({ type: 'tab', text: result.text.trim().slice(0, 60) });
      }
    }

    // Click buttons (limit to avoid infinite loops)
    for (const btn of buttons.slice(0, 15)) {
      const result = await safeClick(btn, page);
      if (result.clicked) {
        entry.elementsClicked.push({ type: 'button', text: result.text.trim().slice(0, 60) });
        // Check for new error indicators after click
        const newIndicators = await checkErrorIndicators(page);
        if (newIndicators.length > entry.indicators.length) {
          entry.warnings.push(`Error appeared after clicking: "${result.text.trim().slice(0, 40)}"`);
        }
      }
    }

    // Type into visible inputs (safe test string)
    for (const input of inputs.slice(0, 5)) {
      try {
        const tag = await input.evaluate((el) => el.tagName.toLowerCase());
        const type = await input.getAttribute('type');
        if (type === 'file' || type === 'hidden' || type === 'checkbox' || type === 'radio') continue;
        await input.fill('test-auto-crawler');
        entry.elementsClicked.push({ type: 'input', text: `${tag}[type=${type || 'text'}]` });
        // Clear after typing
        await input.fill('');
      } catch {
        // Input may have become invisible
      }
    }

    // Take post-interaction screenshot
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${route.name}-after.png`),
      fullPage: true,
    });
  } catch (err) {
    entry.errors.push({ type: 'navigation', text: err.message });
  }

  entry.errors.push(...getErrors());
  entry.duration = Date.now() - start;
  cleanup();

  const errorCount = entry.errors.length + entry.indicators.filter((i) => i.severity === 'error').length;
  const status = errorCount > 0 ? 'FAIL' : entry.warnings.length > 0 ? 'WARN' : 'OK';
  console.log(`    ${status} (${entry.errors.length} errors, ${entry.warnings.length} warnings, ${entry.duration}ms)`);

  return entry;
}

// ── Generate HTML report ────────────────────────────────────────────────────
function generateHtml(report) {
  const totalErrors = report.routes.reduce(
    (sum, r) => sum + r.errors.length + r.indicators.filter((i) => i.severity === 'error').length,
    0,
  );
  const totalWarnings = report.routes.reduce(
    (sum, r) => sum + r.warnings.length + r.indicators.filter((i) => i.severity === 'warning').length,
    0,
  );

  const routeRows = report.routes
    .map((r) => {
      const errorCount = r.errors.length + r.indicators.filter((i) => i.severity === 'error').length;
      const warnCount = r.warnings.length + r.indicators.filter((i) => i.severity === 'warning').length;
      const statusColor = errorCount > 0 ? '#fee2e2' : warnCount > 0 ? '#fef9c3' : '#dcfce7';
      const statusText = errorCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'OK';

      const errorList = [
        ...r.errors.map((e) => `<li class="error">JS: ${escapeHtml(e.text).slice(0, 200)}</li>`),
        ...r.indicators
          .filter((i) => i.severity === 'error')
          .map((i) => `<li class="error">UI: ${escapeHtml(i.msg)}</li>`),
        ...r.warnings.map((w) => `<li class="warning">${escapeHtml(w)}</li>`),
        ...r.indicators
          .filter((i) => i.severity === 'warning')
          .map((i) => `<li class="warning">UI: ${escapeHtml(i.msg)}</li>`),
      ].join('');

      const clickedList = r.elementsClicked
        .map((e) => `<span class="chip">${e.type}: ${escapeHtml(e.text)}</span>`)
        .join(' ');

      return `
      <div class="route-card" style="background:${statusColor}">
        <div class="route-header">
          <h3>${escapeHtml(r.name)} <code>${escapeHtml(r.route)}</code></h3>
          <span class="status-badge" style="background:${errorCount > 0 ? '#ef4444' : warnCount > 0 ? '#eab308' : '#22c55e'}">${statusText}</span>
          <span class="duration">${r.duration}ms</span>
        </div>
        ${r.screenshotPath ? `<div class="screenshots"><img src="screenshots/${r.screenshotPath}" alt="${r.name}" /><img src="screenshots/${r.name}-after.png" alt="${r.name} after" /></div>` : ''}
        ${errorList ? `<ul class="issues">${errorList}</ul>` : '<p class="no-issues">No issues</p>'}
        ${clickedList ? `<div class="clicked"><strong>Interacted:</strong> ${clickedList}</div>` : ''}
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Auto-Crawler Report — ${report.timestamp}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; }
  h1 { margin-bottom: 8px; }
  .summary { display: flex; gap: 16px; margin: 16px 0 24px; }
  .summary-card { padding: 12px 20px; border-radius: 8px; font-size: 18px; font-weight: 600; }
  .summary-card.routes { background: #dbeafe; }
  .summary-card.errors { background: #fee2e2; color: #dc2626; }
  .summary-card.warnings { background: #fef9c3; color: #ca8a04; }
  .summary-card.ok { background: #dcfce7; color: #16a34a; }
  .route-card { border-radius: 8px; padding: 16px; margin-bottom: 16px; border: 1px solid #e2e8f0; }
  .route-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .route-header h3 { flex: 1; }
  .route-header code { color: #6366f1; font-size: 14px; }
  .status-badge { color: white; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; }
  .duration { color: #94a3b8; font-size: 13px; }
  .screenshots { display: flex; gap: 8px; margin: 8px 0; }
  .screenshots img { max-width: 48%; max-height: 250px; border-radius: 6px; border: 1px solid #cbd5e1; object-fit: cover; cursor: pointer; }
  .screenshots img:hover { max-height: none; max-width: 100%; }
  .issues { list-style: none; padding: 0; }
  .issues li { padding: 4px 8px; margin: 2px 0; border-radius: 4px; font-size: 13px; word-break: break-all; }
  .issues .error { background: #fecaca; }
  .issues .warning { background: #fde68a; }
  .no-issues { color: #16a34a; font-size: 13px; }
  .clicked { margin-top: 8px; font-size: 12px; }
  .chip { display: inline-block; background: #e2e8f0; padding: 2px 8px; border-radius: 10px; margin: 2px; font-size: 11px; }
</style>
</head>
<body>
  <h1>Auto-Crawler Report</h1>
  <p>Generated: ${report.timestamp} | Base: ${report.baseUrl}</p>
  <div class="summary">
    <div class="summary-card routes">${report.routes.length} Routes</div>
    <div class="summary-card errors">${totalErrors} Errors</div>
    <div class="summary-card warnings">${totalWarnings} Warnings</div>
    <div class="summary-card ok">${report.routes.filter((r) => r.errors.length === 0 && r.indicators.filter((i) => i.severity === 'error').length === 0).length} OK</div>
  </div>
  ${routeRows}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Auto-Crawler: Autonomous UI Debug ===\n');

  ensureAuthState();
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Intercept ALL Supabase API calls — mock token is not a real JWT
  if (SUPABASE_URL) {
    // Auth endpoints
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'e2e-crawler-token',
          token_type: 'bearer',
          expires_in: 86400,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          refresh_token: 'e2e-refresh',
          user: { id: 'e2e-user-001', email: 'e2e@test.local', role: 'authenticated',
                  app_metadata: { role: 'admin' }, user_metadata: { full_name: 'E2E Tester' } },
        }),
      });
    });
    // REST API — return empty arrays for all queries (prevents 401 JWT errors)
    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
    // Edge Functions — return empty response
    await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) => {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({}),
      });
    });
    // Realtime — just abort to prevent hanging connections
    await page.route(`${SUPABASE_URL}/realtime/**`, (route) => route.abort());
  }

  const report = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE,
    routes: [],
  };

  for (const route of ROUTES) {
    const entry = await crawlRoute(page, route);
    report.routes.push(entry);
  }

  await browser.close();

  // Write reports
  const jsonPath = path.join(__dirname, 'crawler-report.json');
  const htmlPath = path.join(__dirname, 'crawler-report.html');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(htmlPath, generateHtml(report));

  const totalErrors = report.routes.reduce(
    (sum, r) => sum + r.errors.length + r.indicators.filter((i) => i.severity === 'error').length,
    0,
  );
  const totalWarnings = report.routes.reduce(
    (sum, r) => sum + r.warnings.length + r.indicators.filter((i) => i.severity === 'warning').length,
    0,
  );

  console.log(`\n=== Done ===`);
  console.log(`Routes: ${report.routes.length} | Errors: ${totalErrors} | Warnings: ${totalWarnings}`);
  console.log(`Report: ${htmlPath}`);
  console.log(`JSON:   ${jsonPath}`);

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Crawler failed:', err);
  process.exit(2);
});
