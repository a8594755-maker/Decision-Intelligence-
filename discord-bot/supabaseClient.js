// supabaseClient.js — Supabase client for Discord bot (Node.js process)
// Uses service_role key to bypass RLS (server-to-server)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let _supabase = null;

export function getSupabase() {
  if (_supabase) return _supabase;

  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    console.warn('[supabaseClient] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — approval features disabled');
    return null;
  }

  _supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  });

  return _supabase;
}

export default { getSupabase };
