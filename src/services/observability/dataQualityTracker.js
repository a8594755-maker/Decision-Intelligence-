/**
 * Data Quality Tracker
 *
 * localStorage-backed quality trend tracker.
 * Stores per-import quality snapshots and provides trend queries.
 */

const STORAGE_KEY = 'di_data_quality_history';
const MAX_ENTRIES = 100;

export function createDataQualityTracker() {
  function loadHistory() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveHistory(entries) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
      }
    } catch { /* unavailable in tests/SSR */ }
  }

  return {
    recordSnapshot({ importId, timestamp, validationRate, fallbackRate, autoMappedPct, sheetsProcessed }) {
      const history = loadHistory();
      history.push({
        importId,
        timestamp: timestamp || new Date().toISOString(),
        validationRate,
        fallbackRate,
        autoMappedPct,
        sheetsProcessed,
      });
      saveHistory(history);
    },

    getHistory(limit = 20) {
      return loadHistory().slice(-limit);
    },

    getTrend() {
      const history = loadHistory();
      if (history.length < 2) return { trend: 'insufficient_data', entries: history.length };

      const recent = history.slice(-5);
      const avgValidation = recent.reduce((s, e) => s + (e.validationRate || 0), 0) / recent.length;
      const avgFallback = recent.reduce((s, e) => s + (e.fallbackRate || 0), 0) / recent.length;

      return {
        trend: avgValidation > 90 ? 'healthy' : avgValidation > 70 ? 'degrading' : 'poor',
        avgValidationRate: Math.round(avgValidation),
        avgFallbackRate: Math.round(avgFallback),
        entries: history.length,
      };
    },

    clear() {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
      } catch { /* ignore */ }
    },
  };
}
