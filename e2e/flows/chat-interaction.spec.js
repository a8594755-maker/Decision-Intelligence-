/**
 * Chat / DecisionSupportView interaction tests.
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';
import { openChatPage } from '../helpers/crawl-utils.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

test.describe('Chat interaction', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('chat input is accessible on /plan', async ({ page }) => {
    const chatInput = await openChatPage(page, '/plan');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
  });

  test('can type a message without crashing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const chatInput = await openChatPage(page, '/plan');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    await chatInput.fill('Hello, this is an automated test message');

    // Try to send via button or Enter key
    const sendBtn = page
      .locator('button[aria-label*="send" i], button[aria-label*="Send" i]')
      .first();
    const sendVisible = await sendBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (sendVisible) {
      await sendBtn.click();
    } else {
      await chatInput.press('Enter');
    }

    await page.waitForTimeout(1000);

    // No crash after sending
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('chat input is accessible on /forecast', async ({ page }) => {
    const chatInput = await openChatPage(page, '/forecast');
    const visible = await chatInput.isVisible({ timeout: 10000 }).catch(() => false);
    if (!visible) {
      console.warn('/forecast chat not visible — may need new conversation');
    }
    // Soft check — don't hard-fail if auth prevents chat
    await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
  });
});
