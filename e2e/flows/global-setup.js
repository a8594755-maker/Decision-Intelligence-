/**
 * Global beforeEach for flow tests — intercepts Supabase API calls.
 * Import and call in any test that needs Supabase mocking:
 *
 *   import { setupSupabaseMock } from './global-setup.js';
 *   test.beforeEach(async ({ page }) => { await setupSupabaseMock(page); });
 */
import { interceptSupabase } from '../helpers/supabase-mock.js';

export async function setupSupabaseMock(page) {
  await interceptSupabase(page);
}
