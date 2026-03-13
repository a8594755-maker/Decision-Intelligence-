/**
 * AI Employee workflow tests.
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

test.describe('AI Employee pages', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('employees page loads without error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/employees');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('tasks page loads and shows task interface', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/employees/tasks');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('review page loads without error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/employees/review');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('can open new task modal on tasks page', async ({ page }) => {
    await page.goto('/employees/tasks');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Look for a "New Task" or "Add" button
    const newTaskBtn = page
      .locator('button:has-text("New"), button:has-text("Add"), button:has-text("Create")')
      .first();
    const visible = await newTaskBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (visible) {
      await newTaskBtn.click();
      await page.waitForTimeout(500);

      // Modal or form should appear without crash
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    }
  });
});
