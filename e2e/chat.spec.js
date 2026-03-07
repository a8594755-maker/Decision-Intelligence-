import { test, expect } from '@playwright/test';

test.describe('Chat / AI Assistant', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('chat page loads', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  });

  test('has message input', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Look for chat input (textarea or input)
    const input = page.locator('textarea, input[type="text"]').last();
    await expect(input).toBeVisible({ timeout: 10000 });
  });
});
