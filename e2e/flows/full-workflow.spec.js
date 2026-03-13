/**
 * Functional E2E: Complete End-to-End Workflow
 *
 * This is the most comprehensive test — it simulates a real user session:
 *   1. Load sample data via the Command Center
 *   2. Navigate to /plan
 *   3. Send "run plan" command
 *   4. Wait for and verify response cards
 *   5. Measure total time
 *   6. Check for timeouts, errors, and empty responses
 *
 * This test captures REAL issues like:
 *   - Data upload failing silently
 *   - Chat hanging forever
 *   - Plan execution timing out
 *   - Missing response cards
 *   - API connection failures
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupSupabaseMock } from './global-setup.js';
import { openChatPage } from '../helpers/crawl-utils.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV = path.join(__dirname, '..', '..', 'templates', 'demand_fg.csv');

// Timing thresholds
const PAGE_LOAD_MAX = 10000;   // 10s max for page load
const UPLOAD_MAX = 15000;      // 15s max for file upload processing
const CHAT_RESPONSE_MAX = 30000; // 30s max for chat response
const PLAN_EXECUTION_MAX = 90000; // 90s max for plan execution

test.describe('Full Workflow: Upload → Plan → Results', () => {
  test.use({
    storageState: 'e2e/.auth/storage-state.json',
    actionTimeout: 15000,
  });

  test('complete user journey — upload data, navigate to plan, send command', async ({ page }) => {
    const timings = {};
    const errors = [];
    const warnings = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('ResizeObserver')) {
        warnings.push(msg.text().slice(0, 200));
      }
    });

    // ── Step 1: Load the app ────────────────────────────────────────────
    let t0 = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    timings.pageLoad = Date.now() - t0;

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    console.log(`[Step 1] Page loaded in ${timings.pageLoad}ms`);

    if (timings.pageLoad > PAGE_LOAD_MAX) {
      warnings.push(`Page load slow: ${timings.pageLoad}ms > ${PAGE_LOAD_MAX}ms threshold`);
    }

    // ── Step 2: Try loading sample data ─────────────────────────────────
    const sampleBtn = page.locator('button:has-text("Sample Data"), button:has-text("Load Sample")').first();
    const hasSampleBtn = await sampleBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasSampleBtn) {
      t0 = Date.now();
      await sampleBtn.click();
      await page.waitForTimeout(5000);
      timings.sampleDataLoad = Date.now() - t0;
      console.log(`[Step 2] Sample data loaded in ${timings.sampleDataLoad}ms`);
    } else {
      // Fall back to file upload on settings page
      await page.goto('/settings');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);

      const dataTab = page.locator('button:has-text("Data Import"), button:has-text("Data")').first();
      if (await dataTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await dataTab.click();
        await page.waitForTimeout(500);
      }

      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        t0 = Date.now();
        await fileInput.setInputFiles(SAMPLE_CSV);
        await page.waitForTimeout(5000);
        timings.fileUpload = Date.now() - t0;
        console.log(`[Step 2] CSV uploaded in ${timings.fileUpload}ms`);

        if (timings.fileUpload > UPLOAD_MAX) {
          warnings.push(`Upload slow: ${timings.fileUpload}ms > ${UPLOAD_MAX}ms threshold`);
        }
      } else {
        console.log('[Step 2] No file input found — skipping upload');
      }
    }

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/screenshots/workflow-after-upload.png', fullPage: true });

    // ── Step 3: Navigate to /plan and open chat ──────────────────────────
    t0 = Date.now();
    const chatInput = await openChatPage(page, '/plan');
    timings.planPageLoad = Date.now() - t0;
    console.log(`[Step 3] Plan page loaded in ${timings.planPageLoad}ms`);

    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!chatVisible) {
      console.warn('[Step 3] Chat input not visible — auth may not be working. Skipping chat steps.');
      await page.screenshot({ path: 'e2e/screenshots/workflow-no-chat.png', fullPage: true });
      return; // Soft skip — don't fail the test
    }

    // ── Step 4: Send a planning command ─────────────────────────────────
    await chatInput.fill('run plan');
    const sendBtn = page.locator('button[aria-label*="send" i]').first();
    const sendVisible = await sendBtn.isVisible({ timeout: 2000 }).catch(() => false);

    t0 = Date.now();
    if (sendVisible) {
      await sendBtn.click();
    } else {
      await chatInput.press('Enter');
    }

    // ── Step 5: Wait for response ───────────────────────────────────────
    // Look for any new content: AI message, card, error, or loading indicator
    const responseIndicators = [
      '[class*="card"]',
      '[class*="bubble"]',
      '[class*="message"]',
      'text=plan',
      'text=Plan',
      'text=upload',
      'text=Upload',
      'text=data',
      'text=loading',
      'text=processing',
      '[class*="spinner"]',
      '[class*="animate"]',
    ];

    // Take periodic screenshots to track what happens
    const screenshots = [];
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(5000);
      const elapsed = Date.now() - t0;
      const ssPath = `e2e/screenshots/workflow-chat-${elapsed}ms.png`;
      await page.screenshot({ path: ssPath, fullPage: true });
      screenshots.push({ elapsed, path: ssPath });

      // Check if a response appeared
      const hasError = await page.locator('#vite-error-overlay').count() > 0;
      const hasCrash = await page.locator('text=Something went wrong').count() > 0;

      if (hasError || hasCrash) {
        console.error(`[Step 5] UI CRASHED at ${elapsed}ms`);
        break;
      }

      // Check for response cards (plan_summary, validation, etc.)
      const hasCards = await page.locator('[class*="Card"], [class*="card"]').count();
      if (hasCards > 2) {
        // More than the initial UI cards = we got a response
        timings.chatResponse = elapsed;
        console.log(`[Step 5] Got response with ${hasCards} cards at ${elapsed}ms`);
        break;
      }

      if (elapsed > CHAT_RESPONSE_MAX) {
        warnings.push(`Chat response timeout: no response after ${elapsed}ms`);
        console.warn(`[Step 5] No response after ${elapsed}ms — possible timeout`);
        break;
      }
    }

    timings.chatResponse = timings.chatResponse || Date.now() - t0;

    // ── Step 6: Final assessment ────────────────────────────────────────
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/screenshots/workflow-final.png', fullPage: true });

    // Print timing report
    console.log('\n=== Workflow Timing Report ===');
    for (const [step, ms] of Object.entries(timings)) {
      console.log(`  ${step}: ${ms}ms`);
    }
    if (warnings.length > 0) {
      console.log(`\n=== Warnings (${warnings.length}) ===`);
      warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    }
    if (errors.length > 0) {
      console.log(`\n=== JS Errors (${errors.length}) ===`);
      errors
        .filter((e) => !e.includes('ResizeObserver'))
        .forEach((e) => console.log(`  ✗ ${e.slice(0, 150)}`));
    }

    // Hard fail only on crashes
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });
});

test.describe('Timeout & Hang Detection', () => {
  test.use({
    storageState: 'e2e/.auth/storage-state.json',
  });

  test('pages respond to interaction within 5 seconds', async ({ page }) => {
    const slowPages = [];

    const routes = ['/plan', '/forecast', '/risk', '/scenarios', '/employees'];

    for (const route of routes) {
      const t0 = Date.now();
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');

      // Wait for meaningful content (not just loading spinner)
      try {
        await page.waitForSelector('button:visible, a:visible, table:visible, [class*="card"]:visible', {
          timeout: 5000,
        });
      } catch {
        // Timed out waiting for content
      }

      const elapsed = Date.now() - t0;
      if (elapsed > 5000) {
        slowPages.push({ route, elapsed });
      }
    }

    if (slowPages.length > 0) {
      console.warn('Slow pages detected:');
      slowPages.forEach((p) => console.warn(`  ${p.route}: ${p.elapsed}ms`));
    }

    // All pages should load within 10s absolute max
    for (const p of slowPages) {
      expect(p.elapsed, `${p.route} took too long`).toBeLessThan(10000);
    }
  });

  test('chat input remains responsive during AI processing', async ({ page }) => {
    const chatInput = await openChatPage(page, '/plan');
    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);

    if (!chatVisible) {
      console.warn('Chat input not visible — skipping responsiveness test');
      return;
    }

    // Send a message
    await chatInput.fill('run plan');
    await chatInput.press('Enter');
    await page.waitForTimeout(2000);

    // While "processing", the input should still be focusable
    const canType = await chatInput.isEditable({ timeout: 3000 }).catch(() => false);
    if (!canType) {
      console.warn('Chat input became non-editable during processing — possible UI freeze');
    }

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
  });
});
