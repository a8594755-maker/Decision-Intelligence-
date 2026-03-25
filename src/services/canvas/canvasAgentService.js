// canvasAgentService.js
// ─────────────────────────────────────────────────────────────────────────────
// Canvas Service for Insights Hub.
// Agent generates HTML dashboard — passes through directly.
// ─────────────────────────────────────────────────────────────────────────────

import { getResolvedInsightsHubModel } from '../ai-infra/modelConfigService.js';
import { buildEmptyLayout } from './canvasLayoutSchema.js';
import {
  getCachedSummary, setCachedSummary, clearCachedSummary,
} from '../agent-core/dashboardSummaryCache.js';
import { runInsightsAgent } from './insightsHubAgent.js';

const CACHE_KEY = 'di_canvas_layout';

function buildFingerprint(userId) {
  return userId || 'anon';
}

/**
 * Generate the Insights Hub dashboard.
 * Agent queries raw data and outputs HTML + suggestions.
 *
 * @returns {Promise<{ result: object, source: string }>}
 * result shape: { html?, title?, subtitle?, thinking?, suggestions?, blocks? }
 */
export async function generateCanvasLayout({ force = false, onProgress, userId, signal } = {}) {
  if (!userId) {
    return { result: null, source: 'empty' };
  }

  // Check cache
  if (!force) {
    const fingerprint = buildFingerprint(userId);
    const cached = getCachedSummary(CACHE_KEY, fingerprint);
    if (cached?.html || cached?.blocks) {
      return { result: cached, source: 'cache' };
    }
  }

  // Run agent
  try {
    const { provider, model } = getResolvedInsightsHubModel();
    if (signal?.aborted) throw new Error('Aborted');

    const agentResult = await runInsightsAgent({ provider, model, onProgress, userId, signal });

    if (agentResult?.html || agentResult?.blocks?.length) {
      const fingerprint = buildFingerprint(userId);
      setCachedSummary(CACHE_KEY, fingerprint, agentResult);
      return { result: agentResult, source: 'agent' };
    }
  } catch (err) {
    if (signal?.aborted) return { result: null, source: 'empty' };
    console.warn('[canvasAgent] Agent failed:', err?.message || err);
  }

  return { result: null, source: 'empty' };
}

export { clearCachedSummary, buildEmptyLayout };
