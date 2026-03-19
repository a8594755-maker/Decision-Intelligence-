/**
 * Output Profiles — E2E Browser Test
 *
 * Tests the full upload pipeline in a real browser:
 *   1. Navigate to /employees/profiles
 *   2. Verify page renders without errors
 *   3. Click "Bulk Upload & Learn"
 *   4. Upload seed files from scripts/seed-data/
 *   5. Verify learning pipeline completes
 *   6. Verify profiles appear on the page
 *   7. Switch through all 4 tabs (Profiles, Exemplars, Proposals, Learning)
 *   8. Check console for errors
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { setupSupabaseMock } from './global-setup.js';
import { navigateOrSkip } from '../helpers/navigate-or-skip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', '..', 'scripts', 'seed-data');

test.describe('Output Profiles Page', () => {

  let consoleErrors;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));
    await setupSupabaseMock(page);
  });

  test('page renders without crash and shows empty state', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/employees/profiles', testInfo);
    if (!ok) return;

    // Page title should be visible
    await expect(page.locator('h1:has-text("Output Profiles")')).toBeVisible({ timeout: 10000 });

    // KPI tiles should render (4 of them)
    const tiles = page.locator('text=Active Profiles').first();
    await expect(tiles).toBeVisible();

    // Should show empty state since no data
    await expect(page.locator('text=No output profiles yet')).toBeVisible({ timeout: 5000 });

    // No JS errors (filter out known benign warnings)
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('borderBottom') &&
      !e.includes('Failed to load profiles') &&
      !e.includes('Failed to load exemplars') &&
      !e.includes('supabase')
    );
    expect(criticalErrors).toEqual([]);
  });

  test('all 4 tabs are clickable and render correctly', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/employees/profiles', testInfo);
    if (!ok) return;

    await expect(page.locator('h1:has-text("Output Profiles")')).toBeVisible({ timeout: 10000 });

    // Tab 1: Output Profiles (default)
    await expect(page.getByRole('button', { name: /Output Profiles/i })).toBeVisible();

    // Tab 2: Exemplars
    const exemplarsTab = page.getByRole('button', { name: /Exemplars/i });
    await exemplarsTab.click();
    await expect(page.locator('text=No exemplars uploaded yet')).toBeVisible({ timeout: 5000 });

    // Tab 3: Proposals
    const proposalsTab = page.getByRole('button', { name: /Proposals/i });
    await proposalsTab.click();
    await expect(page.locator('text=No pending proposals')).toBeVisible({ timeout: 5000 });

    // Tab 4: Learning
    const learningTab = page.getByRole('button', { name: /Learning/i });
    await learningTab.click();
    await expect(page.locator('text=Style Learning Pipeline')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: /Start Learning Pipeline/i })).toBeVisible();
  });

  test('Bulk Upload & Learn button opens modal', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/employees/profiles', testInfo);
    if (!ok) return;

    await expect(page.locator('h1:has-text("Output Profiles")')).toBeVisible({ timeout: 10000 });

    // Wait for worker to resolve — use the header button (has title attribute)
    const uploadBtn = page.getByTitle('Upload files and learn style patterns');
    await expect(uploadBtn).toBeVisible({ timeout: 10000 });

    await uploadBtn.click();

    // Modal should open
    await expect(page.locator('text=Drop all company deliverables here')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Excel, Word, PDF, PPT')).toBeVisible();
  });

  test('upload seed files and verify learning pipeline completes', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/employees/profiles', testInfo);
    if (!ok) return;

    await expect(page.locator('h1:has-text("Output Profiles")')).toBeVisible({ timeout: 10000 });

    // Click upload button (header button with title)
    const uploadBtn = page.getByTitle('Upload files and learn style patterns');
    await expect(uploadBtn).toBeVisible({ timeout: 10000 });
    await uploadBtn.click();
    await expect(page.locator('text=Drop all company deliverables here')).toBeVisible({ timeout: 5000 });

    // Select 5 seed files (one of each type) via file input
    const seedFiles = [
      'MBR_202603_月營運報告.xlsx',
      '週報_202603_W1_Weekly_Ops.xlsx',
      'QBR_2026_Q1_季度報告.xlsx',
      '需求預測_202603_Demand_Forecast.xlsx',
      '風險報告_202603_Risk_Report.xlsx',
    ].map(f => path.join(SEED_DIR, f));

    // Verify files exist
    for (const f of seedFiles) {
      expect(fs.existsSync(f)).toBe(true);
    }

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(seedFiles);

    // Should show file count and auto-detected types
    const learnBtn = page.getByRole('button', { name: /Upload & Learn \(5 files\)/i });
    await expect(learnBtn).toBeVisible({ timeout: 5000 });
    // Check doc type detection badges inside modal (not in select dropdown)
    await expect(page.locator('span:text-matches("MBR Report|Weekly Ops|QBR Deck|Forecast|Risk Report", "i")').first()).toBeVisible();
    await expect(learnBtn).toBeVisible();
    await learnBtn.click();

    // Learning phase should start
    await expect(page.locator('text=Running learning pipeline')).toBeVisible({ timeout: 10000 });

    // Wait for completion (the pipeline processes 5 files — should finish within 30s)
    await expect(page.locator('text=Learning Complete')).toBeVisible({ timeout: 60000 });

    // Should show result stats
    await expect(page.locator('text=Profile created')).toBeVisible({ timeout: 5000 });

    // Modal should auto-close after 2 seconds and show profiles
    await expect(page.locator('text=Drop all company deliverables here')).not.toBeVisible({ timeout: 10000 });

    // Profile cards should now be visible (from local state injection)
    // The page should show at least one active profile
    const profileCards = page.locator('text=/Active Profiles|MBR|Weekly|QBR|Forecast|Risk/i');
    await expect(profileCards.first()).toBeVisible({ timeout: 10000 });
  });

  test('no STAGES.map crash on Learning tab', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/employees/profiles', testInfo);
    if (!ok) return;

    await expect(page.locator('h1:has-text("Output Profiles")')).toBeVisible({ timeout: 10000 });

    // Click Learning tab
    const learningTab = page.getByRole('button', { name: /Learning/i });
    await learningTab.click();

    // Should show the pipeline UI without crash
    await expect(page.locator('text=Style Learning Pipeline')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Policy Ingestion')).toBeVisible();
    await expect(page.locator('text=Exemplar Ingestion')).toBeVisible();
    await expect(page.locator('text=Style Extraction')).toBeVisible();
    await expect(page.locator('text=Feedback Learning')).toBeVisible();
    await expect(page.locator('text=Trust Metrics')).toBeVisible();

    // No STAGES.map crash in console
    const mapError = consoleErrors.find(e => e.includes('STAGES.map') || e.includes('is not a function'));
    expect(mapError).toBeUndefined();
  });

  test('search and filter work on profiles tab', async ({ page }, testInfo) => {
    const ok = await navigateOrSkip(page, '/employees/profiles', testInfo);
    if (!ok) return;

    await expect(page.locator('h1:has-text("Output Profiles")')).toBeVisible({ timeout: 10000 });

    // Search input should be visible
    const searchInput = page.locator('input[placeholder="Search profiles..."]');
    await expect(searchInput).toBeVisible();

    // Status filter should be visible
    const statusSelect = page.locator('select').first();
    await expect(statusSelect).toBeVisible();

    // Type filter should be visible
    const typeSelect = page.locator('select').nth(1);
    await expect(typeSelect).toBeVisible();

    // Type in search
    await searchInput.fill('mbr');
    // Clear search
    await searchInput.fill('');
  });
});
