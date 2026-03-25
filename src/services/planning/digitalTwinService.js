/**
 * digitalTwinService.js
 *
 * Service layer for Digital Twin simulation API endpoints.
 * Wraps the Python FastAPI backend at /scenarios, /run-simulation, /optimize, /simulation-comparison.
 */

const ML_API_BASE = import.meta.env.VITE_ML_API_URL || '';

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Digital Twin API timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function fetchJson(path, timeoutMs = 15000) {
  const baseUrl = normalizeBaseUrl(ML_API_BASE);
  if (!baseUrl) throw new Error('VITE_ML_API_URL is not configured');

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`),
    timeoutMs
  );

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Digital Twin API ${response.status}: ${message || response.statusText}`);
  }

  const parsed = await response.json();
  if (parsed?.error) throw new Error(parsed.error);
  return parsed;
}

async function postJson(path, payload, timeoutMs = 30000) {
  const baseUrl = normalizeBaseUrl(ML_API_BASE);
  if (!baseUrl) throw new Error('VITE_ML_API_URL is not configured');

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }),
    timeoutMs
  );

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Digital Twin API ${response.status}: ${message || response.statusText}`);
  }

  const parsed = await response.json();
  if (parsed?.error) throw new Error(parsed.error);
  return parsed;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function fetchScenarios() {
  return fetchJson('/scenarios');
}

export async function runSimulation({ scenario = 'normal', seed = 42, durationDays, chaosIntensity } = {}) {
  const payload = { scenario, seed };
  if (durationDays != null) payload.duration_days = durationDays;
  if (chaosIntensity) payload.chaos_intensity = chaosIntensity;
  return postJson('/run-simulation', payload);
}

export async function runOptimization({ scenario = 'normal', seed = 42, nTrials = 30, method = 'random', minFillRate = 0.95 } = {}) {
  return postJson('/optimize', {
    scenario,
    seed,
    n_trials: nTrials,
    method,
    min_fill_rate: minFillRate,
  }, 120000); // optimizer can take a while
}

export async function runComparison({ scenario = 'normal', seed = 42, strategies } = {}) {
  const payload = { scenario, seed };
  if (strategies) payload.strategies = strategies;
  return postJson('/simulation-comparison', payload, 120000);
}

/**
 * Phase 3 – P3.6: Simulation → Re-Optimization Feedback
 * Analyzes simulation results and derives constraint tightening inputs.
 */
export async function runReoptimization({ simResult, originalPlan, config } = {}) {
  return postJson('/simulation/reoptimize', {
    sim_result: simResult,
    original_plan: originalPlan || null,
    config: config || null,
  });
}

/**
 * Build a compact card payload for the chat DigitalTwinSimulationCard.
 */
export function buildDigitalTwinCardPayload(simResult) {
  const kpis = simResult?.kpis || {};
  const timeline = simResult?.timeline_sample || [];

  return {
    scenario: simResult?.scenario || 'unknown',
    kpis: {
      fill_rate_pct: kpis.fill_rate_pct ?? (kpis.fill_rate != null ? +(kpis.fill_rate * 100).toFixed(1) : null),
      total_cost: kpis.total_cost ?? null,
      avg_inventory: kpis.avg_inventory ?? null,
      inventory_turns: kpis.inventory_turns ?? null,
      stockout_days: kpis.stockout_days ?? null,
    },
    timeline_mini: timeline.slice(0, 52), // weekly samples for ~1 year
    elapsed_seconds: simResult?.elapsed_seconds ?? null,
  };
}
