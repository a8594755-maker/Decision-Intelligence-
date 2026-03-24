// canvasAgentService.js
// ─────────────────────────────────────────────────────────────────────────────
// Agent-Driven Canvas Service for Insights Hub.
//
// Two-tier approach (same pattern as dashboardSummaryAgent):
//   Tier 1: Deterministic layout — always works, zero LLM cost
//   Tier 2: LLM-driven layout — agent decides what's important and where
//
// The agent receives analytics data and snapshot digests, then outputs a
// complete canvas layout JSON that the CanvasRenderer interprets.
// ─────────────────────────────────────────────────────────────────────────────

import { invokeAiProxy } from './aiProxyService.js';
import { getResolvedInsightsHubModel } from './modelConfigService.js';
import { buildDeterministicSummary } from './dashboardSummaryAgent.js';
import {
  buildMetricEvolution,
  buildActivityChart,
  buildTopicDistribution,
  buildTopFindings,
} from './insightsAnalyticsEngine.js';
import { validateLayout, buildEmptyLayout } from './canvasLayoutSchema.js';
import {
  getCachedSummary, setCachedSummary,
  buildSnapshotFingerprint,
} from './dashboardSummaryCache.js';

const CACHE_KEY = 'di_canvas_layout';

// ── Tier 1: Deterministic Layout ─────────────────────────────────────────────

/**
 * Build a sensible default layout from analytics engine outputs.
 * Zero LLM cost — guaranteed to work.
 */
export function buildDeterministicCanvas(snapshots) {
  if (!snapshots?.length) return buildEmptyLayout();

  const summary = buildDeterministicSummary(snapshots);
  const metricEvo = summary.metric_evolution || [];
  const activityChart = summary.activity_chart || [];
  const topicDist = summary.topic_distribution || [];
  const topFindings = summary.top_findings || [];

  const blocks = [];
  let nextId = 1;
  const id = () => `det_${nextId++}`;
  let currentRow = 1;

  // ── Row 1: KPI row (top metrics) ──
  if (metricEvo.length > 0) {
    const kpis = metricEvo.slice(0, 6).map((m) => {
      const last = m.points?.[m.points.length - 1];
      const prev = m.points?.[m.points.length - 2];
      const delta = (last && prev && prev.value) ? `${((last.value - prev.value) / prev.value * 100).toFixed(1)}%` : null;
      return {
        label: m.label || m.metric,
        value: last ? formatVal(last.value, m.unit) : '—',
        subtitle: delta ? `vs previous period` : undefined,
      };
    });
    blocks.push({ id: id(), type: 'kpi_row', col: 1, row: currentRow, colSpan: 12, rowSpan: 1, props: { kpis } });
    currentRow += 1;
  }

  // ── Row 2-3: Hero chart (activity) + topic donut ──
  if (activityChart.length > 0) {
    blocks.push({
      id: id(), type: 'chart', col: 1, row: currentRow, colSpan: 8, rowSpan: 2,
      props: { title: 'Analysis Activity (30 days)', chart: { type: 'area', data: activityChart, xKey: 'date', yKey: 'count' } },
    });
  }

  if (topicDist.length > 0) {
    blocks.push({
      id: id(), type: 'chart', col: 9, row: currentRow, colSpan: 4, rowSpan: 2,
      props: { title: 'Topic Distribution', chart: { type: 'pie', data: topicDist, xKey: 'name', yKey: 'value', label: 'name' } },
    });
  }

  if (activityChart.length > 0 || topicDist.length > 0) currentRow += 2;

  // ── Row 4: Metric sparklines as individual metric cards ──
  const topMetrics = metricEvo.slice(0, 4);
  topMetrics.forEach((m, i) => {
    const last = m.points?.[m.points.length - 1];
    const prev = m.points?.[m.points.length - 2];
    const deltaVal = (last && prev && prev.value) ? ((last.value - prev.value) / prev.value * 100) : null;
    blocks.push({
      id: id(), type: 'metric', col: 1 + i * 3, row: currentRow, colSpan: 3, rowSpan: 1,
      props: {
        label: m.label || m.metric,
        value: last ? formatVal(last.value, m.unit) : '—',
        delta: deltaVal != null ? `${deltaVal >= 0 ? '+' : ''}${deltaVal.toFixed(1)}%` : null,
        deltaDirection: deltaVal > 0 ? 'up' : deltaVal < 0 ? 'down' : 'stable',
        subtitle: 'vs previous period',
      },
    });
  });
  if (topMetrics.length > 0) currentRow += 1;

  // ── Row 5: Findings + blind spots/suggestions ──
  if (topFindings.length > 0) {
    blocks.push({
      id: id(), type: 'findings', col: 1, row: currentRow, colSpan: 6, rowSpan: 1,
      props: { title: 'Key Findings', findings: topFindings.slice(0, 6) },
    });
  }

  if (summary.blind_spots?.length > 0 || summary.suggested_questions?.length > 0) {
    const alerts = [];
    if (summary.blind_spots?.length) alerts.push(...summary.blind_spots.map((b) => `Blind spot: ${b}`));
    if (summary.suggested_questions?.length) alerts.push(...summary.suggested_questions.map((q) => `Suggested: ${q}`));
    blocks.push({
      id: id(), type: 'narrative', col: 7, row: currentRow, colSpan: 6, rowSpan: 1,
      props: { title: 'Suggestions & Blind Spots', text: alerts.join('\n\n') },
    });
  }

  if (topFindings.length > 0) currentRow += 1;

  // ── Row 6: Trends as horizontal bar ──
  if (summary.trends?.length > 0) {
    blocks.push({
      id: id(), type: 'horizontal_bar', col: 1, row: currentRow, colSpan: 6, rowSpan: 1,
      props: {
        title: 'Trending Topics',
        items: summary.trends.map((t) => ({
          label: t.title,
          value: parseInt(t.description?.match(/(\d+) reports/)?.[1]) || 1,
        })),
      },
    });
  }

  // ── Narrative summary ──
  blocks.push({
    id: id(), type: 'narrative',
    col: summary.trends?.length > 0 ? 7 : 1,
    row: currentRow,
    colSpan: summary.trends?.length > 0 ? 6 : 12,
    rowSpan: 1,
    props: { title: 'Executive Summary', text: summary.period_summary },
  });

  return {
    title: 'Insights Hub',
    subtitle: `Based on ${snapshots.length} analysis reports`,
    thinking: `Analyzed ${snapshots.length} reports. Found ${metricEvo.length} tracked metrics, ${topFindings.length} key findings, and ${topicDist.length} topic areas.`,
    blocks,
  };
}

function formatVal(value, unit) {
  if (value == null) return '—';
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === '$') {
    if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
    return `$${value.toFixed(0)}`;
  }
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ── Tier 2: LLM-Driven Layout ────────────────────────────────────────────────

const CANVAS_SYSTEM_PROMPT = `CRITICAL: You MUST return ONLY a valid JSON object. No prose, no markdown, no explanation before or after the JSON.

You are an AI analyst building a data analytics dashboard. You receive analysis report summaries and analytics data. Your job is to compose the most informative, visually compelling dashboard layout.

You output a canvas layout JSON that determines what content blocks to show and where to place them on a 12-column grid.

AVAILABLE BLOCK TYPES:
- "metric": Big KPI number card. Props: { label, value, delta, deltaDirection: "up"|"down"|"stable", subtitle }
- "chart": Any chart. Props: { title, chart: { type, data, xKey, yKey, series?, label? }, height? }
  Chart types: bar, line, area, pie, scatter, stacked_bar, grouped_bar, radar, treemap, waterfall, heatmap, composed
- "table": Data table. Props: { title, columns: string[], rows: (string[] | object)[], highlightHeader? }
- "narrative": Text block. Props: { title, text }
- "findings": Numbered findings list. Props: { title, findings: string[] }
- "alert": Alert/warning card. Props: { severity: "warning"|"error"|"info", title, description }
- "donut_group": Multiple mini donuts. Props: { title, donuts: [{ data: [{name,value}], label, centerValue }] }
- "horizontal_bar": Horizontal bars. Props: { title, items: [{ label, value }] }
- "kpi_row": Row of KPIs. Props: { kpis: [{ label, value, subtitle? }] }
- "progress": Progress bars. Props: { title, items: [{ label, percent, color? }] }

GRID RULES:
- 12 columns total. col is 1-indexed (1-12).
- colSpan: 1-12. col + colSpan - 1 must be <= 12.
- row is 1-indexed, rowSpan >= 1.
- Blocks must NOT overlap.
- Place most important content at the top (low row numbers).
- Use full width (colSpan: 12) for hero content.
- Use 3-col spans for metric cards (4 per row).
- Use 4-col or 6-col for medium charts.
- Use 8-col for wide charts + 4-col sidebar.

OUTPUT FORMAT:
{
  "title": "Dashboard title reflecting the data theme",
  "subtitle": "Brief context line",
  "thinking": "2-3 sentences explaining your analytical reasoning — what patterns you noticed and why you chose this layout",
  "blocks": [
    { "id": "blk_1", "type": "...", "col": 1, "row": 1, "colSpan": 12, "rowSpan": 1, "props": { ... } }
  ]
}

DESIGN PRINCIPLES:
- Dense, information-rich — like an executive analytics dashboard
- Lead with the most important KPIs and trends
- Mix chart types for visual variety (don't use all bars or all lines)
- Include at least one narrative/findings block for context
- Use alerts only for genuine contradictions or anomalies
- Keep text concise — data speaks louder than words
- Use the SAME LANGUAGE as the report headlines (if Chinese → Chinese, if English → English)
- Place 8-15 blocks total for a rich dashboard
- Create meaningful data for chart blocks based on the analytics data provided`;

/**
 * Build an LLM-driven canvas layout.
 * Returns layout JSON or null if LLM fails.
 */
async function tryLLMCanvas(snapshots) {
  // Build context for the LLM
  const summary = buildDeterministicSummary(snapshots);
  const metricEvo = summary.metric_evolution || [];
  const activityChart = summary.activity_chart || [];
  const topicDist = summary.topic_distribution || [];
  const topFindings = summary.top_findings || [];

  const digest = snapshots.slice(0, 30).map((s) => ({
    id: s.id,
    date: s.created_at?.slice(0, 10),
    headline: s.headline,
    summary: s.summary?.slice(0, 200),
    pills: (s.metric_pills || []).map((p) => `${p.label}: ${p.value}`).join(', '),
    tags: (s.tags || []).join(', '),
    findings: (s.key_findings || []).slice(0, 3),
  }));

  const metricsContext = metricEvo.slice(0, 8).map((m) => ({
    metric: m.label || m.metric,
    unit: m.unit,
    points: m.points?.slice(-5),
    delta_pct: m.delta_pct,
  }));

  const userPrompt = `Here is the data to build a dashboard from:

REPORT DIGESTS (${digest.length} reports):
${JSON.stringify(digest, null, 1)}

METRIC EVOLUTION (tracked metrics over time):
${JSON.stringify(metricsContext, null, 1)}

ACTIVITY CHART (reports per day, last 30 days):
${JSON.stringify(activityChart.slice(-15), null, 1)}

TOPIC DISTRIBUTION:
${JSON.stringify(topicDist, null, 1)}

KEY FINDINGS:
${JSON.stringify(topFindings.slice(0, 10), null, 1)}

PERIOD SUMMARY: ${summary.period_summary}
TRENDS: ${JSON.stringify(summary.trends)}
BLIND SPOTS: ${JSON.stringify(summary.blind_spots)}
SUGGESTED QUESTIONS: ${JSON.stringify(summary.suggested_questions)}

Build the most informative and visually compelling dashboard layout from this data.`;

  const { provider, model } = getResolvedInsightsHubModel();
  const result = await invokeAiProxy('di_prompt', {
    provider,
    systemInstruction: CANVAS_SYSTEM_PROMPT,
    prompt: userPrompt,
    model,
    temperature: 0.4,
    maxOutputTokens: 4096,
    ...(provider === 'gemini' ? { responseMimeType: 'application/json' } : {}),
    ...(provider === 'openai' || provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
  });

  const text = result?.text || '';

  // JSON extraction (same robust pattern as dashboardSummaryAgent)
  try { return JSON.parse(text); } catch { /* not pure JSON */ }

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* malformed */ }
  }

  const jsonMatch = text.match(/\{[\s\S]*"blocks"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* malformed */ }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* still malformed */ }
  }

  console.warn('[canvasAgent] LLM returned non-JSON text, falling back to deterministic');
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a canvas layout for the Insights Hub.
 * Always returns a valid layout — deterministic fallback guarantees non-null.
 *
 * @param {object[]} snapshots - analysis_snapshots rows
 * @param {{ force?: boolean }} options
 * @returns {Promise<{ layout: object, source: string }>}
 */
export async function generateCanvasLayout(snapshots, { force = false } = {}) {
  // Empty state
  if (!snapshots?.length) {
    return { layout: buildEmptyLayout(), source: 'empty' };
  }

  // Check cache
  if (!force) {
    const fingerprint = buildSnapshotFingerprint(snapshots);
    const cached = getCachedSummary(CACHE_KEY, fingerprint);
    if (cached?.blocks) {
      return { layout: cached, source: 'cache' };
    }
  }

  // Tier 1: deterministic (instant fallback)
  const deterministicLayout = buildDeterministicCanvas(snapshots);

  // Tier 2: try LLM
  try {
    const llmLayout = await tryLLMCanvas(snapshots);
    if (llmLayout?.blocks?.length) {
      const { layout } = validateLayout(llmLayout);
      if (layout.blocks.length > 0) {
        const finalLayout = {
          ...layout,
          title: llmLayout.title || deterministicLayout.title,
          subtitle: llmLayout.subtitle || deterministicLayout.subtitle,
          thinking: llmLayout.thinking || '',
        };
        // Cache it
        const fingerprint = buildSnapshotFingerprint(snapshots);
        setCachedSummary(CACHE_KEY, fingerprint, finalLayout);
        return { layout: finalLayout, source: 'llm' };
      }
    }
  } catch (err) {
    console.warn('[canvasAgent] LLM canvas generation failed, using deterministic:', err?.message || err);
  }

  // Fallback: use deterministic
  const fingerprint = buildSnapshotFingerprint(snapshots);
  setCachedSummary(CACHE_KEY, fingerprint, deterministicLayout);
  return { layout: deterministicLayout, source: 'deterministic' };
}
