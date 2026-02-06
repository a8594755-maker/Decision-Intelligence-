/**
 * Lightweight view ↔ URL path mapping for SmartOps SPA.
 * No react-router; used with History API (pushState / popstate).
 */

const VIEW_PATH_MAP = {
  home: '/home',
  dashboard: '/operations/dashboard',
  alerts: '/operations/alerts',
  forecasts: '/planning/forecasts',
  'risk-dashboard': '/planning/risk-dashboard',
  'cost-analysis': '/analysis/cost-analysis',
  analytics: '/analysis/analytics',
  'bom-data': '/data/bom-data',
  external: '/data/upload',
  'import-history': '/data/import-history',
  integration: '/data/integration',
  suppliers: '/data/suppliers',
  decision: '/ai/decision',
  settings: '/settings'
};

/** Path → view lookup (inverse map) */
const PATH_VIEW_MAP = Object.fromEntries(
  Object.entries(VIEW_PATH_MAP).map(([v, p]) => [p, v])
);

/**
 * @param {string} view - View key (e.g. 'home', 'cost-analysis')
 * @returns {string} Path (e.g. '/home', '/analysis/cost-analysis')
 */
export function viewToPath(view) {
  return VIEW_PATH_MAP[view] ?? null;
}

/**
 * @param {string} pathname - Full pathname (e.g. '/analysis/cost-analysis')
 * @returns {string|null} View key or null if unknown path
 */
export function pathToView(pathname) {
  const normalized = pathname.endsWith('/') && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  return PATH_VIEW_MAP[normalized] ?? null;
}

/**
 * Parse current URL search params into a plain object.
 * @returns {Record<string, string>}
 */
export function getSearchParams() {
  const s = typeof window !== 'undefined' ? window.location.search : '';
  const params = {};
  new URLSearchParams(s).forEach((v, k) => { params[k] = v; });
  return params;
}

/**
 * Update URL search params (replaceState). Preserves pathname.
 * @param {Record<string, string>} params - Keys to set; use null/empty to remove.
 */
export function updateUrlSearch(params) {
  if (typeof window === 'undefined') return;
  const pathname = window.location.pathname;
  const prev = new URLSearchParams(window.location.search);
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') prev.delete(k);
    else prev.set(k, String(v));
  });
  const search = prev.toString();
  const url = pathname + (search ? `?${search}` : '');
  window.history.replaceState(window.history.state, '', url);
  try {
    sessionStorage.setItem('lastVisitedPath', url);
  } catch (_) {}
}
