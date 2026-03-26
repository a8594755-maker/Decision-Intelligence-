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
  try {
    let cacheKey, fingerprint, summary;
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

// ── Version History ─────────────────────────────────────────────────────────

const HISTORY_KEY = 'di_dashboard_history';
const MAX_VERSIONS = 10;

/**
 * Get all saved dashboard versions.
 * @returns {{ version: number, title: string, timestamp: string, html: string, suggestions?: object[], review?: object }[]}
 */
export function getDashboardHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

/**
 * Save a dashboard version to history.
 * Keeps last MAX_VERSIONS versions.
 */
export function saveDashboardVersion(dashResult) {
  if (!dashResult?.html && !dashResult?.dataCards?.length) return;
  try {
    const history = getDashboardHistory();
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
    // Keep only last MAX_VERSIONS
    while (history.length > MAX_VERSIONS) history.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // localStorage full — silently skip
  }
}
