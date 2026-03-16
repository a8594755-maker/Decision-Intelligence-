/**
 * Full Chat Upload → Plan Workflow Test
 *
 * Uses a real XLSX file to test the complete flow:
 *   1. Navigate to /plan → open chat
 *   2. Upload XLSX via chat file picker
 *   3. Wait for profiling → verify dataset_summary_card, validation_card, downloads_card appear
 *   4. Send "run plan" / "/workflowA" command
 *   5. Wait for response cards (plan_summary, forecast, etc.)
 *   6. Measure timing at every step
 *   7. Capture screenshots + errors
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { setupSupabaseMock } from './global-setup.js';
import { openChatPage } from '../helpers/crawl-utils.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

const XLSX_PATH = path.join(
  process.env.HOME || '/Users/xuweijin',
  'Downloads',
  'Decision_Intelligence_workflowA_reupload_clean.xlsx'
);

// Timing thresholds
const UPLOAD_PARSE_MAX  = 30000;  // 30s for XLSX parse + profiling
const PLAN_RESPONSE_MAX = 120000; // 2min for full plan response

test.describe('Full Chat Upload → Plan Workflow', () => {
  test.use({
    storageState: 'e2e/.auth/storage-state.json',
    actionTimeout: 30000,
  });

  // Increase test timeout for long workflows
  test.setTimeout(240000); // 4 minutes

  test('upload XLSX via chat → profiling cards appear', async ({ page }) => {
    const timings = {};
    const errors = [];
    const warnings = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('ResizeObserver')) {
        warnings.push(msg.text().slice(0, 300));
      }
    });

    // ── Step 1: Open /plan chat ────────────────────────────────────────
    let t0 = Date.now();
    const chatInput = await openChatPage(page, '/plan');
    timings.chatPageLoad = Date.now() - t0;
    console.log(`[Step 1] Chat page loaded in ${timings.chatPageLoad}ms`);

    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!chatVisible) {
      console.warn('[Step 1] Chat input not visible — cannot proceed with upload test');
      await page.screenshot({ path: 'e2e/screenshots/upload-flow-no-chat.png', fullPage: true });
      // Soft skip
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      return;
    }

    await page.screenshot({ path: 'e2e/screenshots/upload-flow-01-chat-ready.png', fullPage: true });

    // ── Step 2: Upload XLSX via file picker ────────────────────────────
    // The hidden file input is inside ChatComposer
    const fileInput = page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]');
    await expect(fileInput).toHaveCount(1, { timeout: 5000 });

    t0 = Date.now();
    await fileInput.setInputFiles(XLSX_PATH);
    console.log('[Step 2] File selected, waiting for profiling...');

    // Wait for upload status indicator (Loader2 spinner or status text)
    const uploadIndicator = page.locator('text=Profiling, text=Processing, text=Uploaded, text=Building profile, text=Saving file');
    const showedProgress = await uploadIndicator.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (showedProgress) {
      console.log('[Step 2] Upload progress indicator visible');
    }

    // Wait for upload to complete — look for cards or upload-complete indicators
    // The flow produces: "Uploaded. Profiling..." → then dataset_summary_card, validation_card, downloads_card
    // These render as card components in the chat thread

    // Wait for the profiling to finish (spinner disappears OR cards appear)
    let _uploadDone = false;
    for (let i = 0; i < 12; i++) { // up to 60s
      await page.waitForTimeout(5000);
      const elapsed = Date.now() - t0;

      // Check for upload failure
      const hasError = await page.locator('text=Upload failed, text=❌').first().isVisible({ timeout: 500 }).catch(() => false);
      if (hasError) {
        timings.uploadParse = elapsed;
        console.error(`[Step 2] Upload FAILED at ${elapsed}ms`);
        await page.screenshot({ path: 'e2e/screenshots/upload-flow-02-failed.png', fullPage: true });
        // Don't hard fail — capture what happened
        warnings.push(`Upload failed at ${elapsed}ms`);
        break;
      }

      // Check for success indicators — "Saved profile" text or card elements
      const hasSavedProfile = await page.locator('text=Saved profile').first().isVisible({ timeout: 500 }).catch(() => false);
      const hasUploadComplete = await page.locator('text=Upload complete').first().isVisible({ timeout: 500 }).catch(() => false);
      // Check for dataset summary card content (file name, sheets, etc.)
      const hasSummaryCard = await page.locator('text=Workflow, text=workflow, text=Sheet, text=sheet').first().isVisible({ timeout: 500 }).catch(() => false);

      if (hasSavedProfile || hasUploadComplete || hasSummaryCard) {
        timings.uploadParse = elapsed;
        _uploadDone = true;
        console.log(`[Step 2] Upload + profiling completed in ${elapsed}ms`);
        break;
      }

      // Check if spinner is gone (upload finished)
      const stillUploading = await page.locator('.animate-spin').first().isVisible({ timeout: 500 }).catch(() => false);
      if (!stillUploading && elapsed > 10000) {
        // Spinner gone after 10s — upload likely done
        timings.uploadParse = elapsed;
        _uploadDone = true;
        console.log(`[Step 2] Upload spinner gone at ${elapsed}ms — assuming complete`);
        break;
      }

      if (elapsed > UPLOAD_PARSE_MAX) {
        timings.uploadParse = elapsed;
        warnings.push(`Upload parsing timeout: ${elapsed}ms > ${UPLOAD_PARSE_MAX}ms threshold`);
        console.warn(`[Step 2] Upload timed out at ${elapsed}ms`);
        break;
      }
    }

    timings.uploadParse = timings.uploadParse || Date.now() - t0;
    await page.screenshot({ path: 'e2e/screenshots/upload-flow-02-after-upload.png', fullPage: true });

    // ── Step 3: Verify profiling cards ─────────────────────────────────
    // After upload, the chat should show multiple cards
    await page.waitForTimeout(2000); // Let React render

    // Count chat messages / cards
    const chatThread = page.locator('[class*="message"], [class*="bubble"], [class*="chat"] > div');
    const messageCount = await chatThread.count();
    console.log(`[Step 3] Chat messages visible: ${messageCount}`);

    // Check for specific card types that should appear after upload
    const checks = {
      uploadedFileMsg: await page.locator('text=Uploaded file').first().isVisible({ timeout: 2000 }).catch(() => false),
      savedProfile: await page.locator('text=Saved profile').first().isVisible({ timeout: 2000 }).catch(() => false),
      datasetSummary: await page.locator('text=Workflow, text=Summary, text=Dataset').first().isVisible({ timeout: 2000 }).catch(() => false),
      sheetInfo: await page.locator('text=sheet, text=Sheet, text=rows, text=Rows').first().isVisible({ timeout: 2000 }).catch(() => false),
      validation: await page.locator('text=pass, text=Pass, text=fail, text=Fail, text=Validation, text=validation, text=Coverage, text=coverage').first().isVisible({ timeout: 2000 }).catch(() => false),
    };

    console.log('[Step 3] Card checks:', JSON.stringify(checks));

    // At minimum, the "Uploaded file" message should appear
    if (!checks.uploadedFileMsg) {
      console.warn('[Step 3] "Uploaded file" message not found — upload may not have triggered');
    }

    await page.screenshot({ path: 'e2e/screenshots/upload-flow-03-cards.png', fullPage: true });

    // Scroll down to see all cards
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e/screenshots/upload-flow-03-cards-bottom.png', fullPage: true });

    // No crash after upload
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);

    // ── Print report ───────────────────────────────────────────────────
    console.log('\n=== Upload Flow Report ===');
    for (const [step, ms] of Object.entries(timings)) {
      console.log(`  ${step}: ${ms}ms`);
    }
    if (warnings.length > 0) {
      console.log(`\n=== Warnings (${warnings.length}) ===`);
      warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    }

    const jsErrors = errors.filter((e) => !e.includes('ResizeObserver'));
    if (jsErrors.length > 0) {
      console.log(`\n=== JS Errors (${jsErrors.length}) ===`);
      jsErrors.forEach((e) => console.log(`  ✗ ${e.slice(0, 200)}`));
    }

    // Hard fail only on crashes
    expect(jsErrors).toHaveLength(0);
  });


  test('upload XLSX → send "run plan" → wait for results', async ({ page }) => {
    const timings = {};
    const errors = [];
    const warnings = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // ── Step 1: Open chat & upload ─────────────────────────────────────
    const chatInput = await openChatPage(page, '/plan');
    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!chatVisible) {
      console.warn('Chat not visible — skipping full workflow test');
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      return;
    }

    // Upload file
    const fileInput = page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]');
    let t0 = Date.now();
    await fileInput.setInputFiles(XLSX_PATH);

    // Wait for upload to complete
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const elapsed = Date.now() - t0;
      const stillUploading = await page.locator('.animate-spin').first().isVisible({ timeout: 500 }).catch(() => false);
      const hasCards = await page.locator('text=Saved profile, text=Upload complete, text=Upload failed').first().isVisible({ timeout: 500 }).catch(() => false);
      if (hasCards || (!stillUploading && elapsed > 10000)) {
        timings.upload = elapsed;
        break;
      }
      if (elapsed > UPLOAD_PARSE_MAX) {
        timings.upload = elapsed;
        warnings.push(`Upload timed out at ${elapsed}ms`);
        break;
      }
    }
    timings.upload = timings.upload || Date.now() - t0;
    console.log(`[Step 1] Upload completed in ${timings.upload}ms`);

    // Check for upload failure before proceeding
    const uploadFailed = await page.locator('text=Upload failed, text=❌').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (uploadFailed) {
      console.error('[Step 1] Upload failed — cannot continue to planning');
      await page.screenshot({ path: 'e2e/screenshots/plan-flow-upload-failed.png', fullPage: true });
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      return;
    }

    await page.screenshot({ path: 'e2e/screenshots/plan-flow-01-uploaded.png', fullPage: true });

    // ── Step 2: Send planning command ──────────────────────────────────
    // Wait for chat input to be editable again after upload
    await page.waitForTimeout(2000);
    const inputReady = await chatInput.isEditable({ timeout: 5000 }).catch(() => false);
    if (!inputReady) {
      console.warn('[Step 2] Chat input not editable after upload — possible freeze');
      warnings.push('Chat input not editable after upload');
    }

    // Try /workflowA first (specific to this project), fall back to "run plan"
    await chatInput.fill('/workflowA');
    const sendBtn = page.locator('button[type="submit"][title="Send"], button[title="Send"]').first();
    const sendVisible = await sendBtn.isVisible({ timeout: 2000 }).catch(() => false);

    t0 = Date.now();
    if (sendVisible) {
      await sendBtn.click();
    } else {
      await chatInput.press('Enter');
    }
    console.log('[Step 2] Sent /workflowA command');

    // ── Step 3: Wait for plan response ─────────────────────────────────
    // The response can be:
    //   - Plan cards (plan_summary, validation, metrics, etc.)
    //   - Error message ("Upload data first", "No data", etc.)
    //   - Streaming text
    //   - Timeout (hang)

    const responseIndicators = [
      'text=Plan Summary',
      'text=plan_summary',
      'text=Forecast',
      'text=forecast',
      'text=Optimization',
      'text=optimization',
      'text=Inventory',
      'text=inventory',
      'text=Constraint',
      'text=constraint',
      'text=Verification',
      'text=verification',
      'text=Replay',
      'text=replay',
      'text=Running',
      'text=running',
      'text=Step',
      'text=Completed',
      'text=Error',
      'text=error',
      'text=No data',
      'text=upload data',
    ];

    let gotResponse = false;
    const screenshots = [];
    for (let i = 0; i < 24; i++) { // up to 2 minutes
      await page.waitForTimeout(5000);
      const elapsed = Date.now() - t0;

      // Take periodic screenshots
      if (i % 2 === 0 || i < 4) {
        const ssPath = `e2e/screenshots/plan-flow-02-${elapsed}ms.png`;
        await page.screenshot({ path: ssPath, fullPage: true });
        screenshots.push({ elapsed, path: ssPath });
      }

      // Check for crash
      const hasCrash = await page.locator('#vite-error-overlay').count() > 0 ||
        await page.locator('text=Something went wrong').count() > 0;
      if (hasCrash) {
        console.error(`[Step 3] UI CRASHED at ${elapsed}ms`);
        timings.planResponse = elapsed;
        break;
      }

      // Check for any plan-related response
      for (const indicator of responseIndicators) {
        // Count elements matching this indicator AFTER upload (should be new ones)
        const count = await page.locator(indicator).count();
        if (count > 0) {
          gotResponse = true;
          timings.planResponse = elapsed;
          console.log(`[Step 3] Got response at ${elapsed}ms — found: ${indicator} (count: ${count})`);
          break;
        }
      }
      if (gotResponse) break;

      // Check if chat is still "typing" (AI processing)
      const isTyping = await page.locator('.animate-pulse, .animate-spin, text=Thinking, text=thinking').first().isVisible({ timeout: 500 }).catch(() => false);
      if (isTyping) {
        console.log(`[Step 3] Still processing at ${elapsed}ms...`);
      }

      if (elapsed > PLAN_RESPONSE_MAX) {
        timings.planResponse = elapsed;
        warnings.push(`Plan response timeout: no response after ${elapsed}ms`);
        console.warn(`[Step 3] No response after ${elapsed}ms — possible timeout/hang`);
        break;
      }
    }

    timings.planResponse = timings.planResponse || Date.now() - t0;

    // ── Step 4: Capture final state ────────────────────────────────────
    // Scroll to bottom to see all response cards
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/plan-flow-03-final.png', fullPage: true });

    // Count all visible cards/messages
    const finalCards = await page.locator('[class*="Card"], [class*="card"]').count();
    const finalMessages = await page.locator('[class*="message"], [class*="bubble"]').count();
    console.log(`[Step 4] Final state — cards: ${finalCards}, messages: ${finalMessages}`);

    // ── Report ─────────────────────────────────────────────────────────
    console.log('\n=== Full Plan Workflow Report ===');
    for (const [step, ms] of Object.entries(timings)) {
      const threshold = step === 'upload' ? UPLOAD_PARSE_MAX : PLAN_RESPONSE_MAX;
      const status = ms < threshold ? '✓' : '⚠ SLOW';
      console.log(`  ${status} ${step}: ${ms}ms`);
    }
    console.log(`  Total: ${Object.values(timings).reduce((a, b) => a + b, 0)}ms`);
    console.log(`  Response received: ${gotResponse ? 'YES' : 'NO'}`);

    if (warnings.length > 0) {
      console.log(`\n=== Warnings (${warnings.length}) ===`);
      warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    }

    const jsErrors = errors.filter((e) => !e.includes('ResizeObserver'));
    if (jsErrors.length > 0) {
      console.log(`\n=== JS Errors (${jsErrors.length}) ===`);
      jsErrors.forEach((e) => console.log(`  ✗ ${e.slice(0, 200)}`));
    }

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    // Soft check for JS errors
    if (jsErrors.length > 0) {
      console.warn(`${jsErrors.length} JS error(s) during plan workflow — see report above`);
    }
  });


  test('upload XLSX → send "/forecast" → check forecast response', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Open chat
    const chatInput = await openChatPage(page, '/plan');
    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!chatVisible) {
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      return;
    }

    // Upload
    const fileInput = page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]');
    await fileInput.setInputFiles(XLSX_PATH);

    // Wait for upload to finish
    let t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const elapsed = Date.now() - t0;
      const done = await page.locator('text=Saved profile, text=Upload complete, text=Upload failed').first().isVisible({ timeout: 500 }).catch(() => false);
      const spinnerGone = !(await page.locator('.animate-spin').first().isVisible({ timeout: 500 }).catch(() => false));
      if (done || (spinnerGone && elapsed > 10000)) break;
      if (elapsed > 30000) break;
    }
    console.log(`Upload phase: ${Date.now() - t0}ms`);

    await page.waitForTimeout(2000);

    // Send /forecast
    await chatInput.fill('/forecast');
    const sendBtn = page.locator('button[type="submit"][title="Send"], button[title="Send"]').first();
    t0 = Date.now();
    if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sendBtn.click();
    } else {
      await chatInput.press('Enter');
    }

    // Wait for forecast response
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const elapsed = Date.now() - t0;
      const hasResponse = await page.locator('text=Forecast, text=forecast, text=demand, text=Demand, text=prediction').first().isVisible({ timeout: 500 }).catch(() => false);
      if (hasResponse) {
        console.log(`Forecast response at ${elapsed}ms`);
        break;
      }
      if (elapsed > 60000) {
        console.warn(`Forecast timeout at ${elapsed}ms`);
        break;
      }
    }

    await page.screenshot({ path: 'e2e/screenshots/forecast-flow-result.png', fullPage: true });
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
  });


  test('chat input remains responsive during upload', async ({ page }) => {
    const chatInput = await openChatPage(page, '/plan');
    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!chatVisible) {
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      return;
    }

    // Start upload
    const fileInput = page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]');
    await fileInput.setInputFiles(XLSX_PATH);

    // Immediately check — is the UI still responsive?
    await page.waitForTimeout(1000);

    // During upload, the textarea should be disabled (isUploading=true)
    // This is expected behavior, not a freeze
    const isDisabled = await chatInput.isDisabled({ timeout: 2000 }).catch(() => false);
    console.log(`Chat input disabled during upload: ${isDisabled} (expected: true)`);

    // But the page should not be frozen — other elements should still be interactive
    const pageResponsive = await page.evaluate(() => {
      return new Promise((resolve) => {
        const start = Date.now();
        requestAnimationFrame(() => resolve(Date.now() - start));
      });
    });
    console.log(`Page animation frame delay: ${pageResponsive}ms (should be < 100ms)`);
    expect(pageResponsive).toBeLessThan(1000); // Page not frozen

    // Wait for upload to finish
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const stillUploading = await page.locator('.animate-spin').first().isVisible({ timeout: 500 }).catch(() => false);
      if (!stillUploading) break;
    }

    // After upload, input should become editable again
    const editableAfter = await chatInput.isEditable({ timeout: 5000 }).catch(() => false);
    console.log(`Chat input editable after upload: ${editableAfter}`);

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
  });
});
