import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/storage-state.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'flows',
      testDir: './e2e/flows',
      testIgnore: /ai-.*\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/storage-state.json',
        screenshot: 'on',
        video: 'retain-on-failure',
        actionTimeout: 15000,
      },
      timeout: 120_000, // 2min per test for workflow tests
      dependencies: ['setup'],
    },
    {
      name: 'ai-flows',
      testDir: './e2e/flows',
      testMatch: /ai-.*\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/storage-state.json',
        screenshot: 'on',
        video: 'retain-on-failure',
        actionTimeout: 30000,
      },
      timeout: 180_000, // 3min per test — AI actions need more time
      dependencies: ['setup'],
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 30_000,
      },
});
