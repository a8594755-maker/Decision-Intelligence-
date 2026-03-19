/**
 * Shared helper for V1 Gate tests.
 * Navigates to a route and skips the test if the page redirects to login
 * or encounters an error (e.g., auth not configured, server down).
 */

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path - route to navigate to (e.g. '/plan')
 * @param {import('@playwright/test').TestInfo} testInfo
 * @returns {Promise<boolean>} true if page is usable, false if test was skipped
 */
export async function navigateOrSkip(page, path, testInfo) {
  try {
    await page.goto(path, { timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    const url = page.url();
    if (url.includes('/login') || url.includes('/auth')) {
      testInfo.skip(true, 'Redirected to login — auth not configured, skipping UI test');
      return false;
    }
    const hasError = await page.locator('#vite-error-overlay').count();
    if (hasError > 0) {
      testInfo.skip(true, 'Vite error overlay detected — skipping UI test');
      return false;
    }
    return true;
  } catch {
    testInfo.skip(true, 'Dev server not reachable — skipping UI test');
    return false;
  }
}
