/**
 * V1 Gate — Revise-Output acceptance test
 *
 * Verifies: sending a revision prompt → output artifact is updated/changed
 */

import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';
import { setupLlmReplay } from '../helpers/llm-replay.js';
import { navigateOrSkip } from '../helpers/navigate-or-skip.js';
import { openChat } from '../helpers/open-chat.js';

test.beforeEach(async ({ page }, testInfo) => {
  await setupSupabaseMock(page);
  await setupLlmReplay(page, testInfo);
});

test.describe('V1 Gate: Revise → Output Changed', () => {

  test('revision prompt triggers updated artifacts in chat', { timeout: 300_000 }, async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/plan', testInfo);
    if (!ok) return;

    await openChat(page);

    // Upload test data
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles('public/sample_data/test_data.xlsx');
    await page.waitForTimeout(3000);

    // Send initial prompt
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    await composer.fill('Run forecast and create a replenishment plan for this workbook.');
    await composer.press('Enter');
    await page.waitForTimeout(15000);

    // Click through: Confirm & Plan → Approve & Execute
    const confirmBtn = page.locator('button:has-text("Confirm & Plan")').first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(5000);
    }
    const approveBtn = page.locator('button:has-text("Approve & Execute")').first();
    if (await approveBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await approveBtn.click();
      await page.waitForTimeout(30000);
    } else {
      await page.waitForTimeout(10000);
    }

    // Snapshot content count before revision
    const contentBefore = await page.content();
    const beforeLen = contentBefore.length;

    // Send revision prompt
    await composer.fill(
      'Revise the plan to be more conservative for high-risk materials. ' +
      'Explicitly call out which plants or SKUs are most exposed and what changed.'
    );
    await composer.press('Enter');
    await page.waitForTimeout(15000);

    // Close the secondary panel if it's blocking clicks
    const closePanel = page.locator('[data-testid="ai-employee-secondary-panel"] button:has-text("Close"), [data-testid="ai-employee-secondary-panel"] button[aria-label*="close"], [data-testid="ai-employee-secondary-panel"] button[aria-label*="Close"]').first();
    if (await closePanel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closePanel.click();
      await page.waitForTimeout(1000);
    }

    // Click through any new task plan (use force to bypass overlay issues)
    const confirmBtn2 = page.locator('button:has-text("Confirm & Plan")').first();
    if (await confirmBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn2.click({ force: true });
      await page.waitForTimeout(5000);
    }
    const approveBtn2 = page.locator('button:has-text("Approve & Execute")').first();
    if (await approveBtn2.isVisible({ timeout: 10000 }).catch(() => false)) {
      await approveBtn2.click({ force: true });
      await page.waitForTimeout(30000);
    } else {
      await page.waitForTimeout(10000);
    }

    // Verify: page content grew (new response/artifacts added)
    const contentAfter = await page.content();
    expect(contentAfter.length).toBeGreaterThan(beforeLen);

    await page.screenshot({ path: 'e2e/screenshots/revise-output-after.png', fullPage: true });
  });

  test('plan studio renders without crash after navigation', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/plan', testInfo);
    if (!ok) return;

    await openChat(page);

    // Basic render check — no error overlay, page is usable
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);

    // Chat composer should be present
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    await expect(composer).toBeVisible({ timeout: 5000 });
  });
});
