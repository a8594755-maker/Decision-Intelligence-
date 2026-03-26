// canvasAgentService.js
// ─────────────────────────────────────────────────────────────────────────────
// Canvas Service for Insights Hub.
// 1. Main agent (DeepSeek Reasoner) generates HTML dashboard
// 2. Reviewer agent (Kimi K2.5) verifies data accuracy
// 3. If errors found → auto-correct or flag warnings
// ─────────────────────────────────────────────────────────────────────────────

import { getResolvedInsightsHubModel } from '../ai-infra/modelConfigService.js';
import { buildEmptyLayout } from './canvasLayoutSchema.js';
import {
  getCachedSummary, setCachedSummary, clearCachedSummary, saveDashboardVersion,
} from '../agent-core/dashboardSummaryCache.js';
import { runInsightsAgent, runReviewerAgent } from './insightsHubAgent.js';

const CACHE_KEY = 'di_canvas_layout';

function buildFingerprint(userId) {
  return userId || 'anon';
}

/**
 * Generate the Insights Hub dashboard.
 * Agent generates → Reviewer verifies → corrections applied.
 *
 * @returns {Promise<{ result: object, source: string }>}
 */
export async function generateCanvasLayout({ force = false, onProgress, userId, signal } = {}) {
  if (!userId) {
    return { result: null, source: 'empty' };
  }

  // Check cache
  if (!force) {
    const fingerprint = buildFingerprint(userId);
    const cached = getCachedSummary(CACHE_KEY, fingerprint);
    if (cached?.html || cached?.dataCards?.length || cached?.blocks) {
      return { result: cached, source: 'cache' };
    }
  }

  // Step 1: Run main agent
  let agentResult;
  try {
    const { provider, model } = getResolvedInsightsHubModel();
    if (signal?.aborted) throw new Error('Aborted');

    agentResult = await runInsightsAgent({ provider, model, onProgress, userId, signal });

    if (!agentResult?.dataCards?.length && !agentResult?.html && !agentResult?.blocks?.length) {
      return { result: null, source: 'empty' };
    }
  } catch (err) {
    if (signal?.aborted) return { result: null, source: 'empty' };
    console.warn('[canvasAgent] Agent failed:', err?.message || err);
    return { result: null, source: 'empty' };
  }

  // Step 2: Run reviewer agent (Kimi K2.5 — fast and cheap)
  if (agentResult?.html && !signal?.aborted) {
    try {
      onProgress?.('Verifying data accuracy...');
      const review = await runReviewerAgent(agentResult.html, {
        provider: 'kimi',
        model: 'kimi-k2.5',
        onProgress,
        signal,
      });

      if (review) {
        agentResult.review = review;

        // Inject verification badge into HTML
        const badge = buildVerificationBadge(review);
        if (badge && agentResult.html) {
          // Insert before closing </body> tag
          agentResult.html = agentResult.html.replace(
            '</body>',
            `${badge}</body>`,
          );
        }

        const corrCount = review.corrections?.length || 0;
        const warnCount = review.warnings?.length || 0;
        const passCount = review.passed?.length || 0;
        console.info(`[canvasAgent] Review: ${passCount} passed, ${corrCount} corrections, ${warnCount} warnings`);
      }
    } catch (err) {
      console.warn('[canvasAgent] Reviewer failed (non-fatal):', err?.message || err);
      // Reviewer failure is non-fatal — dashboard still shows
    }
  }

  // Cache and return — slim down dataCards to fit localStorage (~5MB limit)
  const fingerprint = buildFingerprint(userId);
  const slimResult = {
    ...agentResult,
    dataCards: (agentResult.dataCards || []).map(c => ({
      id: c.id, title: c.title, type: c.type,
      metrics: c.metrics, analysis: c.analysis,
      chartData: c.chartData, tableData: c.tableData,
      // Drop _rawHtml and any large intermediate fields
    })),
  };
  try {
    setCachedSummary(CACHE_KEY, fingerprint, slimResult);
    console.info(`[canvasAgent] Cached: ${slimResult.dataCards?.length || 0} dataCards, fingerprint=${fingerprint}`);
  } catch (e) {
    console.warn(`[canvasAgent] Cache save failed: ${e.message}`);
  }
  saveDashboardVersion(slimResult);
  return { result: slimResult, source: 'agent' };
}

/**
 * Build an HTML badge showing verification results.
 * Injected at the bottom of the dashboard HTML.
 */
function buildVerificationBadge(review) {
  if (!review) return '';

  const corrections = review.corrections || [];
  const warnings = review.warnings || [];
  const passed = review.passed || [];

  if (!corrections.length && !warnings.length && !passed.length) return '';

  const parts = [];

  parts.push('<div style="margin:32px auto;max-width:1400px;padding:0 24px;">');
  parts.push('<div style="border:1px solid #e2e8f0;border-radius:12px;padding:20px;background:#fff;">');
  parts.push('<h3 style="margin:0 0 12px;font:600 16px system-ui;color:#334155;">Data Verification Report</h3>');

  // Corrections (red)
  if (corrections.length > 0) {
    parts.push('<div style="margin-bottom:12px;">');
    parts.push('<div style="font:600 13px system-ui;color:#dc2626;margin-bottom:6px;">Corrections Found:</div>');
    for (const c of corrections) {
      parts.push(`<div style="font:12px system-ui;color:#64748b;padding:4px 0;border-bottom:1px solid #f1f5f9;">`);
      parts.push(`<span style="color:#dc2626;">✗</span> <b>${c.metric}</b>: Dashboard shows ${c.dashboardValue}, actual is <b style="color:#16a34a;">${c.actualValue}</b>`);
      if (c.fix) parts.push(` — ${c.fix}`);
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  // Warnings (amber)
  if (warnings.length > 0) {
    parts.push('<div style="margin-bottom:12px;">');
    parts.push('<div style="font:600 13px system-ui;color:#d97706;margin-bottom:6px;">Warnings:</div>');
    for (const w of warnings) {
      parts.push(`<div style="font:12px system-ui;color:#64748b;padding:4px 0;">`);
      parts.push(`<span style="color:#d97706;">⚠</span> <b>${w.metric}</b>: ${w.issue}`);
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  // Passed (green)
  if (passed.length > 0) {
    parts.push('<div>');
    parts.push('<div style="font:600 13px system-ui;color:#16a34a;margin-bottom:6px;">Verified Correct:</div>');
    parts.push(`<div style="font:12px system-ui;color:#64748b;">${passed.join(' · ')}</div>`);
    parts.push('</div>');
  }

  parts.push('</div></div>');
  return parts.join('');
}

export { clearCachedSummary, buildEmptyLayout };
