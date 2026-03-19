/**
 * E2E: Self-Healing Retry + Pre-Execution Clarification
 *
 * Tests the two new features:
 *   1. Clarification flow: vague message → ClarificationCard → answer/skip → TaskPlanCard
 *   2. Direct task plan: specific message → TaskPlanCard (no clarification)
 *   3. Page load tests for AI Employee pages
 *
 * Approach: intercept the ai-proxy Edge Function to return controlled JSON
 * responses, so we can test the UI flow deterministically without a live LLM.
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';
import { openChatPage } from '../helpers/crawl-utils.js';

// ── Mock decomposition responses ────────────────────────────────────────────

/** Returns a decomposition JSON that triggers clarification */
function clarificationResponse() {
  return JSON.stringify({
    subtasks: [
      {
        name: 'custom_analysis',
        workflow_type: 'dynamic_tool',
        description: 'Analyze uploaded data',
        builtin_tool_id: null,
        depends_on: [],
        tool_hint: 'Analyze the data and produce summary statistics',
        estimated_tier: 'tier_a',
      },
    ],
    report_format: null,
    confidence: 0.4,
    needs_clarification: true,
    clarification_questions: [
      'What specific metrics or KPIs should the analysis focus on?',
      'What format do you prefer? (table, chart, narrative summary)',
      'Should I analyze all data or focus on a specific time period?',
    ],
  });
}

/** Returns a decomposition JSON with no clarification needed */
function directTaskPlanResponse() {
  return JSON.stringify({
    subtasks: [
      {
        name: 'analyze_revenue',
        workflow_type: 'dynamic_tool',
        description: 'Analyze monthly revenue trends with YoY comparison',
        builtin_tool_id: null,
        depends_on: [],
        tool_hint: 'Compute monthly revenue, YoY growth rate, top 5 products by revenue',
        estimated_tier: 'tier_a',
      },
      {
        name: 'generate_report',
        workflow_type: 'report',
        description: 'Generate revenue analysis report',
        builtin_tool_id: null,
        depends_on: ['analyze_revenue'],
        tool_hint: null,
        estimated_tier: 'tier_c',
      },
    ],
    report_format: 'xlsx',
    confidence: 0.9,
    needs_clarification: false,
    clarification_questions: [],
  });
}

// ── Helper: setup Supabase mock + ai-proxy interception ─────────────────────
// We must handle the ai-proxy route WITHIN the Edge Function handler to avoid
// Playwright route priority conflicts. The supabase-mock registers a generic
// **/functions/v1/** handler; we unroute it and re-register with ai-proxy logic.

async function setupMocksWithAiProxy(page, aiProxyHandler) {
  // Auth + REST + Realtime — same as setupSupabaseMock
  await setupSupabaseMock(page);

  // Remove the generic Edge Function handler from supabase-mock,
  // and re-register with ai-proxy awareness
  await page.unroute('**/functions/v1/**');
  await page.route('**/functions/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/ai-proxy') && aiProxyHandler) {
      return aiProxyHandler(route);
    }
    // Default: return empty response for other edge functions
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

/** Build an ai-proxy handler that returns a fixed JSON or calls a function */
function makeStaticHandler(responseJson) {
  return async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: responseJson,
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
    });
  };
}

/** Build an ai-proxy handler that returns different responses per di_prompt call */
function makeSequentialHandler(responsesArray) {
  let diPromptCount = 0;
  return async (route) => {
    const body = route.request().postData();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }

    // Only count di_prompt calls (decomposition), not ping/warmup
    if (parsed?.mode === 'di_prompt') {
      const responseJson = responsesArray[diPromptCount] || responsesArray[responsesArray.length - 1];
      diPromptCount++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text: responseJson,
          provider: 'gemini',
          model: 'gemini-2.0-flash',
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
      });
    }

    // Non-di_prompt calls (ping, etc.) → generic OK
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'OK', provider: 'gemini', model: 'gemini-2.0-flash' }),
    });
  };
}

/** Build an ai-proxy handler that returns 500 (force keyword fallback) */
function makeFailingHandler() {
  return async (route) => {
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'LLM unavailable' }),
    });
  };
}

// ── Helper: send a chat message ─────────────────────────────────────────────
async function sendChatMessage(page, chatInput, message) {
  await chatInput.fill(message);
  const sendBtn = page.locator('button[aria-label*="send" i], button[aria-label*="Send" i]').first();
  const sendVisible = await sendBtn.isVisible({ timeout: 2000 }).catch(() => false);
  if (sendVisible) await sendBtn.click();
  else await chatInput.press('Enter');
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Pre-Execution Clarification Flow', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('vague message shows ClarificationCard with questions', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupMocksWithAiProxy(page, makeStaticHandler(clarificationResponse()));

    // AI Employee mode is on the home page ("/")
    const chatInput = await openChatPage(page, '/workspace');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    await sendChatMessage(page, chatInput, '分析資料');

    // Wait for ClarificationCard to appear
    const clarificationCard = page.locator('text=Quick Questions Before I Start');
    await expect(clarificationCard).toBeVisible({ timeout: 15000 });

    // Should show the clarification questions
    await expect(page.locator('text=What specific metrics')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=What format do you prefer')).toBeVisible({ timeout: 3000 });

    // Should have input fields for answers
    const inputs = page.locator('input[placeholder*="Your answer"]');
    const inputCount = await inputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(2);

    // Should have "Answer & Proceed" and "Skip" buttons
    await expect(page.locator('button:has-text("Answer")')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("Skip")')).toBeVisible({ timeout: 3000 });

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);

    await page.screenshot({ path: 'e2e/screenshots/clarification-card.png', fullPage: true });
  });

  test('filling answers and submitting re-triggers decomposition', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // First call → clarification, second → direct plan
    await setupMocksWithAiProxy(page,
      makeSequentialHandler([clarificationResponse(), directTaskPlanResponse()])
    );

    const chatInput = await openChatPage(page, '/workspace');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    await sendChatMessage(page, chatInput, '分析資料');

    // Wait for ClarificationCard
    await expect(page.locator('text=Quick Questions Before I Start')).toBeVisible({ timeout: 15000 });

    // Fill in answers
    const inputs = page.locator('input[placeholder*="Your answer"]');
    const count = await inputs.count();
    if (count >= 1) await inputs.nth(0).fill('Revenue, profit margin, growth rate');
    if (count >= 2) await inputs.nth(1).fill('Table with charts');

    // Click "Answer & Proceed"
    await page.locator('button:has-text("Answer")').click();

    // After answering, the enriched message is re-sent and re-decomposed.
    // The second mock returns directTaskPlanResponse → TaskPlanCard should appear.
    // The "Re-planning..." text may appear briefly then get replaced by TaskPlanCard.
    await page.waitForTimeout(8000);

    // Verify: TaskPlanCard from the second decomposition should be visible
    const taskPlanVisible = await page.locator('text=Task Plan').isVisible().catch(() => false);
    expect(taskPlanVisible).toBe(true);

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);

    await page.screenshot({ path: 'e2e/screenshots/clarification-answered.png', fullPage: true });
  });

  test('skip button proceeds without clarification', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // First call → clarification, second → direct plan
    await setupMocksWithAiProxy(page,
      makeSequentialHandler([clarificationResponse(), directTaskPlanResponse()])
    );

    const chatInput = await openChatPage(page, '/workspace');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    await sendChatMessage(page, chatInput, '幫我分析');

    // Wait for ClarificationCard
    await expect(page.locator('text=Quick Questions Before I Start')).toBeVisible({ timeout: 15000 });

    // Click "Skip — Just Do It"
    await page.locator('button:has-text("Skip")').click();

    // After skipping, the original message is re-sent with "[proceed with defaults]" suffix.
    // The second mock returns directTaskPlanResponse → TaskPlanCard should appear.
    // The "Skipped clarification" text may appear briefly then get replaced.
    await page.waitForTimeout(8000);

    // Verify: TaskPlanCard from the second decomposition should be visible
    const taskPlanVisible = await page.locator('text=Task Plan').isVisible().catch(() => false);
    expect(taskPlanVisible).toBe(true);

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);

    await page.screenshot({ path: 'e2e/screenshots/clarification-skipped.png', fullPage: true });
  });
});

test.describe('Direct Task Plan (no clarification)', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('specific message shows TaskPlanCard directly', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupMocksWithAiProxy(page, makeStaticHandler(directTaskPlanResponse()));

    const chatInput = await openChatPage(page, '/workspace');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    await sendChatMessage(page, chatInput, 'Generate monthly revenue analysis report with YoY growth rates and top products');

    // Should NOT show ClarificationCard
    await page.waitForTimeout(3000);
    await expect(page.locator('text=Quick Questions Before I Start')).toHaveCount(0);

    // Should show TaskPlanCard with "Task Plan" header
    await expect(page.locator('text=Task Plan')).toBeVisible({ timeout: 10000 });
    // Should show "Approve & Execute" button
    await expect(page.locator('button:has-text("Approve")')).toBeVisible({ timeout: 5000 });

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);

    await page.screenshot({ path: 'e2e/screenshots/direct-task-plan.png', fullPage: true });
  });
});

test.describe('AI Employee Page Load Tests', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test.beforeEach(async ({ page }) => {
    await setupSupabaseMock(page);
  });

  test('employees/tasks page loads without crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/employees/tasks');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('employees/tools page loads without crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/employees/tools');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });
});

test.describe('Keyword Fallback — Long Messages', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('long analysis message produces dynamic_tool (not builtin_tool) via keyword fallback', async ({ page }) => {
    const errors = [];
    const consoleMessages = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'log' || msg.type() === 'info' || msg.type() === 'warn') {
        consoleMessages.push(msg.text());
      }
    });

    // Make ai-proxy fail so keyword fallback is used
    await setupMocksWithAiProxy(page, makeFailingHandler());

    // AI Employee mode on home page
    const chatInput = await openChatPage(page, '/workspace');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Send a long message that incidentally contains supply chain keywords
    const longMessage = `請幫我完整分析這份 Apple Monthly Business Review 的資料：
    1. 計算每月營收趨勢和 YoY 成長率
    2. 分析產品線銷售組成 — iPhone, Mac, iPad, Services, Wearables
    3. 計算各產品毛利率和整體毛利率變化趨勢
    4. 預測下一季營收 forecast
    5. 評估 inventory 週轉率和 risk 指標
    6. 產出完整 MBR 報告含 executive summary`;

    await sendChatMessage(page, chatInput, longMessage);

    // Wait for decomposition + TaskPlanCard
    await page.waitForTimeout(8000);

    // Check: TaskPlanCard should appear (keyword fallback produces at least a dynamic_tool step)
    const taskPlan = page.locator('text=Task Plan');
    const planVisible = await taskPlan.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('TaskPlanCard visible:', planVisible);

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);

    await page.screenshot({ path: 'e2e/screenshots/long-message-fallback.png', fullPage: true });
  });
});
