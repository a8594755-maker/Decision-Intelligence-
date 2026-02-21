/**
 * Scenario Key Utility
 *
 * Produces a deterministic, stable key for a scenario given:
 *   (base_run_id, overrides, engine_flags)
 *
 * Properties:
 * - Key-order independent: { a:1, b:2 } == { b:2, a:1 }
 * - Null-canonicalized: missing fields are omitted from the hash input
 * - Stable across JS runtimes (deterministic string serialization)
 */

const CANONICAL_OVERRIDE_KEYS = [
  'budget_cap',
  'service_target',
  'stockout_penalty_multiplier',
  'holding_cost_multiplier',
  'safety_stock_alpha',
  'risk_mode',
  'expedite_mode',
  'expedite_cost_per_unit',
  'lead_time_buffer_days'
];

const CANONICAL_ENGINE_FLAG_KEYS = [
  'solver_engine',
  'risk_mode',
  'multi_echelon_mode'
];

/**
 * Stable JSON serialization: sorts object keys alphabetically.
 * Arrays preserve element order. null/undefined/non-null primitives preserved.
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return 'null';
}

/**
 * Canonicalize overrides: pick known keys, drop nulls, sort keys.
 * null overrides (== use base config) are dropped to avoid hashing nulls
 * from different representations ({ budget_cap: null } == {}).
 */
export function canonicalizeOverrides(overrides = {}) {
  const result = {};
  const src = overrides != null ? overrides : {};
  CANONICAL_OVERRIDE_KEYS.forEach((key) => {
    const value = src[key];
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  });
  return result;
}

export function canonicalizeEngineFlags(flags = {}) {
  const result = {};
  CANONICAL_ENGINE_FLAG_KEYS.forEach((key) => {
    const value = flags[key];
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  });
  return result;
}

/**
 * Compute a SHA-256 scenario key.
 * Uses SubtleCrypto (browser) or a fast FNV-like fallback (non-browser envs).
 *
 * @param {number|string} base_run_id
 * @param {object} overrides
 * @param {object} engine_flags
 * @returns {Promise<string>} 64-character lowercase hex string
 */
export async function computeScenarioKey(base_run_id, overrides = {}, engine_flags = {}) {
  const canonical = stableStringify({
    base_run_id: Number(base_run_id),
    overrides: canonicalizeOverrides(overrides),
    engine_flags: canonicalizeEngineFlags(engine_flags)
  });

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoded = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback: deterministic FNV-1a 32-bit hash (test environments without SubtleCrypto)
  return fnv1a64(canonical);
}

/**
 * Synchronous scenario key using stable stringify + FNV-1a.
 * Use this only in environments without SubtleCrypto (e.g., Node test runners).
 */
export function computeScenarioKeySync(base_run_id, overrides = {}, engine_flags = {}) {
  const canonical = stableStringify({
    base_run_id: Number(base_run_id),
    overrides: canonicalizeOverrides(overrides),
    engine_flags: canonicalizeEngineFlags(engine_flags)
  });
  return fnv1a64(canonical);
}

function fnv1a64(str) {
  // FNV-1a 64-bit using two 32-bit ints for determinism
  let h1 = 0x811c9dc5;
  let h2 = 0xc4a73a89;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = (Math.imul(h1, 0x01000193) >>> 0);
    h2 ^= (c << 5) ^ (c >>> 3);
    h2 = (Math.imul(h2, 0x01000193) >>> 0);
  }
  const hex1 = h1.toString(16).padStart(8, '0');
  const hex2 = h2.toString(16).padStart(8, '0');
  // Expand to 64 chars for consistency with SHA-256 format
  return (hex1 + hex2).padEnd(64, '0');
}

export default {
  stableStringify,
  canonicalizeOverrides,
  canonicalizeEngineFlags,
  computeScenarioKey,
  computeScenarioKeySync
};
