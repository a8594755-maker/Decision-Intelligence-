// @product: mcp-server
//
// auth.js
// ─────────────────────────────────────────────────────────────────────────────
// API Key authentication and rate limiting for MCP Server.
// Supports multi-tenant isolation via API key → tenant mapping.
// ─────────────────────────────────────────────────────────────────────────────

// ── In-memory stores (replace with DB in production) ───────────────────────

const API_KEYS = new Map();
const RATE_COUNTERS = new Map();

// ── Tier definitions ───────────────────────────────────────────────────────

export const TIERS = {
  free:       { maxCallsPerHour: 100,   maxToolsAvailable: 5,  label: 'Free' },
  pro:        { maxCallsPerHour: 1000,  maxToolsAvailable: -1, label: 'Pro' },
  enterprise: { maxCallsPerHour: 10000, maxToolsAvailable: -1, label: 'Enterprise' },
};

const FREE_TOOLS = [
  'run_forecast',
  'run_plan',
  'run_risk_analysis',
  'query_sap_data',
  'get_supplier_rankings',
];

// ── API Key management ─────────────────────────────────────────────────────

export function registerApiKey(apiKey, { tenantId, tier = 'free', userId = null } = {}) {
  API_KEYS.set(apiKey, { tenantId, tier, userId, createdAt: new Date().toISOString() });
}

export function validateApiKey(apiKey) {
  if (!apiKey) return null;
  return API_KEYS.get(apiKey) || null;
}

// ── Rate limiting ──────────────────────────────────────────────────────────

function getRateKey(apiKey) {
  const now = new Date();
  const hourBucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
  return `${apiKey}:${hourBucket}`;
}

export function checkRateLimit(apiKey, tier) {
  const tierConfig = TIERS[tier] || TIERS.free;
  const key = getRateKey(apiKey);
  const count = RATE_COUNTERS.get(key) || 0;

  if (count >= tierConfig.maxCallsPerHour) {
    return { allowed: false, remaining: 0, limit: tierConfig.maxCallsPerHour };
  }

  RATE_COUNTERS.set(key, count + 1);
  return { allowed: true, remaining: tierConfig.maxCallsPerHour - count - 1, limit: tierConfig.maxCallsPerHour };
}

// ── Tool access control ────────────────────────────────────────────────────

export function canAccessTool(toolId, tier) {
  const tierConfig = TIERS[tier] || TIERS.free;
  if (tierConfig.maxToolsAvailable === -1) return true; // unlimited
  return FREE_TOOLS.includes(toolId);
}

// ── Auth middleware for MCP requests ───────────────────────────────────────

export function authenticateRequest(meta) {
  // In stdio mode (Claude Desktop), auth is implicit — the user launched the server.
  // For HTTP transport, check x-api-key header.
  const apiKey = meta?.apiKey || meta?.headers?.['x-api-key'];

  if (!apiKey) {
    // No key = local stdio mode, grant full access
    return { authenticated: true, tenantId: 'local', tier: 'enterprise', userId: 'local' };
  }

  const keyData = validateApiKey(apiKey);
  if (!keyData) {
    return { authenticated: false, error: 'Invalid API key' };
  }

  const rateCheck = checkRateLimit(apiKey, keyData.tier);
  if (!rateCheck.allowed) {
    return { authenticated: false, error: `Rate limit exceeded (${rateCheck.limit}/hour)` };
  }

  return { authenticated: true, ...keyData, rateRemaining: rateCheck.remaining };
}

// ── Initialize demo key for development ────────────────────────────────────

registerApiKey('di-dev-key-2026', { tenantId: 'dev', tier: 'enterprise', userId: 'developer' });

export default { authenticateRequest, registerApiKey, canAccessTool, TIERS };
