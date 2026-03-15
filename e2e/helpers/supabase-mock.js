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

  // REST API — smart mock: track inserts, return them on reads
  const _mockStore = {}; // table → [rows]

  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
    const method = route.request().method();
    const url = route.request().url();

    // Extract table name from URL: /rest/v1/TABLE_NAME?...
    const tableName = url.split('/rest/v1/')[1]?.split('?')[0] || 'unknown';

    if (method === 'POST') {
      // INSERT — parse body, add generated fields, store in mock
      let body;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
      // Handle both single object and array inserts
      const rows = Array.isArray(body) ? body : [body];
      const enriched = rows.map(row => ({
        ...row,
        id: row.id || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: row.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      if (!_mockStore[tableName]) _mockStore[tableName] = [];
      _mockStore[tableName].push(...enriched);

      // Supabase returns array when Prefer: return=representation
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(enriched.length === 1 ? enriched[0] : enriched),
      });
    }

    if (method === 'PATCH' || method === 'PUT') {
      // UPDATE — parse body, update matching rows in store
      let body;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
      const stored = _mockStore[tableName] || [];

      // Extract filter from URL query params (e.g. ?id=eq.xxx)
      const urlObj = new URL(url);
      const idFilter = urlObj.searchParams.get('id');
      const idValue = idFilter?.startsWith('eq.') ? idFilter.slice(3) : null;

      let updated = { ...body, updated_at: new Date().toISOString() };
      if (idValue) {
        const idx = stored.findIndex(r => r.id === idValue);
        if (idx >= 0) {
          stored[idx] = { ...stored[idx], ...updated };
          updated = stored[idx];
        }
      } else if (stored.length > 0) {
        // Update last matching row
        stored[stored.length - 1] = { ...stored[stored.length - 1], ...updated };
        updated = stored[stored.length - 1];
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(updated),
      });
    }

    // GET — return stored data with basic PostgREST-style filtering
    let rows = [...(_mockStore[tableName] || [])];

    // Apply filters from query params (eq., in., not., is.)
    const urlObj = new URL(url);
    for (const [key, rawVal] of urlObj.searchParams.entries()) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
      if (rawVal.startsWith('eq.')) {
        const val = rawVal.slice(3);
        rows = rows.filter(r => String(r[key]) === val);
      } else if (rawVal.startsWith('in.')) {
        // in.(val1,val2,...) — PostgREST format
        const vals = rawVal.slice(4, -1).split(',').map(v => v.replace(/^"|"$/g, ''));
        rows = rows.filter(r => vals.includes(String(r[key])));
      } else if (rawVal.startsWith('not.is.')) {
        // not.is.null → filter rows where field is NOT null/undefined
        rows = rows.filter(r => r[key] != null);
      } else if (rawVal.startsWith('is.')) {
        const val = rawVal.slice(3);
        if (val === 'null') rows = rows.filter(r => r[key] == null);
      }
    }

    // Apply limit
    const limit = urlObj.searchParams.get('limit');
    if (limit) rows = rows.slice(0, parseInt(limit, 10));

    // Apply order
    const order = urlObj.searchParams.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      rows.sort((a, b) => {
        const va = a[col] ?? 0, vb = b[col] ?? 0;
        return dir === 'desc' ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1);
      });
    }

    // Handle .single() / .maybeSingle() — Accept header contains vnd.pgrst.object
    const accept = route.request().headers()['accept'] || '';
    if (accept.includes('vnd.pgrst.object')) {
      if (rows.length === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows[0]) });
      } else if (rows.length === 0) {
        // maybeSingle returns null (200 with empty body)
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      } else {
        // multiple rows — single() would fail, maybeSingle returns first
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows[0]) });
      }
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rows),
    });
  });

  // Edge Functions — let ai-proxy through for real LLM calls, mock the rest
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/ai-proxy')) {
      return route.continue(); // Let real LLM calls through
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Realtime — abort to prevent hanging connections
  await page.route(`${SUPABASE_URL}/realtime/**`, (route) => route.abort());
}
