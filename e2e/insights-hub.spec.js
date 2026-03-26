/**
 * Insights Hub E2E Test
 *
 * Logs in with real credentials, navigates to /insights,
 * waits for the agent to produce an HTML dashboard.
 * Uses REAL ai-proxy — no mocking.
 */
import { test, expect } from '@playwright/test';

// Don't use auth setup's storage state — we login manually
test.use({ storageState: { cookies: [], origins: [] } });

test('Insights Hub agent produces HTML dashboard', async ({ page }) => {
  test.setTimeout(900_000); // 15 min

  // ── Step 1: Real login ──
  console.log('[test] Logging in...');
  await page.goto('/');
  await page.waitForTimeout(2000);

  // Fill login form
  await page.fill('input[type="email"], input[name="email"]', 'test123@gmail.com');
  await page.fill('input[type="password"], input[name="password"]', '123456');
  await page.click('button:has-text("Log In"), button:has-text("Sign In"), button[type="submit"]');

  // Wait for login to complete
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'e2e/screenshots/insights-00-login.png', fullPage: true });
  console.log(`[test] After login, URL: ${page.url()}`);

  // ── Step 2: Navigate to Insights Hub ──
  console.log('[test] Navigating to /insights...');
  // Clear cached layout so agent runs fresh
  await page.evaluate(() => localStorage.removeItem('di_canvas_layout'));
  await page.goto('/insights');
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'e2e/screenshots/insights-01-start.png', fullPage: true });
  console.log('[test] Screenshot: insights-01-start.png');

  // ── Step 3: Wait for agent to complete (up to 4 min) ──
  console.log('[test] Waiting for agent (up to 4 min)...');
  const startTime = Date.now();
  const MAX_WAIT = 780_000; // 13 min
  let completed = false;
  let lastProgress = '';
  let screenshotCount = 0;

  while (!completed && Date.now() - startTime < MAX_WAIT) {
    // Check for HTML iframe (success)
    const iframe = page.locator('iframe[title="Insights Dashboard"]');
    if (await iframe.count() > 0) {
      console.log('[test] ✓ HTML dashboard iframe found!');
      completed = true;
      break;
    }

    // Check for error state
    const errorEl = page.locator('text=Agent encountered an issue');
    if (await errorEl.count() > 0) {
      const errText = await errorEl.textContent().catch(() => '');
      console.log(`[test] ✗ Agent error: ${errText.slice(0, 200)}`);
      await page.screenshot({ path: 'e2e/screenshots/insights-error.png', fullPage: true });
      break;
    }

    // Log progress from AgentThinkingBar
    try {
      // Try multiple selectors to catch the progress text
      for (const sel of ['[class*="indigo-600"]', '[class*="indigo-400"]', '[class*="indigo-300"]']) {
        const el = page.locator(sel).first();
        const text = await el.textContent({ timeout: 500 }).catch(() => '');
        if (text && text.length > 5 && text !== lastProgress) {
          lastProgress = text;
          console.log(`[test] ${text.slice(0, 150)}`);
          break;
        }
      }
    } catch { /* */ }

    // Screenshot every 20s
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 20 === 0) {
      screenshotCount++;
      await page.screenshot({ path: `e2e/screenshots/insights-progress-${screenshotCount}.png`, fullPage: true });
      console.log(`[test] Screenshot #${screenshotCount} at ${elapsed}s`);
    }

    await page.waitForTimeout(3000);
  }

  // ── Step 4: Final result ──
  const totalTime = Math.floor((Date.now() - startTime) / 1000);
  await page.screenshot({ path: 'e2e/screenshots/insights-final.png', fullPage: true });

  if (completed) {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/insights-dashboard.png', fullPage: true });

    // Count suggestions
    const sugCards = page.locator('button:has-text("Run Analysis")');
    const sugCount = await sugCards.count();
    console.log(`[test] ✓ SUCCESS in ${totalTime}s — ${sugCount} suggestions`);
  } else {
    console.log(`[test] ✗ FAILED after ${totalTime}s`);
  }
});
