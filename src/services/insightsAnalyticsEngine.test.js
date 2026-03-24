import { describe, it, expect } from 'vitest';
import {
  parseMetricValue,
  normalizeMetricLabel,
  buildMetricEvolution,
  buildActivityChart,
  buildTopicDistribution,
  buildTopFindings,
} from './insightsAnalyticsEngine.js';

// ── parseMetricValue ────────────────────────────────────────────────────────

describe('parseMetricValue', () => {
  it('parses currency with M suffix', () => {
    expect(parseMetricValue('R$1.2M')).toEqual({ value: 1200000, unit: '$' });
  });

  it('parses dollar with K suffix', () => {
    expect(parseMetricValue('$850K')).toEqual({ value: 850000, unit: '$' });
  });

  it('parses percentage', () => {
    expect(parseMetricValue('92%')).toEqual({ value: 92, unit: '%' });
  });

  it('parses duration', () => {
    expect(parseMetricValue('4.2 days')).toEqual({ value: 4.2, unit: 'day' });
  });

  it('parses plain number with commas', () => {
    expect(parseMetricValue('1,234')).toEqual({ value: 1234, unit: '' });
  });

  it('parses euro', () => {
    expect(parseMetricValue('€2.5M')).toEqual({ value: 2500000, unit: '$' });
  });

  it('returns null for N/A', () => {
    expect(parseMetricValue('N/A')).toEqual({ value: null, unit: '' });
  });

  it('returns null for empty string', () => {
    expect(parseMetricValue('')).toEqual({ value: null, unit: '' });
  });

  it('returns null for null', () => {
    expect(parseMetricValue(null)).toEqual({ value: null, unit: '' });
  });

  it('parses plain integer', () => {
    expect(parseMetricValue('42')).toEqual({ value: 42, unit: '' });
  });

  it('parses billions', () => {
    expect(parseMetricValue('$3.5B')).toEqual({ value: 3500000000, unit: '$' });
  });
});

// ── normalizeMetricLabel ────────────────────────────────────────────────────

describe('normalizeMetricLabel', () => {
  it('strips "Total" prefix', () => {
    expect(normalizeMetricLabel('Total Revenue')).toBe('revenue');
  });

  it('strips parenthetical units', () => {
    expect(normalizeMetricLabel('Revenue (R$)')).toBe('revenue');
  });

  it('strips "Avg" prefix', () => {
    expect(normalizeMetricLabel('Avg Delay')).toBe('delay');
  });

  it('lowercases', () => {
    expect(normalizeMetricLabel('Customer Count')).toBe('customer count');
  });

  it('handles empty', () => {
    expect(normalizeMetricLabel('')).toBe('');
  });
});

// ── buildMetricEvolution ────────────────────────────────────────────────────

describe('buildMetricEvolution', () => {
  const snapshots = [
    { created_at: '2026-03-20T10:00:00Z', metric_pills: [{ label: 'Revenue', value: 'R$1.0M' }] },
    { created_at: '2026-03-22T10:00:00Z', metric_pills: [{ label: 'Revenue', value: 'R$1.2M' }] },
    { created_at: '2026-03-24T10:00:00Z', metric_pills: [{ label: 'Revenue', value: 'R$1.5M' }, { label: 'Churn', value: '5%' }] },
  ];

  it('groups metrics by normalized label with ≥2 points', () => {
    const result = buildMetricEvolution(snapshots);
    expect(result.length).toBe(1); // Revenue has 3 points, Churn only 1
    expect(result[0].label).toBe('Revenue');
    expect(result[0].points).toHaveLength(3);
    expect(result[0].latest).toBe(1500000);
  });

  it('computes delta percentage', () => {
    const result = buildMetricEvolution(snapshots);
    // (1.5M - 1.2M) / 1.2M = 25%
    expect(result[0].delta).toBe(25);
  });

  it('returns empty for no snapshots', () => {
    expect(buildMetricEvolution([])).toEqual([]);
  });

  it('includes metric with exactly 2 points', () => {
    const snaps = [
      { created_at: '2026-03-20T10:00:00Z', metric_pills: [{ label: 'Cost', value: '$100K' }] },
      { created_at: '2026-03-22T10:00:00Z', metric_pills: [{ label: 'Cost', value: '$120K' }] },
    ];
    expect(buildMetricEvolution(snaps)).toHaveLength(1);
  });
});

// ── buildActivityChart ──────────────────────────────────────────────────────

describe('buildActivityChart', () => {
  it('fills all days in range with counts', () => {
    const result = buildActivityChart([], 7);
    expect(result).toHaveLength(7);
    expect(result.every(d => d.count === 0)).toBe(true);
  });

  it('counts snapshots on correct days', () => {
    const today = new Date().toISOString().slice(0, 10);
    const snaps = [
      { created_at: `${today}T10:00:00Z` },
      { created_at: `${today}T14:00:00Z` },
    ];
    const result = buildActivityChart(snaps, 7);
    const todayEntry = result.find(d => d.date === today.slice(5));
    expect(todayEntry?.count).toBe(2);
  });
});

// ── buildTopicDistribution ──────────────────────────────────────────────────

describe('buildTopicDistribution', () => {
  it('aggregates tag frequencies', () => {
    const snaps = [
      { tags: ['revenue', 'trend'] },
      { tags: ['revenue', 'forecast'] },
      { tags: ['cost'] },
    ];
    const result = buildTopicDistribution(snaps);
    expect(result[0]).toEqual({ name: 'Revenue', value: 2 });
    expect(result).toHaveLength(4);
  });

  it('returns empty for no snapshots', () => {
    expect(buildTopicDistribution([])).toEqual([]);
  });
});

// ── buildTopFindings ────────────────────────────────────────────────────────

describe('buildTopFindings', () => {
  it('deduplicates and ranks findings', () => {
    const snaps = [
      { key_findings: ['Revenue grew 15% MoM', 'Customer base expanded'], tags: ['revenue'] },
      { key_findings: ['Revenue grew 15% MoM', 'Costs decreased'], tags: ['revenue', 'cost'] },
      { key_findings: ['Costs decreased'], tags: ['cost'] },
    ];
    const result = buildTopFindings(snaps, 5);
    expect(result[0].text).toBe('Revenue grew 15% MoM');
    expect(result[0].frequency).toBe(2);
    expect(result[1].frequency).toBe(2); // Costs decreased
  });

  it('respects limit', () => {
    const snaps = [{ key_findings: Array.from({ length: 20 }, (_, i) => `Finding number ${i + 1} is important`) }];
    expect(buildTopFindings(snaps, 3)).toHaveLength(3);
  });

  it('skips very short findings', () => {
    const snaps = [{ key_findings: ['OK', 'Done', 'This is a real finding with enough length'] }];
    expect(buildTopFindings(snaps)).toHaveLength(1);
  });
});
