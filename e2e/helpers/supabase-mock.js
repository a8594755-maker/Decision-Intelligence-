/**
 * Shared Supabase API interception for E2E tests.
 * Intercepts auth, REST, Edge Functions, and Realtime to prevent 401 errors
 * from the mock JWT token.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
    const match = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || readEnvVar('VITE_SUPABASE_URL') || '';

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

/**
 * Intercept all Supabase API calls on the given page.
 * Call this before navigating to any route.
 */
export async function interceptSupabase(page) {
  if (!SUPABASE_URL) return;

  // Auth endpoints — return proper session with user
  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/user') || url.includes('/session')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlMmUtdXNlci0wMDEiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJlbWFpbCI6ImUyZUB0ZXN0LmxvY2FsIiwiZXhwIjo5OTk5OTk5OTk5fQ.fake',
          token_type: 'bearer',
          expires_in: 86400,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          refresh_token: 'e2e-refresh',
          user: MOCK_USER,
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // REST API — return empty arrays for reads, success for writes
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      // For writes (insert/update), return the body back as if it was saved
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

  // Edge Functions — return empty response
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    }),
  );

  // Realtime — abort to prevent hanging connections
  await page.route(`${SUPABASE_URL}/realtime/**`, (route) => route.abort());
}
