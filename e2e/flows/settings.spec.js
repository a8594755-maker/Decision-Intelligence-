/**
 * Settings page + dark mode toggle tests.
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';
import { dismissModals } from '../helpers/crawl-utils.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

test.describe('Settings page', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('settings page loads', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('tab switching works without crash', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const tabLabels = ['Logic Control', 'Data Import', 'Profile'];

    for (const label of tabLabels) {
      const tab = page.locator(`button:has-text("${label}")`).first();
      const visible = await tab.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        await tab.click();
        await page.waitForTimeout(300);
        await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
        await expect(page.locator('text=Something went wrong')).toHaveCount(0);
      }
    }
  });
});

test.describe('Dark mode', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('dark mode toggle changes theme', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Dismiss any blocking modals
    await dismissModals(page);

    // Expand sidebar
    const sidebar = page.locator('aside').first();
    await sidebar.hover();
    await page.waitForTimeout(300);

    // Find dark mode toggle by its title attribute
    const toggleBtn = sidebar
      .locator('button[title="Dark mode"], button[title="Light mode"]')
      .first();

    const rootDiv = page.locator('div').first();
    const hadDark = await rootDiv.evaluate((el) => {
      // Walk up to find the element with dark class
      let node = el;
      while (node) {
        if (node.classList && node.classList.contains('dark')) return true;
        node = node.parentElement;
      }
      return false;
    });

    await toggleBtn.click();
    await page.waitForTimeout(300);

    const hasDark = await rootDiv.evaluate((el) => {
      let node = el;
      while (node) {
        if (node.classList && node.classList.contains('dark')) return true;
        node = node.parentElement;
      }
      return false;
    });

    // Dark mode state should have toggled
    expect(hasDark).not.toBe(hadDark);

    // No crash
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
  });
});
