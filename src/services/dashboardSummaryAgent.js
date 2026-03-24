// dashboardSummaryAgent.js
// ─────────────────────────────────────────────────────────────────────────────
// AI Analyst for the Insights Hub dashboard.
//
// Two-tier approach:
//   1. Deterministic analysis (always works, zero LLM cost)
//   2. LLM-enhanced synthesis (richer insights when available)
//
// The deterministic tier ensures the dashboard is never empty/broken even when
// the LLM call fails or is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

import { invokeAiProxy } from './aiProxyService.js';
import { getResolvedInsightsHubModel } from './modelConfigService.js';
import {
  buildMetricEvolution,
  buildActivityChart,
  buildTopicDistribution,
  buildTopFindings,
} from './insightsAnalyticsEngine.js';

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
      source: 'empty',
    };
  }

  // ── Tag frequency analysis ──
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

  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  const topTag = sortedTags[0];

  // ── Trend detection: compare recent vs older tag frequencies ──
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

  // ── Stable trends (consistently high) ──
  for (const [tag, count] of sortedTags.slice(0, 3)) {
    if (count >= 3 && !trends.find(t => t.title.toLowerCase() === tag)) {
      trends.push({
        title: tag.charAt(0).toUpperCase() + tag.slice(1),
        description: `Appears in ${count} of ${snapshots.length} reports — consistent focus area`,
        evidence: snapshots.filter(s => (s.tags || []).includes(tag)).map(s => s.headline).slice(0, 2),
        direction: 'stable',
      });
    }
  }

  // ── Blind spots: common analysis topics NOT covered ──
  const allPossibleTags = ['revenue', 'cost', 'customer', 'inventory', 'forecast', 'trend', 'comparison', 'anomaly', 'supplier', 'churn'];
  const coveredTags = new Set(Object.keys(tagCounts));
  const blindSpots = allPossibleTags
    .filter(t => !coveredTags.has(t))
    .map(t => `No ${t} analysis found — consider exploring this area`);

  // ── Suggested questions based on what's been analyzed ──
  const suggestedQuestions = [];
  if (tagCounts.revenue && !tagCounts.cost) suggestedQuestions.push('How do costs compare to revenue trends?');
  if (tagCounts.customer && !tagCounts.churn) suggestedQuestions.push('What does the customer churn rate look like?');
  if (tagCounts.forecast && !tagCounts.anomaly) suggestedQuestions.push('Are there anomalies in the forecast data?');
  if (tagCounts.inventory && !tagCounts.supplier) suggestedQuestions.push('How do supplier lead times affect inventory?');
  if (snapshots.length >= 5 && !tagCounts.comparison) suggestedQuestions.push('Compare this week vs last week performance');
  if (suggestedQuestions.length === 0) suggestedQuestions.push('What are the top 3 risks in the current data?');

  // ── Layout hints: highlight most impactful snapshots ──
  const layoutHints = snapshots.slice(0, 6).map((s, i) => ({
    snapshot_id: s.id,
    position: i === 0 ? 'hero' : i <= 2 ? 'top' : 'bottom',
    reason: i === 0 ? 'Most recent analysis' : `Report #${i + 1}`,
  }));

  // ── Period summary ──
  const periodSummary = topTag
    ? `${snapshots.length} reports analyzed. Primary focus: ${topTag[0]} (${topTag[1]} reports). ${recentSnapshots.length} new this week.`
    : `${snapshots.length} reports analyzed. ${recentSnapshots.length} new this week.`;

  return {
    period_summary: periodSummary,
    trends: trends.slice(0, 5),
    contradictions: [],
    blind_spots: blindSpots.slice(0, 3),
    suggested_questions: suggestedQuestions.slice(0, 3),
    layout_hints: layoutHints,
    // Chart-ready data from analytics engine
    metric_evolution: buildMetricEvolution(snapshots),
    activity_chart: buildActivityChart(snapshots),
    topic_distribution: buildTopicDistribution(snapshots),
    top_findings: buildTopFindings(snapshots),
    source: 'deterministic',
  };
}

// ── LLM-enhanced analysis (Tier 2 — optional enrichment) ────────────────────

const SUMMARY_SYSTEM_PROMPT = `CRITICAL: You MUST return ONLY a valid JSON object. No prose, no markdown, no explanation before or after the JSON. Your entire response must start with "{" and end with "}".

You are a business intelligence analyst reviewing a set of past analysis reports.
Your job is to identify patterns, trends, contradictions, and actionable insights across reports.

OUTPUT FORMAT (JSON ONLY — no other content):
{
  "period_summary": "One sentence summarizing this period's analysis focus",
  "trends": [
    { "title": "Trend title", "description": "Description", "evidence": ["Report A headline", "Report B headline"], "direction": "up|down|stable|mixed" }
  ],
  "contradictions": [
    { "report_a": "headline A", "report_b": "headline B", "description": "Description of the conflict" }
  ],
  "blind_spots": ["Areas not yet analyzed but potentially important"],
  "suggested_questions": ["Specific, actionable follow-up questions"],
  "layout_hints": [
    { "snapshot_id": "uuid", "position": "hero|top-left|top-right|bottom", "reason": "Why this placement" }
  ]
}

RULES:
- Use the same language as the majority of report headlines.
- Keep each field concise (1-2 sentences max).
- trends: max 5, sorted by importance.
- contradictions: only flag genuine conflicts, not minor variations.
- suggested_questions: max 3, specific and actionable.
- layout_hints: pick the top 4-6 most important snapshots for dashboard highlight.`;

/**
 * Try to enhance the summary with LLM analysis.
 * Returns enhanced summary or null if LLM is unavailable.
 */
async function tryLLMSummary(snapshots) {
  const digest = snapshots.map((s, i) => ({
    index: i,
    id: s.id,
    date: s.created_at?.slice(0, 10),
    headline: s.headline,
    pills: (s.metric_pills || []).map(p => `${p.label}: ${p.value}`).join(', '),
    tags: (s.tags || []).join(', '),
    findings_count: (s.key_findings || []).length,
    chart_types: (s.chart_specs || []).map(c => c.type).join(', '),
  }));

  const { provider, model } = getResolvedInsightsHubModel();
  const userPrompt = `Here are the analysis reports to synthesize:\n\n${JSON.stringify(digest)}`;
  const result = await invokeAiProxy('di_prompt', {
    provider,
    systemInstruction: SUMMARY_SYSTEM_PROMPT,
    prompt: userPrompt,
    model,
    temperature: 0.3,
    maxOutputTokens: 1024,
    // Request JSON mode from providers that support it
    ...(provider === 'gemini' ? { responseMimeType: 'application/json' } : {}),
    ...(provider === 'openai' || provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
  });

  const text = result?.text || '';

  // Try direct JSON parse first
  try { return JSON.parse(text); } catch { /* not pure JSON */ }

  // Fallback: extract JSON from markdown code fences (```json ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* malformed fenced JSON */ }
  }

  // Fallback: extract JSON block from mixed text (LLM sometimes wraps JSON in prose)
  const jsonMatch = text.match(/\{[\s\S]*"period_summary"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* malformed JSON block */ }
  }

  // Fallback: strip leading prose before JSON object
  const jsonStartIdx = text.indexOf('{');
  const jsonEndIdx = text.lastIndexOf('}');
  if (jsonStartIdx >= 0 && jsonEndIdx > jsonStartIdx) {
    try { return JSON.parse(text.slice(jsonStartIdx, jsonEndIdx + 1)); } catch { /* still malformed */ }
  }

  // Last resort: couldn't parse — return null so deterministic fallback kicks in
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
      return { ...llmSummary, source: 'llm' };
    }
  } catch (err) {
    console.warn('[dashboardSummary] LLM enhancement failed, using deterministic:', err?.message || err);
  }

  // Fallback to deterministic
  return deterministicSummary;
}
