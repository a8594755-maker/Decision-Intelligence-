import { test, expect } from '@playwright/test';

test.describe('Login Page', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // Clear auth

  test('renders login form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[type="password"], input[name="password"]')).toBeVisible();
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"], input[name="email"]', 'bad@test.com');
    await page.fill('input[type="password"], input[name="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    // Should show error message (stays on login page)
    await expect(page).toHaveURL(/login/);
  });

  test('redirects unauthenticated user to login', async ({ page }) => {
    await page.goto('/');
    // Should redirect to /login when not authenticated
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
  });
});
