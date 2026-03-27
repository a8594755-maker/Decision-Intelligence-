// signalRadarEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic signal detection engine for the Signal Radar.
// Scans analysis snapshots for anomalies, contradictions, concentration risks,
// and stale insights. Zero LLM cost — all rule-based.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildMetricEvolution,
  parseMetricValue,
  normalizeMetricLabel,
} from '../forecast/insightsAnalyticsEngine.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function severityRank(s) { return SEVERITY_RANK[s] || 0; }

/** Simple deterministic ID for dedup. */
function signalId(type, key) {
  return `${type}:${key}`;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ── Detector 1: Metric Anomalies ─────────────────────────────────────────────

/**
 * Detect metrics with abnormal recent changes.
 * Flags if latest delta is >2σ from historical mean delta, or if absolute change >30%.
 */
export function detectMetricAnomalies(snapshots) {
  const evolution = buildMetricEvolution(snapshots);
  const signals = [];

  for (const metric of evolution) {
    const { label, points, delta, latest, unit } = metric;
    if (points.length < 3 || delta == null) continue;

    // Compute historical deltas between consecutive points
    const deltas = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].value;
      if (prev !== 0) {
        deltas.push(((points[i].value - prev) / Math.abs(prev)) * 100);
      }
    }
    if (deltas.length < 2) continue;

    const latestDelta = deltas[deltas.length - 1];
    const historicalDeltas = deltas.slice(0, -1);
    const m = mean(historicalDeltas);
    const s = std(historicalDeltas);
    const absDelta = Math.abs(latestDelta);

    // Flag if latest delta is statistical outlier OR absolute change is large
    const isStatOutlier = s > 0 && Math.abs(latestDelta - m) > 2 * s;
    const isLargeChange = absDelta > 30;

    if (!isStatOutlier && !isLargeChange) continue;

    const severity = absDelta > 50 ? 'high' : 'medium';
    const confidence = isStatOutlier && isLargeChange ? 0.9
      : isStatOutlier ? 0.75
        : 0.6;
    const direction = latestDelta > 0 ? 'increased' : 'decreased';

    signals.push({
      id: signalId('anomaly', normalizeMetricLabel(label)),
      type: 'anomaly',
      severity,
      confidence,
      title: `${label} ${direction} ${Math.abs(Math.round(latestDelta))}%`,
      description: `${label} ${direction} from ${points[points.length - 2].value}${unit ? ' ' + unit : ''} to ${latest}${unit ? ' ' + unit : ''}. This is ${isStatOutlier ? 'a statistical outlier compared to historical changes' : 'a significant change'}.`,
      evidence: [{
        snapshot_id: null,
        headline: label,
        metric: label,
        value: `${latest}${unit ? ' ' + unit : ''}`,
        date: points[points.length - 1].date,
      }],
      suggested_question: `Why did ${label} change so significantly? What are the root causes and implications?`,
      detected_at: new Date().toISOString(),
    });
  }

  return signals;
}

// ── Detector 2: Contradictions ───────────────────────────────────────────────

const CONTRADICTION_PAIRS = [
  { a: 'revenue', b: 'margin', expectSameSign: true, label: 'Revenue vs Margin' },
  { a: 'revenue', b: 'profit', expectSameSign: true, label: 'Revenue vs Profit' },
  { a: 'order', b: 'fulfillment', expectSameSign: true, label: 'Orders vs Fulfillment' },
  { a: 'cost', b: 'quality', expectSameSign: false, label: 'Cost vs Quality' },
  { a: 'inventory', b: 'stockout', expectSameSign: false, label: 'Inventory vs Stockout Risk' },
  { a: 'demand', b: 'inventory', expectSameSign: true, label: 'Demand vs Inventory' },
];

/**
 * Detect contradictory metric movements across recent snapshots.
 */
export function detectContradictions(snapshots) {
  const evolution = buildMetricEvolution(snapshots);
  if (evolution.length < 2) return [];

  const signals = [];
  const byLabel = {};
  for (const m of evolution) {
    byLabel[normalizeMetricLabel(m.label)] = m;
  }

  for (const pair of CONTRADICTION_PAIRS) {
    const metricA = Object.entries(byLabel).find(([k]) => k.includes(pair.a))?.[1];
    const metricB = Object.entries(byLabel).find(([k]) => k.includes(pair.b))?.[1];
    if (!metricA?.delta || !metricB?.delta) continue;
    if (Math.abs(metricA.delta) < 5 || Math.abs(metricB.delta) < 5) continue;

    const sameSign = (metricA.delta > 0) === (metricB.delta > 0);
    const isContradiction = pair.expectSameSign ? !sameSign : sameSign;
    if (!isContradiction) continue;

    const severity = (Math.abs(metricA.delta) > 30 || Math.abs(metricB.delta) > 30) ? 'high' : 'medium';

    signals.push({
      id: signalId('contradiction', `${pair.a}-${pair.b}`),
      type: 'contradiction',
      severity,
      confidence: 0.7,
      title: `${pair.label}: ${metricA.label} ${metricA.delta > 0 ? '↑' : '↓'} but ${metricB.label} ${metricB.delta > 0 ? '↑' : '↓'}`,
      description: `${metricA.label} changed ${metricA.delta > 0 ? '+' : ''}${Math.round(metricA.delta)}% while ${metricB.label} changed ${metricB.delta > 0 ? '+' : ''}${Math.round(metricB.delta)}%. These metrics typically ${pair.expectSameSign ? 'move together' : 'move in opposite directions'}.`,
      evidence: [
        { snapshot_id: null, headline: metricA.label, metric: metricA.label, value: `${metricA.delta > 0 ? '+' : ''}${Math.round(metricA.delta)}%`, date: metricA.points[metricA.points.length - 1]?.date },
        { snapshot_id: null, headline: metricB.label, metric: metricB.label, value: `${metricB.delta > 0 ? '+' : ''}${Math.round(metricB.delta)}%`, date: metricB.points[metricB.points.length - 1]?.date },
      ],
      suggested_question: `${metricA.label} and ${metricB.label} are moving in unexpected directions. What is causing this divergence?`,
      detected_at: new Date().toISOString(),
    });
  }

  return signals;
}

// ── Detector 3: Concentration Risk ───────────────────────────────────────────

const CONCENTRATION_PATTERN = /top\s+(\d+)\s+(account|customer|supplier|product|client|vendor|item|sku)s?\s+(represent|account\s+for|make\s+up|contribute)\s+(\d+(?:\.\d+)?)\s*%/i;
const HIGH_SHARE_PATTERN = /(\d+(?:\.\d+)?)\s*%\s+(?:of\s+)?(total\s+)?(revenue|sales|orders?|volume|spend|cost|demand)/i;

/**
 * Detect concentration risk from findings text and chart data.
 */
export function detectConcentrationRisk(snapshots) {
  const signals = [];
  const seen = new Set();

  for (const snap of (snapshots || [])) {
    // Scan key_findings for concentration language
    for (const finding of (snap.key_findings || [])) {
      const match = finding.match(CONCENTRATION_PATTERN);
      if (match) {
        const topN = parseInt(match[1], 10);
        const entity = match[2];
        const pct = parseFloat(match[4]);
        const key = `${entity}-${topN}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (pct < 60) continue;
        const severity = pct >= 80 ? 'critical' : 'high';

        signals.push({
          id: signalId('concentration', key),
          type: 'concentration',
          severity,
          confidence: 0.85,
          title: `Top ${topN} ${entity}s represent ${pct}% concentration`,
          description: `Analysis found that the top ${topN} ${entity}s account for ${pct}% of the total. This level of concentration creates significant dependency risk.`,
          evidence: [{
            snapshot_id: snap.id,
            headline: snap.headline,
            metric: `Top ${topN} ${entity} share`,
            value: `${pct}%`,
            date: snap.created_at?.slice(0, 10),
          }],
          suggested_question: `What would happen if we lost one of our top ${topN} ${entity}s? How can we diversify?`,
          detected_at: new Date().toISOString(),
        });
      }

      // Also check for high single-entity share
      const shareMatch = finding.match(HIGH_SHARE_PATTERN);
      if (shareMatch) {
        const pct = parseFloat(shareMatch[1]);
        const dimension = shareMatch[3];
        const key = `share-${dimension}`;
        if (seen.has(key) || pct < 50) continue;
        seen.add(key);

        signals.push({
          id: signalId('concentration', key),
          type: 'concentration',
          severity: pct >= 70 ? 'high' : 'medium',
          confidence: 0.7,
          title: `${pct}% ${dimension} concentration detected`,
          description: `A single entity accounts for ${pct}% of ${dimension}. This creates high dependency risk.`,
          evidence: [{
            snapshot_id: snap.id,
            headline: snap.headline,
            metric: `${dimension} share`,
            value: `${pct}%`,
            date: snap.created_at?.slice(0, 10),
          }],
          suggested_question: `What drives this ${dimension} concentration? What diversification options exist?`,
          detected_at: new Date().toISOString(),
        });
      }
    }

    // Scan chart_specs for pie/donut with dominant slice
    for (const chart of (snap.chart_specs || [])) {
      if (chart.type !== 'pie' && chart.type !== 'donut') continue;
      const data = chart.data || [];
      if (data.length < 2) continue;

      const yKey = chart.yKey || 'value';
      const values = data.map(d => typeof d[yKey] === 'number' ? d[yKey] : 0).filter(v => v > 0);
      const total = values.reduce((s, v) => s + v, 0);
      if (total <= 0) continue;

      const maxVal = Math.max(...values);
      const maxPct = (maxVal / total) * 100;
      if (maxPct < 50) continue;

      const chartKey = `chart-${chart.title || snap.id}`;
      if (seen.has(chartKey)) continue;
      seen.add(chartKey);

      signals.push({
        id: signalId('concentration', chartKey),
        type: 'concentration',
        severity: maxPct >= 70 ? 'high' : 'medium',
        confidence: 0.65,
        title: `${Math.round(maxPct)}% dominance in ${chart.title || 'distribution chart'}`,
        description: `One segment accounts for ${Math.round(maxPct)}% of the total in "${chart.title || 'a distribution chart'}".`,
        evidence: [{
          snapshot_id: snap.id,
          headline: snap.headline,
          metric: chart.title || 'Distribution',
          value: `${Math.round(maxPct)}%`,
          date: snap.created_at?.slice(0, 10),
        }],
        suggested_question: `What causes this dominance? Is this concentration increasing or decreasing over time?`,
        detected_at: new Date().toISOString(),
      });
    }
  }

  return signals;
}

// ── Detector 4: Stale Insights ───────────────────────────────────────────────

function normalizeQuery(q) {
  return (q || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Detect pinned snapshots that are stale or whose conclusions have changed.
 */
export function detectStaleInsights(snapshots) {
  if (!snapshots?.length) return [];

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const signals = [];
  const pinned = snapshots.filter(s => s.pinned);

  for (const pin of pinned) {
    const age = now - new Date(pin.created_at).getTime();
    const ageDays = Math.floor(age / DAY_MS);

    // Check for staleness
    if (ageDays >= 14) {
      const severity = ageDays >= 30 ? 'high' : 'medium';
      signals.push({
        id: signalId('stale_insight', pin.id),
        type: 'stale_insight',
        severity,
        confidence: 0.8,
        title: `Pinned insight "${pin.headline}" is ${ageDays} days old`,
        description: `This pinned analysis hasn't been refreshed in ${ageDays} days. Its conclusions may no longer reflect current data.`,
        evidence: [{
          snapshot_id: pin.id,
          headline: pin.headline,
          metric: 'Age',
          value: `${ageDays} days`,
          date: pin.created_at?.slice(0, 10),
        }],
        suggested_question: pin.query_text || `Re-run the analysis: "${pin.headline}"`,
        detected_at: new Date().toISOString(),
      });
    }

    // Check if a newer snapshot with same query shows different conclusions
    if (!pin.query_text) continue;
    const normQuery = normalizeQuery(pin.query_text);
    const newer = snapshots.find(s =>
      s.id !== pin.id &&
      normalizeQuery(s.query_text) === normQuery &&
      new Date(s.created_at) > new Date(pin.created_at)
    );
    if (!newer) continue;

    // Compare metric_pills for divergence
    const pinPills = {};
    for (const p of (pin.metric_pills || [])) {
      const { value } = parseMetricValue(p.value);
      if (value != null) pinPills[normalizeMetricLabel(p.label)] = value;
    }

    let significantChange = false;
    for (const p of (newer.metric_pills || [])) {
      const { value: newVal } = parseMetricValue(p.value);
      if (newVal == null) continue;
      const oldVal = pinPills[normalizeMetricLabel(p.label)];
      if (oldVal == null || oldVal === 0) continue;
      const changePct = Math.abs((newVal - oldVal) / Math.abs(oldVal)) * 100;
      if (changePct > 20) { significantChange = true; break; }
    }

    if (significantChange) {
      signals.push({
        id: signalId('stale_insight', `changed-${pin.id}`),
        type: 'stale_insight',
        severity: 'critical',
        confidence: 0.9,
        title: `Pinned insight "${pin.headline}" may be outdated — conclusions changed`,
        description: `A newer analysis of the same question shows metrics that differ by >20%. The pinned insight may be misleading.`,
        evidence: [
          { snapshot_id: pin.id, headline: `Pinned: ${pin.headline}`, metric: 'Original', value: pin.created_at?.slice(0, 10), date: pin.created_at?.slice(0, 10) },
          { snapshot_id: newer.id, headline: `Newer: ${newer.headline}`, metric: 'Updated', value: newer.created_at?.slice(0, 10), date: newer.created_at?.slice(0, 10) },
        ],
        suggested_question: `Compare the pinned analysis "${pin.headline}" with the latest version. What changed and why?`,
        detected_at: new Date().toISOString(),
      });
    }
  }

  return signals;
}

// ── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Run all signal detectors and return sorted results.
 * @param {object[]} snapshots - Analysis snapshots from Supabase
 * @returns {Array<Signal>} Sorted by severity (critical first) then recency
 */
export function runSignalScan(snapshots) {
  if (!snapshots?.length) return [];

  const signals = [
    ...detectMetricAnomalies(snapshots),
    ...detectContradictions(snapshots),
    ...detectConcentrationRisk(snapshots),
    ...detectStaleInsights(snapshots),
  ];

  // Deduplicate by ID (first occurrence wins)
  const seen = new Set();
  const deduped = [];
  for (const s of signals) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }

  // Sort: severity desc, then recency
  deduped.sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity) ||
    new Date(b.detected_at) - new Date(a.detected_at)
  );

  return deduped;
}
