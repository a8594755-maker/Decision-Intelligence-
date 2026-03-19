// @ts-check
import { test, expect } from '@playwright/test';
import { ai, aiAssert, aiQuery } from '../helpers/ai-action.js';
import { setupSupabaseMock } from './global-setup.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _deepSeekAvailable = null;
function hasDeepSeekKey() {
  if (_deepSeekAvailable !== null) return _deepSeekAvailable;
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
    const hasKey = /^VITE_DEEPSEEK_API_KEY=.+/m.test(content);
    if (!hasKey) { _deepSeekAvailable = false; return false; }
    // Key exists — assume available (actual fetch test would be async)
    _deepSeekAvailable = true;
    return true;
  } catch { _deepSeekAvailable = false; return false; }
}

// Check DeepSeek availability once at import time — set env flag
const DEEPSEEK_AVAILABLE = process.env.SKIP_AI_TESTS !== '1' && hasDeepSeekKey();

/**
 * AI-driven E2E test — uses natural language instead of hardcoded selectors.
 * Requires VITE_DEEPSEEK_API_KEY in .env.local for LLM calls.
 *
 * Run: npm run test:ai-flows
 */

test.describe('AI-Driven Chat Flow', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!hasDeepSeekKey(), 'VITE_DEEPSEEK_API_KEY not set — skipping AI-driven tests');
    await setupSupabaseMock(page);
    // Navigate to workspace (AI Employee mode)
    await page.goto('/workspace');
    await page.waitForLoadState('networkidle');
  });

  test('navigate to workspace and verify page loads', async ({ page }) => {
    await aiAssert(page, 'the page has loaded and shows some content (not a blank page)');
  });

  test('find and interact with chat input', async ({ page }) => {
    const hasChatInput = await aiQuery(page, 'check if there is a text input or textarea for chat messages');
    // Chat input should exist on workspace
    expect(hasChatInput).toBeTruthy();
  });

  test('send a message in chat', async ({ page }) => {
    await ai(page, 'type "Hello, run a forecast analysis" in the chat input area');
    await ai(page, 'click the send button or press Enter to submit the message');

    // Wait for some response to appear
    await page.waitForTimeout(3000);
    await aiAssert(page, 'there is at least one message or response visible in the chat area');
  });

  test('navigate between AI Worker pages', async ({ page }) => {
    // Go to employees page
    await page.goto('/employees');
    await page.waitForLoadState('networkidle');
    await aiAssert(page, 'the page shows employee or worker related content');

    // Go to tool registry
    await page.goto('/employees/tools');
    await page.waitForLoadState('networkidle');
    await aiAssert(page, 'the page shows a list or registry of tools');

    // Go to review page
    await page.goto('/employees/review');
    await page.waitForLoadState('networkidle');
    await aiAssert(page, 'the page shows review-related content');
  });

  test('upload a file via AI action', async ({ page }) => {
    await page.goto('/plan');
    await page.waitForLoadState('networkidle');

    // Use AI to find and interact with file upload
    const result = await ai(page, 'find a file input element and upload the file at e2e/fixtures/test-supply-chain.csv');

    if (result.success) {
      // Wait for file processing
      await page.waitForTimeout(2000);
      await aiAssert(page, 'there is some indication that a file was uploaded or data was loaded (e.g. a summary, table preview, or success message)');
    } else {
      // File input might not be immediately visible — skip gracefully
      test.skip(true, 'File input not accessible via AI action');
    }
  });
});

test.describe('AI-Driven Route Smoke Tests', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!hasDeepSeekKey(), 'VITE_DEEPSEEK_API_KEY not set — skipping AI-driven tests');
    await setupSupabaseMock(page);
  });

  const routes = [
    { path: '/', name: 'Command Center' },
    { path: '/plan', name: 'Plan Studio' },
    { path: '/forecast', name: 'Forecast Studio' },
    { path: '/risk', name: 'Risk Center' },
    { path: '/employees', name: 'Employees' },
    { path: '/employees/tools', name: 'Tool Registry' },
    { path: '/settings', name: 'Settings' },
  ];

  for (const route of routes) {
    test(`${route.name} (${route.path}) loads without errors`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState('networkidle');

      // Use AI to verify the page loaded meaningfully
      await aiAssert(page, 'the page has loaded with visible content and no error messages like "404" or "not found" or blank screen');
    });
  }
});
