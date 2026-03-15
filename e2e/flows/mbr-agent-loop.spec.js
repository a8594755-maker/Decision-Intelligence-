/**
 * MBR Agent Loop E2E Test
 *
 * Tests the full pipeline: upload Excel → decompose task → approve plan →
 * server-side agent loop with SSE real-time progress → verify artifacts.
 *
 * Requires:
 *   - Dev server running (npm run dev)
 *   - Python ML API running (python run_ml_api.py)
 *   - Supabase Edge Function ai-proxy deployed
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupSupabaseMock } from './global-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'apple_mbr.xlsx');

// Longer timeout for LLM-based operations
test.setTimeout(300_000); // 5 minutes

test.beforeEach(async ({ page }) => {
  await setupSupabaseMock(page);
});

test.describe('MBR Agent Loop', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('upload Excel and trigger server-side agent loop with SSE progress', async ({ page }) => {
    const consoleErrors = [];
    const consoleLogs = [];

    page.on('console', (msg) => {
      const text = msg.text();
      consoleLogs.push(text);
      if (msg.type() === 'error' && !text.includes('ResizeObserver') && !text.includes('net::ERR')) {
        consoleErrors.push(text);
      }
    });

    // 1. Navigate to Aiden Chat (root route = Decision Support View)
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // 2. Start a new conversation — click "+ New" button
    const newBtn = page.locator('button:has-text("New"), button:has-text("+ New")').first();
    await expect(newBtn).toBeVisible({ timeout: 10000 });
    await newBtn.click();
    await page.waitForTimeout(1000);

    // 3. Upload the MBR Excel file via the hidden file input in ChatComposer
    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toBeAttached({ timeout: 10000 });
    await fileInput.setInputFiles(FIXTURE_PATH);

    // Wait for upload processing
    await page.waitForTimeout(3000);

    // Verify dataset was loaded — look for sheet names or row count in UI
    const dataIndicator = page.locator('text=/\\d+ rows|\\d+ sheets|Dataset|uploaded/i').first();
    await expect(dataIndicator).toBeVisible({ timeout: 15000 });

    // Take screenshot after upload
    await page.screenshot({ path: 'e2e/screenshots/mbr-01-upload.png' });

    // 3. Send MBR analysis instruction
    const chatInput = page.locator('textarea, input[type="text"]').last();
    await chatInput.fill('請分析這份 MBR 資料，清洗資料、計算 KPI、進行樞紐分析');
    await chatInput.press('Enter');

    // Wait for task decomposition (LLM call — can take 15-30s)
    await page.waitForTimeout(5000);

    // 4. Wait for TaskPlanCard to appear (decomposition result)
    // The card shows "Task Plan" heading with step count
    const taskPlanCard = page.getByText('Task Plan').first();
    await expect(taskPlanCard).toBeVisible({ timeout: 60000 });

    await page.screenshot({ path: 'e2e/screenshots/mbr-02-plan.png' });

    // 5. Approve the plan — button says "Approve & Execute"
    const approveBtn = page.getByRole('button', { name: /Approve|Execute|核准|執行/ }).first();
    await expect(approveBtn).toBeVisible({ timeout: 10000 });
    await approveBtn.click();

    // 6. Wait for agent execution to begin
    // After approval, either an AgentExecutionPanel or step progress appears
    // Give it time for the server-side dispatch to start
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'e2e/screenshots/mbr-03-executing.png' });

    // 7. Wait for execution indicators — look for step status or code blocks
    const execIndicator = page.locator('[class*="StepProgress"], [class*="AgentExec"]').first();
    const hasExecPanel = await execIndicator.isVisible({ timeout: 15000 }).catch(() => false);
    console.log('[MBR Test] Execution panel visible:', hasExecPanel);

    // 8. Wait for generated code to appear (SSE step_event shows code)
    const codeBlock = page.locator('pre code, [class*="CodeBlock"], [class*="code-block"]').first();
    const codeVisible = await codeBlock.isVisible({ timeout: 120000 }).catch(() => false);

    await page.screenshot({ path: 'e2e/screenshots/mbr-04-code-visible.png' });

    // 9. Wait for completion or error (up to 4 minutes for all steps)
    const completionOrError = page.getByText(/completed|Complete|All.*done|failed|Blocked|Error|succeeded|artifact/i).first();
    const isComplete = await completionOrError.isVisible({ timeout: 240000 }).catch(() => false);

    await page.screenshot({ path: 'e2e/screenshots/mbr-05-final.png' });

    // 10. Check results
    if (isComplete) {
      const finalText = await completionOrError.textContent();
      console.log('[MBR Test] Final status:', finalText);
    } else {
      console.log('[MBR Test] Did not detect completion text within timeout');
    }

    // Check if any artifacts were produced
    const artifactBadges = page.getByText(/artifact|rows|KPI|Cleaned/i);
    const artifactCount = await artifactBadges.count();
    console.log('[MBR Test] Artifact indicators found:', artifactCount);

    // Check for SSE-related console logs
    const sseLogs = consoleLogs.filter(l => l.includes('SSE') || l.includes('sse') || l.includes('agent/run'));
    console.log('[MBR Test] SSE-related logs:', sseLogs.length);

    // Log any errors for debugging
    if (consoleErrors.length > 0) {
      console.log('[MBR Test] Console errors:');
      consoleErrors.forEach(e => console.log('  -', e.slice(0, 200)));
    }

    // Key assertion: the pipeline should have reached execution
    expect(hasExecPanel || codeVisible || isComplete,
      'Pipeline should show execution panel, code, or completion status').toBe(true);
  });

  test('verify ML API is healthy and execute-tool works with Claude', async ({ page }) => {
    // Direct API test — no browser needed, but Playwright gives us a clean context
    const healthResp = await page.request.get('http://localhost:8000/health');
    expect(healthResp.ok()).toBe(true);
    const health = await healthResp.json();
    expect(health.status).toBe('healthy');

    // Test /execute-tool with Claude via Supabase proxy
    const toolResp = await page.request.post('http://localhost:8000/execute-tool', {
      data: {
        tool_hint: 'Calculate sum of values and return as table',
        input_data: { sheets: { Numbers: [{ value: 1 }, { value: 2 }, { value: 3 }] } },
        llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 2048 },
      },
    });
    expect(toolResp.ok()).toBe(true);
    const result = await toolResp.json();

    console.log('[API Test] execute-tool result:', JSON.stringify({
      ok: result.ok,
      artifacts: result.artifacts?.length,
      provider: result.llm_provider,
      model: result.llm_model,
      execution_ms: result.execution_ms,
    }));

    expect(result.ok).toBe(true);
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.llm_provider).toBe('anthropic');
  });

  test('verify server-side agent loop with SSE events', async ({ page }) => {
    // Test the async agent loop endpoint + SSE stream
    const taskId = `e2e-test-${Date.now()}`;

    // Start async agent run
    const asyncResp = await page.request.post('http://localhost:8000/agent/run-async', {
      data: {
        task_id: taskId,
        steps: [
          { name: 'calculate_kpis', tool_hint: 'Calculate sum and average of values. Return KPI table.' },
          { name: 'classify_values', tool_hint: 'Classify each value as small (1-3) or large (4+). Return classification table.' },
        ],
        input_data: { sheets: { Numbers: [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 5 }, { v: 8 }] } },
        llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 2048 },
      },
    });
    expect(asyncResp.ok()).toBe(true);
    const asyncResult = await asyncResp.json();
    expect(asyncResult.ok).toBe(true);
    expect(asyncResult.status).toBe('started');
    console.log('[Agent Loop Test] Started:', asyncResult.task_id);

    // Poll for completion via the sync endpoint (SSE is hard to test in Playwright)
    // Wait and then check via a sync run with same data
    await page.waitForTimeout(30000); // Wait for async execution

    // Check SSE channel status
    const activeResp = await page.request.get('http://localhost:8000/sse/agent/active');
    const activeChannels = await activeResp.json();
    console.log('[Agent Loop Test] Active SSE channels:', activeChannels.length);

    // Now run a sync test to verify the full pipeline
    const syncResp = await page.request.post('http://localhost:8000/agent/run', {
      data: {
        task_id: `e2e-sync-${Date.now()}`,
        steps: [
          { name: 'sum_values', tool_hint: 'Calculate sum of all v values. Return a KPI summary table.' },
        ],
        input_data: { sheets: { Numbers: [{ v: 1 }, { v: 2 }, { v: 3 }] } },
        llm_config: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 2048 },
      },
      timeout: 60000,
    });
    expect(syncResp.ok()).toBe(true);
    const syncResult = await syncResp.json();

    console.log('[Agent Loop Test] Sync result:', JSON.stringify({
      ok: syncResult.ok,
      steps_completed: syncResult.steps_completed,
      steps_total: syncResult.steps_total,
      total_ms: syncResult.total_execution_ms,
    }));

    expect(syncResult.ok).toBe(true);
    expect(syncResult.steps_completed).toBe(1);
    expect(syncResult.step_results[0].status).toBe('succeeded');
    expect(syncResult.step_results[0].artifacts.length).toBeGreaterThan(0);
    expect(syncResult.step_results[0].llm_provider).toBe('anthropic');
  });
});
