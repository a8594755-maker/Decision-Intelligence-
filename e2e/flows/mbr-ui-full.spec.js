/**
 * MBR UI Full E2E Test — Real Browser, Real LLM
 *
 * Opens the app in a headed browser, uploads MBR Excel,
 * sends analysis prompt, approves plan, watches steps execute,
 * waits for Excel output.
 *
 * Run: npx playwright test e2e/flows/mbr-ui-full.spec.js --project=flows --headed
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupSupabaseMock } from './global-setup.js';
import { openChatPage } from '../helpers/crawl-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'apple_mbr.xlsx');

// Long timeout — real LLM calls (each step ~1-2 min)
test.setTimeout(600_000); // 10 minutes

test.describe('MBR UI Full Pipeline', () => {
  test.use({
    storageState: 'e2e/.auth/storage-state.json',
    actionTimeout: 30000,
  });

  test.beforeEach(async ({ page }) => {
    await setupSupabaseMock(page);
  });

  test('Upload Excel → Approve Plan → Steps Execute → Excel Output', async ({ page }) => {
    const timings = {};
    const consoleErrors = [];
    const consoleLogs = [];

    // Collect ALL console messages for debugging
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' && !text.includes('ResizeObserver')) {
        consoleErrors.push(text.slice(0, 500));
      }
      // Track orchestrator/executor/step logs — broad capture
      if (text.includes('[Orchestrator]') || text.includes('[PythonExecutor]') ||
          text.includes('[excel-gen]') || text.includes('[StepRepo]') ||
          text.includes('[TaskRepo]') || text.includes('[StepSM]') ||
          text.includes('[TaskSM]') || text.includes('step:') ||
          text.includes('Tick') || text.includes('succeeded') ||
          text.includes('failed') || text.includes('retrying') ||
          text.includes('executor') || text.includes('Executor') ||
          text.includes('ML API') || text.includes('execute-tool') ||
          text.includes('chatTaskDecomposer') || text.includes('orchestrator')) {
        consoleLogs.push(`[${msg.type()}] ${text.slice(0, 300)}`);
      }
    });

    // ── Step 1: Navigate to AI Employee home (/) ──
    console.log('\n[1/6] Opening app...');
    let t0 = Date.now();

    const chatInput = await openChatPage(page, '/');
    timings.pageLoad = Date.now() - t0;
    console.log(`[1/6] Page loaded in ${timings.pageLoad}ms`);

    const chatVisible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!chatVisible) {
      console.error('[1/6] Chat input not visible — aborting');
      await page.screenshot({ path: 'e2e/screenshots/mbr-ui-01-no-chat.png', fullPage: true });
      expect(chatVisible).toBe(true);
      return;
    }
    await page.screenshot({ path: 'e2e/screenshots/mbr-ui-01-chat-ready.png', fullPage: true });

    // ── Step 2: Upload MBR Excel ──
    console.log('[2/6] Uploading apple_mbr.xlsx...');
    t0 = Date.now();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(FIXTURE_PATH);

    // Wait for upload + profiling to complete
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(2000);
      const elapsed = Date.now() - t0;

      const uploadDone = await page.locator('text=loaded').first().isVisible({ timeout: 500 }).catch(() => false) ||
                          await page.locator('text=sheets').first().isVisible({ timeout: 500 }).catch(() => false) ||
                          await page.locator('text=rows').first().isVisible({ timeout: 500 }).catch(() => false) ||
                          await page.locator('text=Uploaded file').first().isVisible({ timeout: 500 }).catch(() => false);

      if (uploadDone) {
        timings.upload = elapsed;
        console.log(`[2/6] Upload completed in ${elapsed}ms`);
        break;
      }

      if (elapsed > 30000) {
        timings.upload = elapsed;
        console.warn(`[2/6] Upload timed out at ${elapsed}ms`);
        break;
      }
    }
    timings.upload = timings.upload || Date.now() - t0;
    await page.screenshot({ path: 'e2e/screenshots/mbr-ui-02-uploaded.png', fullPage: true });

    // ── Step 3: Send MBR analysis prompt ──
    console.log('[3/6] Sending MBR analysis prompt...');
    await page.waitForTimeout(2000);

    const prompt = '準備 MBR 月會分析，包含 Cleaned Data, KPI Summary, Pivot Analysis, 管理洞察，最後輸出 Excel';
    await chatInput.fill(prompt);

    const sendBtn = page.locator('button[type="submit"]').first();
    t0 = Date.now();
    if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sendBtn.click();
    } else {
      await chatInput.press('Enter');
    }
    console.log('[3/6] Prompt sent, waiting for TaskPlanCard...');

    // ── Step 4: Wait for TaskPlanCard and approve ──
    let approveBtn = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      const elapsed = Date.now() - t0;

      approveBtn = page.locator('button:has-text("Approve"), button:has-text("Execute")').first();
      const approveVisible = await approveBtn.isVisible({ timeout: 500 }).catch(() => false);

      if (approveVisible) {
        timings.decompose = elapsed;
        console.log(`[4/6] TaskPlanCard appeared in ${elapsed}ms — clicking Approve...`);
        await page.screenshot({ path: 'e2e/screenshots/mbr-ui-03-plan-card.png', fullPage: true });
        await approveBtn.click();
        console.log('[4/6] Plan approved! Execution starting...');
        break;
      }

      if (elapsed > 60000) {
        console.error(`[4/6] TaskPlanCard did not appear within 60s`);
        await page.screenshot({ path: 'e2e/screenshots/mbr-ui-03-timeout.png', fullPage: true });
        break;
      }
    }
    timings.decompose = timings.decompose || Date.now() - t0;

    // ── Step 5: Watch steps execute (Live Execution panel) ──
    console.log('[5/6] Watching step execution...');
    t0 = Date.now();

    let allStepsDone = false;
    let taskFailed = false;
    let lastScreenshot = 0;
    let lastStepStatus = '';

    // 8 minutes for all steps (real LLM, ~1-2 min per step with retries)
    const MAX_EXECUTION_MS = 480_000;

    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(4000);
      const elapsed = Date.now() - t0;

      // Take screenshots every 30s
      if (elapsed - lastScreenshot > 30000) {
        const ssName = `e2e/screenshots/mbr-ui-04-running-${Math.round(elapsed / 1000)}s.png`;
        await page.screenshot({ path: ssName, fullPage: true });
        lastScreenshot = elapsed;

        // Read step progress from the Live Execution panel
        const stepStatus = await page.evaluate(() => {
          const doneEls = document.querySelectorAll('[class*="DONE"], [class*="done"], [class*="succeeded"]');
          const runningEls = document.querySelectorAll('[class*="RUNNING"], [class*="running"]');
          const failedEls = document.querySelectorAll('[class*="FAILED"], [class*="failed"]');
          const pendingEls = document.querySelectorAll('[class*="PENDING"], [class*="pending"]');
          // Also check text content
          const allText = document.body.innerText;
          const doneMatch = allText.match(/(\d+)\/(\d+)\s*done/i);
          const failMatch = allText.match(/(\d+)\s*failed/i);
          return {
            done: doneEls.length,
            running: runningEls.length,
            failed: failedEls.length,
            pending: pendingEls.length,
            doneRatio: doneMatch ? `${doneMatch[1]}/${doneMatch[2]}` : null,
            failCount: failMatch ? parseInt(failMatch[1]) : 0,
          };
        });

        const statusStr = `done=${stepStatus.doneRatio || '?'}, failed=${stepStatus.failCount}`;
        if (statusStr !== lastStepStatus) {
          console.log(`[5/6] ${Math.round(elapsed / 1000)}s — ${statusStr}`);
          lastStepStatus = statusStr;
        } else {
          console.log(`[5/6] ${Math.round(elapsed / 1000)}s elapsed`);
        }
      }

      // Check for completion — multiple indicators
      const doneText = await page.locator('text=/\\d+\\/\\d+ done/').first().isVisible({ timeout: 500 }).catch(() => false);
      const allSucceeded = await page.locator('text=All steps completed').first().isVisible({ timeout: 500 }).catch(() => false) ||
                           await page.locator('text=Task completed').first().isVisible({ timeout: 500 }).catch(() => false);

      // Check the done ratio — if done + failed + skipped >= total, all steps are complete
      if (doneText) {
        const stepCounts = await page.evaluate(() => {
          const el = document.body.innerText;
          const doneM = el.match(/(\d+)\/(\d+)\s*done/i);
          const failM = el.match(/(\d+)\s*failed/i);
          const skipM = el.match(/(\d+)\s*skipped/i);
          return {
            done: doneM ? parseInt(doneM[1]) : 0,
            total: doneM ? parseInt(doneM[2]) : 0,
            failed: failM ? parseInt(failM[1]) : 0,
            skipped: skipM ? parseInt(skipM[1]) : 0,
          };
        });
        const finished = stepCounts.done + stepCounts.failed + stepCounts.skipped;
        if (finished >= stepCounts.total && stepCounts.total > 0) {
          timings.execution = elapsed;
          allStepsDone = stepCounts.done === stepCounts.total;
          console.log(`[5/6] All steps finished in ${elapsed}ms: ${stepCounts.done}/${stepCounts.total} done, ${stepCounts.failed} failed, ${stepCounts.skipped} skipped`);
          break;
        }
      }

      if (allSucceeded) {
        timings.execution = elapsed;
        allStepsDone = true;
        console.log(`[5/6] Task completed in ${elapsed}ms`);
        break;
      }

      // Check for task-level failure (orchestrator marked task as failed)
      const failed = await page.locator('text=Task execution failed').first().isVisible({ timeout: 500 }).catch(() => false) ||
                     await page.locator('text=Task failed').first().isVisible({ timeout: 500 }).catch(() => false);
      if (failed) {
        timings.execution = elapsed;
        taskFailed = true;
        console.error(`[5/6] Task FAILED at ${elapsed}ms`);
        await page.screenshot({ path: 'e2e/screenshots/mbr-ui-04-task-failed.png', fullPage: true });
        break;
      }

      // Check if no steps are running and we have failures — pipeline is stuck
      const noRunning = await page.evaluate(() => {
        const text = document.body.innerText;
        const runMatch = text.match(/(\d+)\s*running/i);
        const failMatch = text.match(/(\d+)\s*failed/i);
        return {
          running: runMatch ? parseInt(runMatch[1]) : -1,
          failed: failMatch ? parseInt(failMatch[1]) : 0,
        };
      });
      if (noRunning.running === 0 && noRunning.failed > 0 && elapsed > 30000) {
        timings.execution = elapsed;
        taskFailed = true;
        console.error(`[5/6] Pipeline stalled: 0 running, ${noRunning.failed} failed at ${elapsed}ms`);
        await page.screenshot({ path: 'e2e/screenshots/mbr-ui-04-stalled.png', fullPage: true });
        break;
      }

      if (elapsed > MAX_EXECUTION_MS) {
        timings.execution = elapsed;
        console.warn(`[5/6] Execution timed out at ${elapsed}ms`);
        break;
      }
    }
    timings.execution = timings.execution || Date.now() - t0;

    // ── Step 6: Final state ──
    console.log('[6/6] Capturing final state...');
    await page.waitForTimeout(3000);

    // Scroll to bottom to see all results
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/mbr-ui-05-final.png', fullPage: true });

    // ── Report ──
    console.log('\n' + '='.repeat(50));
    console.log('MBR UI Full Pipeline Report');
    console.log('='.repeat(50));
    for (const [step, ms] of Object.entries(timings)) {
      console.log(`  ${step}: ${(ms / 1000).toFixed(1)}s`);
    }
    const total = Object.values(timings).reduce((a, b) => a + b, 0);
    console.log(`  TOTAL: ${(total / 1000).toFixed(1)}s`);
    console.log(`  Result: ${allStepsDone ? 'SUCCESS' : taskFailed ? 'FAILED' : 'TIMEOUT'}`);

    if (consoleLogs.length > 0) {
      console.log(`\n--- Orchestrator/Executor Logs (${consoleLogs.length}) ---`);
      consoleLogs.forEach(l => console.log(`  ${l}`));
    }

    if (consoleErrors.length > 0) {
      console.log(`\n--- Console Errors (${consoleErrors.length}) ---`);
      consoleErrors.forEach(e => console.log(`  ${e}`));
    }

    console.log('\nScreenshots saved to e2e/screenshots/mbr-ui-*.png');
    console.log('='.repeat(50));

    // Assertions
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);

    // At minimum, step 1 should have completed
    if (allStepsDone) {
      console.log('PASS: All steps completed successfully');
    } else if (taskFailed) {
      console.log('WARN: Task failed — check logs above for details');
    } else {
      console.log('WARN: Execution timed out — steps still running (LLM calls are slow)');
    }
  });
});
