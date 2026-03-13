/**
 * Data import flow tests.
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

test.describe('Data import', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('data import tab shows file upload area', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Click Data Import tab
    const dataTab = page.locator('button:has-text("Data Import")').first();
    const visible = await dataTab.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await dataTab.click();
      await page.waitForTimeout(500);
    }

    // File input must exist (may be hidden for custom dropzone)
    const fileInput = page.locator('input[type="file"]');
    const count = await fileInput.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('file upload area accepts interaction without crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/settings');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const dataTab = page.locator('button:has-text("Data Import")').first();
    const visible = await dataTab.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await dataTab.click();
      await page.waitForTimeout(500);
    }

    // Look for dropzone or upload button
    const uploadBtn = page
      .locator(
        'button:has-text("Upload"), button:has-text("Browse"), button:has-text("Choose"), [class*="dropzone"], [class*="upload"]',
      )
      .first();
    const uploadVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (uploadVisible) {
      await uploadBtn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });
});
