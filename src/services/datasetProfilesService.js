import { supabase } from './supabaseClient';

const DATASET_PROFILES_MIGRATION_HINT = "Dataset profile table is unavailable in PostgREST. Run sql/migrations/di_dataset_profiles.sql in Supabase SQL Editor, then run: NOTIFY pgrst, 'reload schema';";
const LOCAL_DATASET_PROFILES_KEY = 'di_dataset_profiles_local_v1';

// ── Local profile cache (survives Supabase failures) ─────────────────────────
const _localProfileCache = new Map(); // profileId → profile object
let _localProfilesHydrated = false;

function getLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function hydrateLocalProfiles() {
  if (_localProfilesHydrated) return;
  _localProfilesHydrated = true;

  const storage = getLocalStorage();
  if (!storage) return;

  try {
    const raw = storage.getItem(LOCAL_DATASET_PROFILES_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(profiles)) return;
    profiles.forEach((profile) => {
      if (profile?.id) {
        _localProfileCache.set(String(profile.id), profile);
      }
    });
  } catch {
    // Ignore malformed local cache.
  }
}

function persistLocalProfiles() {
  const storage = getLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(
      LOCAL_DATASET_PROFILES_KEY,
      JSON.stringify(Array.from(_localProfileCache.values()))
    );
  } catch {
    // Ignore quota or storage access issues.
  }
}

function cacheProfile(profile, { persist = false } = {}) {
  if (!profile?.id) return;
  hydrateLocalProfiles();
  _localProfileCache.set(String(profile.id), profile);
  if (persist) {
    persistLocalProfiles();
  }
}

/** Register a locally-created profile so getDatasetProfileById can find it. */
export function registerLocalProfile(profile) {
  cacheProfile(profile, { persist: true });
}

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
    hydrateLocalProfiles();
    const insertPayload = normalizeCreatePayload(payload);
    console.log('[datasetProfilesService] INSERT attempt — user_id:', insertPayload.user_id, 'fingerprint:', insertPayload.fingerprint?.slice(0, 40));
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .insert([insertPayload])
      .select('*')
      .single();

    if (error) {
      console.error('[datasetProfilesService] DB save failed:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        status: error.status || error.statusCode,
      });
      const localProfile = {
        ...insertPayload,
        id: `local-${Date.now()}`,
        created_at: new Date().toISOString(),
        _local: true
      };
      registerLocalProfile(localProfile);
      return localProfile;
    }
    console.log('[datasetProfilesService] INSERT success — profile id:', data.id);
    cacheProfile(data);
    return data;
  },

  async getLatestDatasetProfile(userId) {
    hydrateLocalProfiles();
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
    hydrateLocalProfiles();
    // Local profiles live in memory only — skip Supabase query
    const profileIdStr = String(profileId || '');
    if (profileIdStr.startsWith('local-')) {
      const cached = _localProfileCache.get(profileIdStr);
      return cached || null;
    }

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
    hydrateLocalProfiles();
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
    cacheProfile(data);
    return data;
  },

  async findByFingerprint(userId, fingerprint) {
    hydrateLocalProfiles();
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
    hydrateLocalProfiles();
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

  /** List all dataset profiles for a user (most recent first). */
  async listAll(userId, { limit = 50 } = {}) {
    hydrateLocalProfiles();
    const { data, error } = await supabase
      .from('di_dataset_profiles')
      .select('id, fingerprint, profile_json, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throwDatasetProfilesError(error);

    // Merge local-only profiles that are not in the DB result
    const dbIds = new Set((data || []).map((r) => String(r.id)));
    const localExtras = [];
    for (const [id, profile] of _localProfileCache) {
      if (!dbIds.has(id)) {
        localExtras.push({
          id: profile.id,
          fingerprint: profile.fingerprint,
          profile_json: profile.profile_json,
          created_at: profile.created_at,
          _local: true,
        });
      }
    }
    return [...localExtras, ...(data || [])];
  },

  // Backward-compatible alias
  async createProfile(payload = {}) {
    return this.createDatasetProfile(payload);
  }
};

export default datasetProfilesService;
