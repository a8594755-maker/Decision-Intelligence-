import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  // Use the auth state from setup
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('loads dashboard page', async ({ page }) => {
    await page.goto('/');
    // Wait for page to load (either dashboard content or redirect)
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  });

  test('navigation sidebar is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Look for navigation elements
    const nav = page.locator('nav, [role="navigation"], aside');
    await expect(nav.first()).toBeVisible({ timeout: 10000 });
  });
});
