import { supabase, RPC_JSON_OPTIONS } from './supabaseClient';

const RESET_RPC_MIGRATION_HINT = "Reset RPC is unavailable in PostgREST. Run sql/migrations/di_reset_user_data.sql in Supabase SQL Editor, then run: NOTIFY pgrst, 'reload schema';";

function normalizeResetError(error) {
  if (error instanceof Error) return error;

  const parts = [
    error?.message,
    error?.details,
    error?.hint,
    error?.error_description
  ].filter(Boolean);

  const fallback = 'Failed to clear Decision-Intelligence data';
  const normalized = new Error(parts.length > 0 ? parts.join(' | ') : fallback);
  normalized.cause = error;
  return normalized;
}

function throwResetError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const blob = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ').toLowerCase();
  const mentionsResetRpc = blob.includes('di_reset_user_data');
  const missingRpcSignal = blob.includes('schema cache')
    || blob.includes('does not exist')
    || blob.includes('not found')
    || blob.includes('undefined function');

  if (code === 'PGRST202' || code === '42883' || status === 404 || (mentionsResetRpc && missingRpcSignal)) {
    const friendly = new Error(RESET_RPC_MIGRATION_HINT);
    friendly.cause = error;
    throw friendly;
  }

  throw normalizeResetError(error);
}

export const diResetService = {
  async resetCurrentUserData() {
    const { data, error } = await supabase.rpc('di_reset_user_data', {}, RPC_JSON_OPTIONS);
    if (error) throwResetError(error);
    return data || {};
  }
};

export default diResetService;
