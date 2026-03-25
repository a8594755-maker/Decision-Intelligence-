// dashboardSummaryAgent.js
// ─────────────────────────────────────────────────────────────────────────────
// AI Analyst for the Insights Hub dashboard.
//
// Two-tier approach:
//   1. Deterministic analysis (always works, zero LLM cost)
//   2. LLM-enhanced synthesis (richer insights when available)
//
// Surfaces actual business data from analysis snapshots — real KPIs, charts,
// findings, and tables — not meta-data about analysis activity.
// ─────────────────────────────────────────────────────────────────────────────

import { invokeAiProxy } from '../ai-infra/aiProxyService.js';
import { getResolvedInsightsHubModel } from '../ai-infra/modelConfigService.js';
import {
  buildMetricEvolution,
  buildTopFindings,
  extractLatestKpis,
  extractTopCharts,
  extractTopTables,
  buildInsightsSummary,
} from '../forecast/insightsAnalyticsEngine.js';

// ── Deterministic analysis (Tier 1 — always available) ──────────────────────

/**
 * Build a dashboard summary from snapshots using pure code — no LLM needed.
 * Always returns a valid summary object.
 */
export function buildDeterministicSummary(snapshots) {
  if (!snapshots?.length) {
    return {
      period_summary: 'No analysis reports yet. Run analyses in the Workspace to start building insights.',
      trends: [],
      contradictions: [],
      blind_spots: [],
      suggested_questions: [],
      layout_hints: [],
      latest_kpis: [],
      top_charts: [],
      top_tables: [],
      insights_summary: { findings: [], implications: [], caveats: [], nextSteps: [] },
      metric_evolution: [],
      top_findings: [],
      source: 'empty',
    };
  }

  // ── Extract actual business data ──
  const latestKpis = extractLatestKpis(snapshots, 8);
  const topCharts = extractTopCharts(snapshots, 6);
  const topTables = extractTopTables(snapshots, 3);
  const insightsSummary = buildInsightsSummary(snapshots);
  const metricEvolution = buildMetricEvolution(snapshots);
  const topFindings = buildTopFindings(snapshots);

  // ── Tag frequency analysis (for trends/blind spots) ──
  const tagCounts = {};
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const recentSnapshots = [];
  const olderSnapshots = [];

  for (const s of snapshots) {
    const age = now - new Date(s.created_at).getTime();
    if (age < weekMs) recentSnapshots.push(s);
    else olderSnapshots.push(s);

    for (const tag of (s.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  // ── Trend detection ──
  const trends = [];
  const recentTags = {};
  const olderTags = {};
  recentSnapshots.forEach(s => (s.tags || []).forEach(t => { recentTags[t] = (recentTags[t] || 0) + 1; }));
  olderSnapshots.forEach(s => (s.tags || []).forEach(t => { olderTags[t] = (olderTags[t] || 0) + 1; }));

  for (const [tag, recentCount] of Object.entries(recentTags)) {
    const olderCount = olderTags[tag] || 0;
    if (recentCount >= 2 && recentCount > olderCount) {
      trends.push({
        title: tag.charAt(0).toUpperCase() + tag.slice(1),
        description: `${recentCount} reports this week (up from ${olderCount} prior)`,
        evidence: recentSnapshots.filter(s => (s.tags || []).includes(tag)).map(s => s.headline).slice(0, 2),
        direction: 'up',
      });
    } else if (olderCount >= 2 && olderCount > recentCount * 2) {
      trends.push({
        title: tag.charAt(0).toUpperCase() + tag.slice(1),
        description: `Declining attention: ${recentCount} recent vs ${olderCount} earlier`,
        evidence: [],
        direction: 'down',
      });
    }
  }

  // ── Blind spots ──
  const allPossibleTags = ['revenue', 'cost', 'customer', 'inventory', 'forecast', 'trend', 'comparison', 'anomaly', 'supplier', 'churn'];
  const coveredTags = new Set(Object.keys(tagCounts));
  const blindSpots = allPossibleTags
    .filter(t => !coveredTags.has(t))
    .map(t => `No ${t} analysis found — consider exploring this area`);

  // ── Suggested questions ──
  const suggestedQuestions = [];
  if (tagCounts.revenue && !tagCounts.cost) suggestedQuestions.push('How do costs compare to revenue trends?');
  if (tagCounts.customer && !tagCounts.churn) suggestedQuestions.push('What does the customer churn rate look like?');
  if (tagCounts.forecast && !tagCounts.anomaly) suggestedQuestions.push('Are there anomalies in the forecast data?');
  if (tagCounts.inventory && !tagCounts.supplier) suggestedQuestions.push('How do supplier lead times affect inventory?');
  if (suggestedQuestions.length === 0) suggestedQuestions.push('What are the top 3 risks in the current data?');

  // ── Period summary — describe actual data, not meta-data ──
  const kpiSummary = latestKpis.slice(0, 3).map(k => `${k.label}: ${k.value}`).join(', ');
  const periodSummary = kpiSummary
    ? `Key metrics: ${kpiSummary}. ${topCharts.length} charts and ${insightsSummary.findings.length} findings from ${snapshots.length} analyses.`
    : `${snapshots.length} analyses with ${insightsSummary.findings.length} key findings.`;

  return {
    period_summary: periodSummary,
    trends: trends.slice(0, 5),
    contradictions: [],
    blind_spots: blindSpots.slice(0, 3),
    suggested_questions: suggestedQuestions.slice(0, 3),
    layout_hints: [],
    // Actual business data
    latest_kpis: latestKpis,
    top_charts: topCharts,
    top_tables: topTables,
    insights_summary: insightsSummary,
    metric_evolution: metricEvolution,
    top_findings: topFindings,
    source: 'deterministic',
  };
}

// ── LLM-enhanced analysis (Tier 2 — optional enrichment) ────────────────────

const SUMMARY_SYSTEM_PROMPT = `CRITICAL: You MUST return ONLY a valid JSON object. No prose, no markdown, no explanation before or after the JSON. Your entire response must start with "{" and end with "}".

You are a business intelligence analyst reviewing actual analysis results — real KPIs, real findings, and real data from past analyses.
Your job is to identify patterns, trends, contradictions, and actionable insights ACROSS the reports.

OUTPUT FORMAT (JSON ONLY — no other content):
{
  "period_summary": "One sentence summarizing the key business insights from these analyses",
  "trends": [
    { "title": "Trend title", "description": "Description with actual data/numbers", "evidence": ["Report A headline", "Report B headline"], "direction": "up|down|stable|mixed" }
  ],
  "contradictions": [
    { "report_a": "headline A", "report_b": "headline B", "description": "Description of the conflict" }
  ],
  "blind_spots": ["Areas not yet analyzed but potentially important"],
  "suggested_questions": ["Specific, actionable follow-up questions based on the data"]
}

RULES:
- Use the same language as the majority of report headlines.
- Reference actual metric values and findings from the data provided.
- trends: max 5, based on actual metric changes, not report counts.
- contradictions: only flag genuine data conflicts.
- suggested_questions: max 3, specific and data-driven.`;

/**
 * Try to enhance the summary with LLM analysis.
 * Returns enhanced summary or null if LLM is unavailable.
 */
async function tryLLMSummary(snapshots) {
  const latestKpis = extractLatestKpis(snapshots, 8);
  const insights = buildInsightsSummary(snapshots);
  const metricEvo = buildMetricEvolution(snapshots);

  const digest = snapshots.slice(0, 20).map((s) => ({
    date: s.created_at?.slice(0, 10),
    headline: s.headline,
    summary: s.summary?.slice(0, 200),
    pills: (s.metric_pills || []).map(p => `${p.label}: ${p.value}`).join(', '),
    findings: (s.key_findings || []).slice(0, 3),
  }));

  const userPrompt = `Here are the analysis reports with their actual data:

REPORT DIGESTS (${digest.length} reports):
${JSON.stringify(digest, null, 1)}

ACTUAL KPIs:
${JSON.stringify(latestKpis.map(k => ({ label: k.label, value: k.value, date: k.date })), null, 1)}

METRIC EVOLUTION:
${JSON.stringify(metricEvo.slice(0, 6).map(m => ({ metric: m.label, latest: m.latest, delta_pct: m.delta, unit: m.unit })), null, 1)}

KEY FINDINGS:
${JSON.stringify(insights.findings.slice(0, 10), null, 1)}

IMPLICATIONS: ${JSON.stringify(insights.implications.slice(0, 5))}

Synthesize cross-report insights from this data.`;

  const { provider, model } = getResolvedInsightsHubModel();
  const result = await invokeAiProxy('di_prompt', {
    provider,
    systemInstruction: SUMMARY_SYSTEM_PROMPT,
    prompt: userPrompt,
    model,
    temperature: 0.3,
    maxOutputTokens: 1024,
    ...(provider === 'gemini' ? { responseMimeType: 'application/json' } : {}),
    ...(provider === 'openai' || provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
  });

  const text = result?.text || '';

  try { return JSON.parse(text); } catch { /* not pure JSON */ }

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* malformed fenced JSON */ }
  }

  const jsonMatch = text.match(/\{[\s\S]*"period_summary"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* malformed JSON block */ }
  }

  const jsonStartIdx = text.indexOf('{');
  const jsonEndIdx = text.lastIndexOf('}');
  if (jsonStartIdx >= 0 && jsonEndIdx > jsonStartIdx) {
    try { return JSON.parse(text.slice(jsonStartIdx, jsonEndIdx + 1)); } catch { /* still malformed */ }
  }

  console.warn('[dashboardSummary] LLM returned non-JSON text, falling back to deterministic');
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a dashboard summary.
 * Always returns a result — deterministic fallback guarantees non-null.
 *
 * @param {object[]} snapshots - analysis_snapshots rows
 * @returns {Promise<object>} Summary object (never null)
 */
export async function generateDashboardSummary(snapshots) {
  // Tier 1: deterministic (instant, always works)
  const deterministicSummary = buildDeterministicSummary(snapshots);

  if (!snapshots?.length) return deterministicSummary;

  // Tier 2: try LLM enhancement
  try {
    const llmSummary = await tryLLMSummary(snapshots);
    if (llmSummary?.period_summary) {
      return {
        ...deterministicSummary,
        ...llmSummary,
        // Keep actual data from deterministic (LLM only enhances text fields)
        latest_kpis: deterministicSummary.latest_kpis,
        top_charts: deterministicSummary.top_charts,
        top_tables: deterministicSummary.top_tables,
        insights_summary: deterministicSummary.insights_summary,
        metric_evolution: deterministicSummary.metric_evolution,
        top_findings: deterministicSummary.top_findings,
        source: 'llm',
      };
    }
  } catch (err) {
    console.warn('[dashboardSummary] LLM enhancement failed, using deterministic:', err?.message || err);
  }

  // Fallback to deterministic
  return deterministicSummary;
}
