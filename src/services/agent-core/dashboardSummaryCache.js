// dashboardSummaryCache.js
// ─────────────────────────────────────────────────────────────────────────────
// LocalStorage-backed cache for the Insights Hub AI summary.
// Avoids repeated LLM calls when the user revisits the dashboard within 24h
// and no new snapshots have been added.
//
// Cache key: fingerprint = `${count}:${latestId}:${latestTimestamp}`
// This catches additions, deletions, and replacements (same count but different content).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CACHE_KEY = 'di_dashboard_summary';
const CACHE_TTL_MS = Infinity; // Persistent — cleared only by user action (Regenerate)

/**
 * Build a fingerprint from snapshots that detects any content change.
 * @param {object[]} snapshots
 * @returns {string}
 */
export function buildSnapshotFingerprint(snapshots) {
  if (!snapshots?.length) return '0::';
  const latest = snapshots[0]; // already sorted by created_at DESC
  return `${snapshots.length}:${latest.id || ''}:${latest.created_at || ''}`;
}

/**
 * Get cached data if still valid.
 * @param {string} keyOrFingerprint - cache key (when 2 args) or fingerprint (legacy 1-arg)
 * @param {string} [currentFingerprint] - fingerprint of current snapshot set
 * @returns {object|null} cached data or null
 */
export function getCachedSummary(keyOrFingerprint, currentFingerprint) {
  try {
    // Support both (fingerprint) and (key, fingerprint) signatures
    const cacheKey = currentFingerprint ? keyOrFingerprint : DEFAULT_CACHE_KEY;
    const fp = currentFingerprint || keyOrFingerprint;
    const raw = localStorage.getItem(cacheKey);
    if (!raw) { console.info(`[cache] Miss: ${cacheKey} — not in localStorage`); return null; }
    const { summary, fingerprint, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) { console.info(`[cache] Miss: ${cacheKey} — expired`); return null; }
    if (fingerprint !== fp) { console.info(`[cache] Miss: ${cacheKey} — fingerprint mismatch (stored=${fingerprint}, current=${fp})`); return null; }
    console.info(`[cache] Hit: ${cacheKey}, ${(raw.length / 1024).toFixed(0)}KB, age=${Math.round((Date.now() - timestamp) / 1000)}s`);
    return summary;
  } catch {
    return null;
  }
}

/**
 * Cache data.
 * @param {string} keyOrSummary - cache key (when 3 args) or summary object (legacy 2-arg)
 * @param {string|object} fingerprintOrSummary - fingerprint (legacy) or summary data
 * @param {object} [data] - data to cache (when using 3-arg form)
 */
export function setCachedSummary(keyOrSummary, fingerprintOrSummary, data) {
  let cacheKey = DEFAULT_CACHE_KEY;
  try {
    let fingerprint;
    let summary;
    if (data !== undefined) {
      // 3-arg form: (key, fingerprint, data)
      cacheKey = keyOrSummary;
      fingerprint = fingerprintOrSummary;
      summary = data;
    } else {
      // Legacy 2-arg form: (summary, fingerprint)
      cacheKey = DEFAULT_CACHE_KEY;
      summary = keyOrSummary;
      fingerprint = fingerprintOrSummary;
    }
    const payload = JSON.stringify({ summary, fingerprint, timestamp: Date.now() });
    localStorage.setItem(cacheKey, payload);
    console.info(`[cache] Saved ${cacheKey}: ${(payload.length / 1024).toFixed(0)}KB, fingerprint=${fingerprint}`);
  } catch (e) {
    console.error(`[cache] Save FAILED for ${cacheKey}: ${e.message}. Payload may exceed localStorage quota.`);
  }
}

/**
 * Clear a cached entry (e.g. when user manually refreshes).
 * @param {string} [key] - cache key to clear (defaults to dashboard summary)
 */
export function clearCachedSummary(key) {
  try {
    localStorage.removeItem(key || DEFAULT_CACHE_KEY);
  } catch {
    // noop
  }
}

// ── Version History (IndexedDB-backed) ──────────────────────────────────────

import { getCached, setCached } from '../storage/indexedDbCache.js';

const HISTORY_KEY = 'di_dashboard_history';
const MAX_VERSIONS = 10;

/**
 * Get all saved dashboard versions.
 * Async — reads from IndexedDB. Falls back to localStorage for migration.
 */
export async function getDashboardHistory() {
  try {
    const idbHistory = await getCached(HISTORY_KEY);
    if (Array.isArray(idbHistory) && idbHistory.length > 0) return idbHistory;
    // Fallback: migrate from localStorage
    const lsRaw = localStorage.getItem(HISTORY_KEY);
    if (lsRaw) {
      const lsHistory = JSON.parse(lsRaw);
      if (Array.isArray(lsHistory) && lsHistory.length > 0) {
        await setCached(HISTORY_KEY, lsHistory); // migrate to IndexedDB
        localStorage.removeItem(HISTORY_KEY); // clean up
        return lsHistory;
      }
    }
  } catch { /* */ }
  return [];
}

/**
 * Save a dashboard version to history.
 * Keeps last MAX_VERSIONS versions.
 */
export async function saveDashboardVersion(dashResult) {
  if (!dashResult?.html && !dashResult?.dataCards?.length) return;
  try {
    const history = await getDashboardHistory();
    const version = (history.length > 0 ? Math.max(...history.map(h => h.version || 0)) : 0) + 1;
    history.push({
      version,
      title: dashResult.title || `Version ${version}`,
      subtitle: dashResult.subtitle,
      timestamp: new Date().toISOString(),
      html: dashResult.html,
      dataCards: dashResult.dataCards,
      layout: dashResult.layout,
      suggestions: dashResult.suggestions,
      review: dashResult.review,
      thinking: dashResult.thinking,
    });
    while (history.length > MAX_VERSIONS) history.shift();
    await setCached(HISTORY_KEY, history);
  } catch (e) {
    console.warn(`[dashboardCache] saveDashboardVersion failed: ${e.message}`);
  }
}
