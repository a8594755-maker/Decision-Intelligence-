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
import { getCached, setCached } from '../storage/indexedDbCache.js';
import { runInsightsAgent, runReviewerAgent, extractDashboardMetrics } from './insightsHubAgent.js';
import { runHealthCheck, hashDiagnostics } from '../insights/insightsDataScanner.js';

const CACHE_KEY = 'di_canvas_layout';

function buildFingerprint(userId, hcFingerprint) {
  return hcFingerprint ? `${userId || 'anon'}-${hcFingerprint}` : (userId || 'anon');
}

/**
 * Generate the Insights Hub dashboard.
 * Pipeline: Health Check → Agent Dashboard → Reviewer Audit.
 *
 * @returns {Promise<{ result: object, source: string }>}
 */
export async function generateCanvasLayout({ force = false, onProgress, userId, signal } = {}) {
  if (!userId) {
    return { result: null, source: 'empty' };
  }

  const { provider, model } = getResolvedInsightsHubModel();

  // ── Step 1-2: Health check (LLM writes SQL + deterministic analysis) ──
  let healthCheck = null;
  try {
    onProgress?.('Running health check...');
    healthCheck = await runHealthCheck({ model, provider });
    const diagCount = healthCheck?.diagnostics?.length || 0;
    if (diagCount > 0) {
      console.info(`[canvasAgent] Health check: ${diagCount} diagnostics in ${healthCheck.duration_ms}ms`);
    }
  } catch (err) {
    console.warn('[canvasAgent] Health check failed (non-fatal):', err?.message);
  }

  // ── Cache check — keyed by health check fingerprint ──
  const hcFp = healthCheck?.fingerprint || '';
  if (!force) {
    const fingerprint = buildFingerprint(userId, hcFp);
    const idbCached = await getCached(CACHE_KEY, fingerprint);
    if (idbCached?.dataCards?.length || idbCached?.html) {
      if (healthCheck) idbCached.healthCheck = healthCheck;
      return { result: idbCached, source: 'cache' };
    }
    const lsCached = getCachedSummary(CACHE_KEY, fingerprint);
    if (lsCached?.html || lsCached?.dataCards?.length || lsCached?.blocks) {
      if (healthCheck) lsCached.healthCheck = healthCheck;
      return { result: lsCached, source: 'cache' };
    }
  }

  // ── Steps 3-5: Agent builds dashboard (LLM #1 — planner sees health check) ──
  let agentResult;
  try {
    if (signal?.aborted) throw new Error('Aborted');

    agentResult = await runInsightsAgent({
      provider,
      model,
      onProgress,
      userId,
      signal,
      healthCheck,
    });

    if (!agentResult?.dataCards?.length && !agentResult?.html && !agentResult?.blocks?.length) {
      return { result: null, source: 'empty' };
    }
  } catch (err) {
    if (signal?.aborted) return { result: null, source: 'empty' };
    console.warn('[canvasAgent] Agent failed:', err?.message || err);
    return { result: null, source: 'empty' };
  }

  // Attach health check to result (for UI display)
  if (healthCheck) {
    agentResult.healthCheck = healthCheck;
  }

  // ── Step 6: Audit — reviewer verifies against ground truth (LLM #2) ──
  if (!signal?.aborted) {
    try {
      onProgress?.('Verifying data accuracy...');

      // Build ground truth from health check diagnostics
      const groundTruthBlock = healthCheck?.diagnostics?.length
        ? '\n\n## Ground Truth (from health check)\n' +
          healthCheck.diagnostics.map(d => {
            const a = d.analysis || {};
            const val = a.z_score != null ? `Z=${a.z_score}, latest=${a.latest}, mean=${a.mean}`
              : a.top3_share != null ? `${a.top3_share}%`
                : a.value != null ? `${a.value}` : JSON.stringify(a);
            return `- ${d.title}: ${val} [${a.severity}]`;
          }).join('\n')
        : '';

      // Build dashboard claims
      const dashMetrics = typeof extractDashboardMetrics === 'function'
        ? extractDashboardMetrics(agentResult.dataCards) : [];
      const dashboardBlock = dashMetrics.length
        ? '\n\n## Dashboard Claims\n' +
          dashMetrics.map(m => `- Card "${m.cardTitle}": ${m.name} = ${m.value}${m.unit ? ' ' + m.unit : ''}`).join('\n')
        : '';
      const narrativeBlock = agentResult.layout?.narrative
        ? `\n\n## Dashboard Narrative\n${agentResult.layout.narrative}`
        : '';

      const reviewContent = (dashboardBlock + groundTruthBlock + narrativeBlock).trim();

      const review = await runReviewerAgent(reviewContent, {
        provider: 'kimi',
        model: 'kimi-k2.5',
        onProgress,
        signal,
      });

      if (review) {
        agentResult.review = review;
        if (agentResult.html) {
          const badge = buildVerificationBadge(review);
          if (badge) agentResult.html = agentResult.html.replace('</body>', `${badge}</body>`);
        }
        const corrCount = review.corrections?.length || 0;
        const warnCount = review.warnings?.length || 0;
        const passCount = review.passed?.length || 0;
        console.info(`[canvasAgent] Review: ${passCount} passed, ${corrCount} corrections, ${warnCount} warnings`);
      }
    } catch (err) {
      console.warn('[canvasAgent] Reviewer failed (non-fatal):', err?.message || err);
    }
  }

  // ── Cache (keyed by health check fingerprint) ──
  const fingerprint = buildFingerprint(userId, hcFp);
  await setCached(CACHE_KEY, agentResult, fingerprint);
  saveDashboardVersion(agentResult);
  return { result: agentResult, source: 'agent' };
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
