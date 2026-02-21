import { supabase } from './supabaseClient';

const DATASET_PROFILES_MIGRATION_HINT = "Dataset profile table is unavailable in PostgREST. Run sql/migrations/di_dataset_profiles.sql in Supabase SQL Editor, then run: NOTIFY pgrst, 'reload schema';";

function normalizeUnknownError(error, fallbackMessage) {
  if (error instanceof Error) return error;

  const messageParts = [
    error?.message,
    error?.details,
    error?.hint,
    error?.error_description
  ].filter(Boolean);

  const code = String(error?.code || '').trim();
  const status = Number(error?.status || 0);
  const fallbackWithMeta = [
    fallbackMessage || 'Unexpected dataset profiles error',
    code ? `code=${code}` : null,
    status ? `status=${status}` : null
  ].filter(Boolean).join(' ');

  const normalized = new Error(
    messageParts.length > 0
      ? messageParts.join(' | ')
      : fallbackWithMeta
  );

  normalized.cause = error;
  return normalized;
}

function throwDatasetProfilesError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const detailBlob = [
    error?.message,
    error?.details,
    error?.hint
  ].filter(Boolean).join(' ').toLowerCase();
  const referencesDatasetProfiles = detailBlob.includes('di_dataset_profiles');
  const missingTableSignal = detailBlob.includes('schema cache')
    || detailBlob.includes('does not exist')
    || detailBlob.includes('not found');

  if (
    code === 'PGRST205'
    || (referencesDatasetProfiles && missingTableSignal)
    || status === 404
  ) {
    const friendly = new Error(DATASET_PROFILES_MIGRATION_HINT);
    friendly.cause = error;
    throw friendly;
  }

  throw normalizeUnknownError(error, 'Failed to persist dataset profile');
}

function normalizeCreatePayload(payload = {}) {
  const profileJson = payload.profile_json || payload.profile || {};
  const contractJson = payload.contract_json || payload.contract || {};
  const userId = payload.user_id || payload.userId;
  const userFileId = payload.user_file_id || payload.userFileId || null;
  const fingerprint = payload.fingerprint || profileJson?.fingerprint || null;

  if (!userId) {
    throw new Error('user_id is required');
  }
  if (!fingerprint) {
    throw new Error('fingerprint is required');
  }

  return {
    user_id: userId,
    user_file_id: userFileId,
    fingerprint: String(fingerprint),
    profile_json: profileJson,
    contract_json: contractJson
  };
}

export const datasetProfilesService = {
  async createDatasetProfile(payload = {}) {
    const insertPayload = normalizeCreatePayload(payload);
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .insert([insertPayload])
      .select('*')
      .single();

    if (error) throwDatasetProfilesError(error);
    return data;
  },

  async getLatestDatasetProfile(userId) {
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throwDatasetProfilesError(error);
    return data || null;
  },

  async getDatasetProfileById(userId, profileId) {
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('id', profileId)
      .maybeSingle();

    if (error) throwDatasetProfilesError(error);
    return data || null;
  },

  async updateDatasetProfile(userId, profileId, updates = {}) {
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(updates, 'profile_json')) {
      payload.profile_json = updates.profile_json;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'contract_json')) {
      payload.contract_json = updates.contract_json;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'fingerprint')) {
      payload.fingerprint = String(updates.fingerprint || '');
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'user_file_id')) {
      payload.user_file_id = updates.user_file_id || null;
    }

    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .update(payload)
      .eq('user_id', userId)
      .eq('id', profileId)
      .select('*')
      .single();

    if (error) throwDatasetProfilesError(error);
    return data;
  },

  async findByFingerprint(userId, fingerprint) {
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('fingerprint', fingerprint)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throwDatasetProfilesError(error);
    return data || null;
  },

  async listByFingerprint(userId, fingerprint, limit = 25) {
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('fingerprint', fingerprint)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throwDatasetProfilesError(error);
    return data || [];
  },

  // Backward-compatible alias
  async createProfile(payload = {}) {
    return this.createDatasetProfile(payload);
  }
};

export default datasetProfilesService;
