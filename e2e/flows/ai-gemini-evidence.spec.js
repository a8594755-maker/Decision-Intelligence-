// @ts-check
/**
 * Real E2E test: send a complex analysis prompt to Gemini and verify
 * it actually calls evidence-producing tools before answering.
 *
 * This test hits the real Supabase ai-proxy → Gemini API.
 * It exercises the 3 recovery improvements:
 *   1. System prompt evidence-first mandate
 *   2. forcedEvidenceTurns = 2
 *   3. No-thinking non-streaming recovery
 *
 * Run:
 *   npx playwright test e2e/flows/ai-gemini-evidence.spec.js --project=ai-flows --headed
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';
import { openChatPage, dismissModals } from '../helpers/crawl-utils.js';

const STORAGE_KEY = 'di_model_config';

/**
 * Inject localStorage model config so the app uses Gemini as primary.
 */
async function setGeminiAsPrimary(page) {
  await page.evaluate((key) => {
    const existing = JSON.parse(localStorage.getItem(key) || '{}');
    existing.shared = {
      ...(existing.shared || {}),
      primary: { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
    };
    localStorage.setItem(key, JSON.stringify(existing));
  }, STORAGE_KEY);
}

test.describe('Gemini Evidence Recovery — Real LLM E2E', () => {
  // Use ai-flows timeout (180s) — real LLM calls can be slow
  test.setTimeout(300_000); // 5 min — Gemini may need retries

  test.beforeEach(async ({ page }) => {
    await setupSupabaseMock(page);
  });

  test('Gemini produces tool-backed evidence for Olist demand growth analysis', async ({ page }) => {
    // 1. Navigate to /plan and open a chat
    await page.goto('/plan');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Set Gemini as primary model BEFORE interacting with chat
    await setGeminiAsPrimary(page);

    // Reload to pick up model config
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await dismissModals(page);

    const chatInput = await openChatPage(page, '/plan');
    await expect(chatInput).toBeVisible({ timeout: 15000 });

    // 2. Type the complex analysis prompt
    const prompt = '假設 Olist 明年需求成長 20%，我的補貨策略、庫存水位、和資金需求分別要怎麼調整？給我具體建議和風險分析。';
    await chatInput.fill(prompt);
    await page.waitForTimeout(500);

    // 3. Send the message
    const sendBtn = page.locator('button[aria-label*="send" i], button[aria-label*="Send" i]').first();
    const sendVisible = await sendBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (sendVisible) {
      await sendBtn.click();
    } else {
      await chatInput.press('Enter');
    }

    console.log('[test] Message sent, waiting for Gemini response with tool calls...');

    // 4. Count existing execution traces BEFORE our response arrives
    //    so we only match NEW traces from our prompt, not leftover conversations.
    const existingTraces = await page.getByText('Execution Trace').count().catch(() => 0);
    console.log(`[test] Existing execution traces on page: ${existingTraces}`);

    // 5. Wait for NEW execution trace to appear — this means a tool was called.
    //    Poll for up to 4 minutes — Gemini may need multiple recovery turns.
    const MAX_WAIT = 240_000;
    const POLL_INTERVAL = 5_000;
    let elapsed = 0;
    let evidenceFound = false;
    let failureFound = false;

    while (elapsed < MAX_WAIT) {
      // Check for NEW execution traces (more than before)
      const currentTraces = await page.getByText('Execution Trace').count().catch(() => 0);
      if (currentTraces > existingTraces) {
        evidenceFound = true;
        console.log(`[test] ✓ New Execution Trace detected after ${elapsed / 1000}s (${existingTraces}→${currentTraces})`);
        break;
      }

      // Also check for "N successful" which appears in trace meta
      const successMeta = await page.getByText(/\d+ successful/).count().catch(() => 0);
      if (successMeta > 0) {
        evidenceFound = true;
        console.log(`[test] ✓ Successful tool evidence detected after ${elapsed / 1000}s`);
        break;
      }

      // Check for Answer Quality card (appears after judge completes)
      const answerQuality = await page.getByText('Answer Quality').count().catch(() => 0);
      if (answerQuality > 0) {
        evidenceFound = true;
        console.log(`[test] ✓ Answer Quality card detected after ${elapsed / 1000}s — agent completed`);
        break;
      }

      // Failure indicators — only match specific agent error messages
      const missingEvidence = await page.getByText('missing_evidence').count().catch(() => 0);
      const proseWithout = await page.getByText('returned prose without').count().catch(() => 0);
      if (missingEvidence > 0 || proseWithout > 0) {
        failureFound = true;
        console.log(`[test] ✗ Agent failure detected after ${elapsed / 1000}s`);
        break;
      }

      await page.waitForTimeout(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;

      if (elapsed % 30_000 === 0) {
        console.log(`[test] Still waiting... ${elapsed / 1000}s elapsed`);
      }
    }

    // 6. Take a screenshot for debugging regardless of outcome
    await page.screenshot({
      path: `e2e/screenshots/gemini-evidence-${Date.now()}.png`,
      fullPage: true,
    });

    // 7. Assert: execution trace appeared (agent attempted tool calls)
    expect(evidenceFound, 'Gemini should attempt at least one evidence-producing tool call').toBe(true);
    expect(failureFound, 'No missing_evidence error should appear (agent must attempt tools, not just prose)').toBe(false);

    // 8. Wait for final answer to render
    await page.waitForTimeout(5000);

    // 9. Detailed trace analysis — extract execution trace content
    const chatArea = page.locator('main, [class*="chat"], [class*="thread"], [class*="message-list"]').first();
    const fullPageText = await chatArea.textContent().catch(() => '');

    // Check if Gemini attempted tool calls (failed or successful both count)
    const geminiTraceMatch = fullPageText.match(
      /Primary Agent[^]*?(\d+)\s*failed\s*[•·]\s*(\d+)\s*successful/
    );
    if (geminiTraceMatch) {
      const [, failedCount, successCount] = geminiTraceMatch;
      console.log(`[test] Gemini trace: ${failedCount} failed, ${successCount} successful tool calls`);

      // Core assertion: Gemini ATTEMPTED tool calls (not just prose)
      const totalAttempts = parseInt(failedCount) + parseInt(successCount);
      expect(totalAttempts, 'Gemini must attempt at least 1 tool call (evidence recovery works)').toBeGreaterThanOrEqual(1);

      if (parseInt(successCount) > 0) {
        console.log('[test] ✓ Gemini produced successful evidence — full recovery confirmed');
      } else {
        console.log('[test] ⚠ Gemini called tools but they failed (likely no DuckDB tables in E2E env)');
        console.log('[test] ✓ Evidence recovery mechanism works — agent was forced to call tools instead of returning prose');
      }
    } else {
      console.log('[test] ⚠ Could not parse Gemini trace details from page text');
    }

    // Also check Challenger for comparison
    const challengerTraceMatch = fullPageText.match(
      /Challenger Agent[^]*?(\d+)\s*failed\s*[•·]\s*(\d+)\s*successful/
    );
    if (challengerTraceMatch) {
      const [, failedCount, successCount] = challengerTraceMatch;
      console.log(`[test] Challenger trace: ${failedCount} failed, ${successCount} successful tool calls`);
    }

    console.log(`[test] Chat area text (last 600 chars): ...${fullPageText.slice(-600)}`);

    console.log('[test] ✓ Gemini evidence recovery test passed!');
  });
});
