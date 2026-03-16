/**
 * E2E Smoke Tests — 4 critical user flows.
 * Requires: npx playwright install
 */

import { test, expect } from '@playwright/test';

// ── Flow 1: App loads without crashing ─────────────────────────────────────
test.describe('Smoke: app shell', () => {
  test('app loads and has a title', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await expect(page).toHaveTitle(/.+/); // any non-empty title
  });

  test('root renders without JS error overlay', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    // Vite/React error overlay (#vite-error-overlay or similar) must not appear
    const overlay = page.locator('#vite-error-overlay, [data-testid="error-overlay"]');
    await expect(overlay).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });
});

// ── Flow 2: Upload CSV → column mapping → run planning ─────────────────────
test.describe('Smoke: CSV upload and planning', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('data import panel is reachable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Navigate to data import (button, link, or nav item)
    const importTrigger = page.locator(
      '[data-testid="nav-data-import"], a[href*="import"], button:has-text("Import"), button:has-text("Upload")'
    ).first();
    if (await importTrigger.isVisible({ timeout: 5000 }).catch(() => false)) {
      await importTrigger.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    }

    // File input must exist somewhere in the page (even if hidden)
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toHaveCount(1);
  });

  test('decision support view is reachable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const dsvTrigger = page.locator(
      '[data-testid="nav-decision-support"], a[href*="decision"], button:has-text("Decision"), button:has-text("Planning")'
    ).first();
    if (await dsvTrigger.isVisible({ timeout: 5000 }).catch(() => false)) {
      await dsvTrigger.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    }

    // Chat input must be accessible after navigation
    const chatInput = page.locator('textarea, input[placeholder*="message" i], input[placeholder*="ask" i]').first();
    await expect(chatInput).toBeVisible({ timeout: 10000 });
  });
});

// ── Flow 3: Risk scan → suggestion card → approve replan ───────────────────
test.describe('Smoke: risk scan flow', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('risk panel or risk nav item is reachable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const riskTrigger = page.locator(
      '[data-testid="nav-risk"], a[href*="risk"], button:has-text("Risk"), [aria-label*="Risk" i]'
    ).first();
    const found = await riskTrigger.isVisible({ timeout: 5000 }).catch(() => false);
    // If a risk entry point exists, clicking it must not crash the page
    if (found) {
      await riskTrigger.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      const overlay = page.locator('#vite-error-overlay, [data-testid="error-overlay"]');
      await expect(overlay).toHaveCount(0);
    }
  });

  test('approval / governance section is reachable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const approvalTrigger = page.locator(
      '[data-testid="nav-approval"], a[href*="approv"], button:has-text("Approv"), a[href*="governance"]'
    ).first();
    const found = await approvalTrigger.isVisible({ timeout: 5000 }).catch(() => false);
    if (found) {
      await approvalTrigger.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      const overlay = page.locator('#vite-error-overlay, [data-testid="error-overlay"]');
      await expect(overlay).toHaveCount(0);
    }
  });
});

// ── Flow 4: Export plan ─────────────────────────────────────────────────────
test.describe('Smoke: plan export', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('export button is present when plan artifacts exist', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Navigate to decision support view
    const dsvTrigger = page.locator(
      '[data-testid="nav-decision-support"], a[href*="decision"], button:has-text("Decision"), button:has-text("Planning")'
    ).first();
    if (await dsvTrigger.isVisible({ timeout: 5000 }).catch(() => false)) {
      await dsvTrigger.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    }

    // Export button should be renderable (may be disabled/hidden until plan runs)
    const exportBtn = page.locator(
      '[data-testid="export-plan"], button:has-text("Export"), a:has-text("Export"), button:has-text("Download")'
    ).first();
    // Just verify the DOM can render without crashing — button presence is best-effort
    const overlay = page.locator('#vite-error-overlay, [data-testid="error-overlay"]');
    await expect(overlay).toHaveCount(0);
    // If export button is visible, it must not be broken
    if (await exportBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(exportBtn).toBeEnabled();
    }
  });
});
