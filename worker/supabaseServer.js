/**
 * supabaseServer.js — Server-side Supabase client using service role key.
 *
 * Used by the worker process for privileged DB access (no user JWT needed).
 * Falls back to anon key if service role key is not set.
 */

import { createClient } from '@supabase/supabase-js';

const _env = (key) => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.[key]) return import.meta.env[key];
  if (typeof process !== 'undefined' && process.env?.[key]) return process.env[key];
  return '';
};

const supabaseUrl = _env('VITE_SUPABASE_URL');
const serviceRoleKey = _env('SUPABASE_SERVICE_ROLE_KEY');
const anonKey = _env('VITE_SUPABASE_ANON_KEY');

if (!supabaseUrl) {
  console.error('[Worker] VITE_SUPABASE_URL is not set. Worker cannot connect to Supabase.');
}

const key = serviceRoleKey || anonKey;
if (!key) {
  console.error('[Worker] Neither SUPABASE_SERVICE_ROLE_KEY nor VITE_SUPABASE_ANON_KEY is set.');
}

export const supabaseServer = supabaseUrl && key
  ? createClient(supabaseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
