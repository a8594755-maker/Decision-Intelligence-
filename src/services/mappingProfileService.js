/**
 * Mapping Profile Service
 *
 * Stores and retrieves mapping profiles per source pattern (column header fingerprint).
 * When a user successfully imports data, the mapping is saved. On future imports from
 * the same source format, the saved mapping is auto-applied.
 *
 * Storage: Supabase `di_mapping_profiles` table with localStorage fallback.
 */

import { supabase } from './supabaseClient';

const LOCAL_STORAGE_KEY = 'di_mapping_profiles_cache';
const MAX_LOCAL_PROFILES = 50;

// ── Fingerprint generation ──────────────────────────────────────────────────

/**
 * Generate a fingerprint from sorted column headers.
 * Two files with the same columns (regardless of order) produce the same fingerprint.
 *
 * @param {string[]} headers
 * @returns {string}
 */
export function generateHeaderFingerprint(headers) {
  const normalized = (headers || [])
    .map(h => String(h).trim().toLowerCase().replace(/[\s_-]+/g, ''))
    .filter(Boolean)
    .sort();
  // Simple hash via string concat — sufficient for matching
  return normalized.join('|');
}

// ── Local cache helpers ─────────────────────────────────────────────────────

function getLocalProfiles() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLocalProfiles(profiles) {
  try {
    // Keep only most recent N profiles
    const trimmed = profiles.slice(0, MAX_LOCAL_PROFILES);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage may be full or unavailable
  }
}

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * Save a mapping profile after a successful import.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.sourceFingerprint – Generated from headers via generateHeaderFingerprint()
 * @param {string} params.uploadType        – e.g. 'inventory_snapshots'
 * @param {object} params.columnMapping     – { sourceCol: canonicalField }
 * @param {object} [params.fieldConfidence] – Optional confidence metadata per field
 * @returns {Promise<{ id: string, source: 'supabase'|'local' } | null>}
 */
export async function saveMappingProfile({ userId, sourceFingerprint, uploadType, columnMapping, fieldConfidence, headerList }) {
  const record = {
    user_id: userId,
    source_fingerprint: sourceFingerprint,
    upload_type: uploadType,
    column_mapping: columnMapping,
    field_confidence: fieldConfidence || null,
    header_list: headerList || [],
    display_name: `${uploadType} (${(headerList || []).length} cols)`,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    use_count: 1,
  };

  // Try Supabase first
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('di_mapping_profiles')
        .upsert(
          {
            user_id: userId,
            source_fingerprint: sourceFingerprint,
            upload_type: uploadType,
            column_mapping: columnMapping,
            field_confidence: fieldConfidence || null,
            header_list: headerList || [],
            display_name: `${uploadType} (${(headerList || []).length} cols)`,
            last_used_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,source_fingerprint,upload_type' }
        )
        .select('id')
        .single();

      if (!error && data) {
        // Also cache locally
        updateLocalCache(record);
        return { id: data.id, source: 'supabase' };
      }
    }
  } catch {
    // Supabase unavailable — fall through to local
  }

  // Local fallback
  updateLocalCache(record);
  return { id: sourceFingerprint, source: 'local' };
}

function updateLocalCache(record) {
  const profiles = getLocalProfiles();
  const idx = profiles.findIndex(
    p => p.source_fingerprint === record.source_fingerprint
      && p.upload_type === record.upload_type
      && p.user_id === record.user_id
  );
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], ...record, use_count: (profiles[idx].use_count || 0) + 1 };
  } else {
    profiles.unshift(record);
  }
  setLocalProfiles(profiles);
}

/**
 * Find a previously saved mapping profile for a given set of headers and upload type.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string[]} params.headers     – Raw source headers
 * @param {string} params.uploadType    – e.g. 'inventory_snapshots'
 * @returns {Promise<{ columnMapping: object, fieldConfidence: object|null, useCount: number, source: string } | null>}
 */
export async function findMappingProfile({ userId, headers, uploadType }) {
  const fingerprint = generateHeaderFingerprint(headers);

  // Try Supabase first
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('di_mapping_profiles')
        .select('column_mapping, field_confidence, use_count')
        .eq('user_id', userId)
        .eq('source_fingerprint', fingerprint)
        .eq('upload_type', uploadType)
        .single();

      if (!error && data) {
        // Update last_used_at and use_count (fire-and-forget)
        supabase
          .from('di_mapping_profiles')
          .update({ last_used_at: new Date().toISOString(), use_count: (data.use_count || 0) + 1 })
          .eq('user_id', userId)
          .eq('source_fingerprint', fingerprint)
          .eq('upload_type', uploadType)
          .then(() => {});

        return {
          columnMapping: data.column_mapping,
          fieldConfidence: data.field_confidence,
          useCount: data.use_count || 1,
          source: 'supabase',
        };
      }
    }
  } catch {
    // Supabase unavailable — fall through to local
  }

  // Local fallback
  const profiles = getLocalProfiles();
  const match = profiles.find(
    p => p.source_fingerprint === fingerprint
      && p.upload_type === uploadType
      && p.user_id === userId
  );

  if (match) {
    return {
      columnMapping: match.column_mapping,
      fieldConfidence: match.field_confidence,
      useCount: match.use_count || 1,
      source: 'local',
    };
  }

  return null;
}

/**
 * Delete a saved mapping profile.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string[]} params.headers
 * @param {string} params.uploadType
 */
export async function deleteMappingProfile({ userId, headers, uploadType }) {
  const fingerprint = generateHeaderFingerprint(headers);

  try {
    if (supabase) {
      await supabase
        .from('di_mapping_profiles')
        .delete()
        .eq('user_id', userId)
        .eq('source_fingerprint', fingerprint)
        .eq('upload_type', uploadType);
    }
  } catch {
    // Ignore Supabase errors
  }

  // Also remove from local cache
  const profiles = getLocalProfiles();
  const filtered = profiles.filter(
    p => !(p.source_fingerprint === fingerprint && p.upload_type === uploadType && p.user_id === userId)
  );
  setLocalProfiles(filtered);
}

// ── New functions for profile reuse & management ─────────────────────────────

/**
 * List all mapping profiles for a user, sorted by last_used_at descending.
 *
 * @param {object} params
 * @param {string} params.userId
 * @returns {Promise<Array<object>>}
 */
export async function listMappingProfiles({ userId }) {
  // Try Supabase
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('di_mapping_profiles')
        .select('*')
        .eq('user_id', userId)
        .order('last_used_at', { ascending: false });

      if (!error && data) return data;
    }
  } catch {
    // Supabase unavailable — fall through to local
  }

  // Local fallback
  return getLocalProfiles()
    .filter(p => p.user_id === userId)
    .sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''));
}

/**
 * Validate a saved profile's columnMapping against a new set of headers.
 * Determines whether the profile can be fully or partially reused.
 *
 * @param {object} profile           – { columnMapping: { srcCol: targetField } }
 * @param {string[]} currentHeaders  – Headers from the new file
 * @returns {{ valid: boolean, partiallyValid: boolean, staleColumns: string[], newColumns: string[], applicableMapping: object }}
 */
export function validateProfileAgainstHeaders(profile, currentHeaders) {
  const normalize = h => String(h).trim().toLowerCase();
  const currentNormSet = new Set((currentHeaders || []).map(normalize));

  const applicableMapping = {};
  const staleColumns = [];

  for (const [srcCol, targetField] of Object.entries(profile.columnMapping || {})) {
    if (currentNormSet.has(normalize(srcCol))) {
      applicableMapping[srcCol] = targetField;
    } else {
      staleColumns.push(srcCol);
    }
  }

  // Detect new columns not covered by the profile
  const profileSrcNormSet = new Set(
    Object.keys(profile.columnMapping || {}).map(normalize)
  );
  const newColumns = (currentHeaders || []).filter(
    h => !profileSrcNormSet.has(normalize(h))
  );

  const valid = staleColumns.length === 0 && newColumns.length === 0;
  const partiallyValid = Object.keys(applicableMapping).length > 0;

  return { valid, partiallyValid, staleColumns, newColumns, applicableMapping };
}

/**
 * Delete a mapping profile by its database ID (for management UI).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.id              – Profile UUID
 * @param {string} [params.fingerprint]   – For local cache cleanup
 * @param {string} [params.uploadType]    – For local cache cleanup
 */
export async function deleteMappingProfileById({ userId, id, fingerprint, uploadType }) {
  // Supabase
  try {
    if (supabase) {
      await supabase
        .from('di_mapping_profiles')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);
    }
  } catch {
    // Ignore Supabase errors
  }

  // Also remove from local cache if fingerprint provided
  if (fingerprint && uploadType) {
    const profiles = getLocalProfiles();
    const filtered = profiles.filter(
      p => !(p.source_fingerprint === fingerprint && p.upload_type === uploadType && p.user_id === userId)
    );
    setLocalProfiles(filtered);
  }
}
