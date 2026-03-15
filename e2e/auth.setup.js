/**
 * Auth setup for E2E tests.
 * Reads VITE_SUPABASE_URL from .env.local (Playwright doesn't load Vite env files),
 * injects a mock session into localStorage, and intercepts Supabase auth API calls
 * so the mock token is never rejected by the real server.
 */
import { test as setup } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Read Supabase URL from .env.local ───────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');

function readEnvVar(filePath, varName) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  readEnvVar(envPath, 'VITE_SUPABASE_URL') ||
  'https://placeholder.supabase.co';

const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

// ── Mock session that matches Supabase SDK v2 format ────────────────────────
const MOCK_USER = {
  id: 'e2e-user-001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'e2e@test.local',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  phone: '',
  confirmed_at: '2026-01-01T00:00:00Z',
  last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'], role: 'admin' },
  user_metadata: { full_name: 'E2E Tester' },
  identities: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: new Date().toISOString(),
};

// Build a fake JWT that passes Supabase SDK's structural validation (3 dot-separated base64 parts)
function buildFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('e2e-fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const MOCK_ACCESS_TOKEN = buildFakeJwt({
  sub: MOCK_USER.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: MOCK_USER.email,
  exp: now + 86400,
  iat: now,
  iss: `${SUPABASE_URL}/auth/v1`,
  app_metadata: MOCK_USER.app_metadata,
  user_metadata: MOCK_USER.user_metadata,
});

const MOCK_SESSION = {
  access_token: MOCK_ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: 86400,
  expires_at: now + 86400,
  refresh_token: 'e2e-refresh-' + Date.now(),
  user: MOCK_USER,
};

setup('set mock auth state', async ({ page }) => {
  // Intercept Supabase auth API calls so the mock token is accepted
  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/user') || url.includes('/session')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...MOCK_SESSION,
          user: MOCK_USER,
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Intercept REST API calls — let them through to real Supabase when possible
  // The auth setup only needs basic mocking for initial page load
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: route.request().postData() || JSON.stringify({}),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // Intercept Edge Functions
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Abort realtime to prevent hanging connections
  await page.route(`${SUPABASE_URL}/realtime/**`, (route) => route.abort());

  await page.goto('/');

  // Set Supabase auth token in localStorage
  const storageKey = `sb-${PROJECT_REF}-auth-token`;
  await page.evaluate(
    ([key, session]) => {
      localStorage.setItem(key, JSON.stringify(session));
    },
    [storageKey, MOCK_SESSION],
  );

  // Reload to trigger onAuthStateChange with the stored session
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Save storage state for other tests
  await page.context().storageState({ path: 'e2e/.auth/storage-state.json' });
});
