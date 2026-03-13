/**
 * Navigation tests — verify every route loads without crashing.
 */
import { test, expect } from '@playwright/test';
import { setupSupabaseMock } from './global-setup.js';
import { dismissModals } from '../helpers/crawl-utils.js';

test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });

const ROUTES = [
  '/',
  '/plan',
  '/forecast',
  '/risk',
  '/digital-twin',
  '/scenarios',
  '/negotiation',
  '/employees',
  '/employees/tasks',
  '/employees/review',
  '/ops',
  '/sandbox',
  '/settings',
];

test.describe('All routes load without error', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  for (const route of ROUTES) {
    test(`${route} loads cleanly`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);

      // No Vite error overlay
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      // No React ErrorBoundary crash
      await expect(page.locator('text=Something went wrong')).toHaveCount(0);
      // No JS errors (exclude benign ResizeObserver)
      expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
    });
  }
});

test.describe('Sidebar navigation', () => {
  test.use({ storageState: 'e2e/.auth/storage-state.json' });

  test('can navigate via sidebar links without crashing', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Dismiss any modal (Getting Started tour) that blocks interaction
    await dismissModals(page);

    // Hover sidebar to expand it
    const sidebar = page.locator('aside').first();
    await sidebar.hover();
    await page.waitForTimeout(300);

    // Get all nav links
    const navLinks = await sidebar.locator('a[href]').all();
    expect(navLinks.length).toBeGreaterThan(0);

    for (const link of navLinks) {
      const href = await link.getAttribute('href');
      if (!href || href.startsWith('http')) continue;

      await link.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);

      // No crash after navigation
      await expect(page.locator('#vite-error-overlay')).toHaveCount(0);
      await expect(page.locator('text=Something went wrong')).toHaveCount(0);

      // Dismiss any modals that reappear, then re-expand sidebar
      await dismissModals(page);
      await sidebar.hover();
      await page.waitForTimeout(200);
    }

    expect(errors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
  });
});
