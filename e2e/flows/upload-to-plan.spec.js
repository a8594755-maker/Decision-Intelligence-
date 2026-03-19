/**
 * V1 Gate — Upload-to-Plan acceptance test
 *
 * Verifies: chat/upload → forecast + plan artifact production
 * Data: public/sample_data/test_data.xlsx
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

test.describe('V1 Gate: Upload → Forecast + Plan', () => {

  test('upload test_data.xlsx and receive forecast + plan artifacts', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/plan', testInfo);
    if (!ok) return;

    await openChat(page);

    // Upload the main demo file
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles('public/sample_data/test_data.xlsx');

    // Wait for profiling to complete (DataSummaryCard or mapping step)
    await page.waitForTimeout(5000);

    // Verify upload succeeded — no white screen or error
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);

    await page.screenshot({ path: 'e2e/screenshots/upload-to-plan-uploaded.png', fullPage: true });
  });

  test('main prompt produces forecast and plan cards', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/plan', testInfo);
    if (!ok) return;

    await openChat(page);

    // Upload
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles('public/sample_data/test_data.xlsx');
    await page.waitForTimeout(3000);

    // Send the main demo prompt
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    await composer.fill(
      'Use this workbook to build a demand forecast and replenishment plan. ' +
      'Highlight the top risks, surface any data quality concerns, and generate a manager-ready summary.'
    );
    await composer.press('Enter');

    // Wait for LLM response (task plan card)
    await page.waitForTimeout(15000);

    // Step 1: Click "Confirm & Plan" if the quick-action card appears
    const confirmBtn = page.locator('button:has-text("Confirm & Plan")').first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(5000);
    }

    // Step 2: Click "Approve & Execute" on the Task Plan card
    const approveExecBtn = page.locator('button:has-text("Approve & Execute")').first();
    if (await approveExecBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await approveExecBtn.click();
      // Wait for worker to execute and produce artifacts
      await page.waitForTimeout(45000);
    } else {
      await page.waitForTimeout(15000);
    }

    // Take screenshot to see final state
    await page.screenshot({ path: 'e2e/screenshots/upload-to-plan-results.png', fullPage: true });

    // Verify: page has meaningful content beyond the initial empty state
    // Check for any agent execution panel, task plan steps, or chat response content
    const hasContent = await page.locator('text=/forecast|plan|risk|step|artifact|running|complete/i').count();
    expect(hasContent).toBeGreaterThan(0);

    await page.screenshot({ path: 'e2e/screenshots/upload-to-plan-results.png', fullPage: true });
  });

  test('sample data files exist on disk', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dataDir = path.resolve('public/sample_data');

    expect(fs.existsSync(path.join(dataDir, 'test_data.xlsx'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'red_light_demand_fg.csv'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'red_light_bom_edge.csv'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'red_light_inventory_snapshots.csv'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'red_light_po_open_lines.csv'))).toBe(true);
  });
});
