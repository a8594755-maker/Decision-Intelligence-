/**
 * Playwright E2E Config — Phase 4 skeleton, not yet active.
 *
 * To activate:
 *   1. npm install -D @playwright/test
 *   2. npx playwright install
 *   3. Remove `if: ... && false` in frontend-ci.yml e2e-stub job
 */

// import { defineConfig, devices } from '@playwright/test';
//
// export default defineConfig({
//   testDir: './e2e',
//   timeout: 30000,
//   retries: process.env.CI ? 2 : 0,
//   use: {
//     baseURL: 'http://localhost:5173',
//     trace: 'on-first-retry',
//     screenshot: 'only-on-failure',
//   },
//   webServer: {
//     command: 'npm run preview',
//     url: 'http://localhost:4173',
//     reuseExistingServer: !process.env.CI,
//   },
//   projects: [
//     { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
//   ],
// });

export default {};
