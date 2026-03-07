/**
 * Auth setup for E2E tests.
 * Sets mock Supabase auth state in localStorage for test isolation.
 */
import { test as setup } from '@playwright/test';

const MOCK_SESSION = {
  access_token: 'e2e-test-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'e2e-refresh',
  user: {
    id: 'e2e-user-001',
    email: 'e2e@test.local',
    role: 'authenticated',
    app_metadata: { role: 'planner' },
    user_metadata: { full_name: 'E2E Tester' },
  },
};

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';

setup('set mock auth state', async ({ page }) => {
  await page.goto('/');

  // Set Supabase auth token in localStorage (the key format Supabase uses)
  const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
  await page.evaluate(
    ([key, session]) => {
      localStorage.setItem(key, JSON.stringify(session));
    },
    [storageKey, MOCK_SESSION],
  );

  // Save storage state for other tests
  await page.context().storageState({ path: 'e2e/.auth/storage-state.json' });
});
