/**
 * Opens a new chat session on the workspace page.
 * Clicks "New chat" if the empty state is shown, then waits for the composer.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
export async function openChat(page) {
  // Check if composer is already visible (chat already open)
  const composer = page.locator('textarea[placeholder*="Message"], textarea, [contenteditable="true"]').first();
  const alreadyOpen = await composer.isVisible({ timeout: 2000 }).catch(() => false);
  if (alreadyOpen) return;

  // Wait for page to fully render
  await page.waitForTimeout(2000);

  // Click ALL visible "New chat" buttons — one of them will work
  const newChatButtons = page.locator('button:has-text("New chat")');
  const count = await newChatButtons.count();
  for (let i = count - 1; i >= 0; i--) {
    const btn = newChatButtons.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(2000);
      // Check if composer appeared
      if (await composer.isVisible({ timeout: 2000 }).catch(() => false)) {
        return;
      }
    }
  }

  // Final wait — composer should appear by now
  await composer.waitFor({ state: 'visible', timeout: 15000 });
}
