import { describe, it, expect } from 'vitest';
import {
  parseMetricValue,
  normalizeMetricLabel,
  buildMetricEvolution,
  buildActivityChart,
  buildTopicDistribution,
  buildTopFindings,
  extractLatestKpis,
  extractTopCharts,
  extractTopTables,
  buildInsightsSummary,
  analyzeCrossMetrics,
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

// ── extractLatestKpis ───────────────────────────────────────────────────────

describe('extractLatestKpis', () => {
  const snapshots = [
    {
      created_at: '2026-03-24T10:00:00Z',
      headline: 'Latest Report',
      metric_pills: [
        { label: 'Revenue', value: '$1.5M' },
        { label: 'Churn', value: '5%' },
      ],
    },
    {
      created_at: '2026-03-22T10:00:00Z',
      headline: 'Older Report',
      metric_pills: [
        { label: 'Revenue', value: '$1.2M' },
        { label: 'Cost', value: '$800K' },
      ],
    },
  ];

  it('deduplicates by normalized label, newest wins', () => {
    const result = extractLatestKpis(snapshots);
    const revenueKpi = result.find(k => k.label === 'Revenue');
    expect(revenueKpi.value).toBe('$1.5M');
    expect(revenueKpi.date).toBe('2026-03-24');
    expect(revenueKpi.sourceHeadline).toBe('Latest Report');
  });

  it('collects unique KPIs from multiple snapshots', () => {
    const result = extractLatestKpis(snapshots);
    expect(result).toHaveLength(3); // Revenue, Churn, Cost
    expect(result.map(k => k.label)).toEqual(['Revenue', 'Churn', 'Cost']);
  });

  it('respects limit', () => {
    expect(extractLatestKpis(snapshots, 2)).toHaveLength(2);
  });

  it('returns empty for no snapshots', () => {
    expect(extractLatestKpis([])).toEqual([]);
  });

  it('includes numeric value and unit', () => {
    const result = extractLatestKpis(snapshots);
    const churn = result.find(k => k.label === 'Churn');
    expect(churn.numericValue).toBe(5);
    expect(churn.unit).toBe('%');
  });
});

// ── extractTopCharts ────────────────────────────────────────────────────────

describe('extractTopCharts', () => {
  const snapshots = [
    {
      created_at: '2026-03-24T10:00:00Z',
      headline: 'Revenue Analysis',
      chart_specs: [
        { type: 'line', title: 'Revenue Trend', data: [{ x: 1, y: 10 }, { x: 2, y: 20 }], xKey: 'x', yKey: 'y' },
        { type: 'bar', title: 'Cost Breakdown', data: [{ cat: 'A', val: 5 }, { cat: 'B', val: 8 }], xKey: 'cat', yKey: 'val' },
      ],
    },
    {
      created_at: '2026-03-22T10:00:00Z',
      headline: 'Old Report',
      chart_specs: [
        { type: 'line', title: 'Revenue Trend', data: [{ x: 1, y: 5 }, { x: 2, y: 10 }], xKey: 'x', yKey: 'y' },
        { type: 'pie', title: 'Market Share', data: [{ name: 'A', value: 60 }, { name: 'B', value: 40 }], xKey: 'name', yKey: 'value' },
      ],
    },
  ];

  it('deduplicates by title, newest wins', () => {
    const result = extractTopCharts(snapshots);
    const revChart = result.find(c => c.title === 'Revenue Trend');
    expect(revChart.data[0].y).toBe(10); // from newest snapshot
    expect(revChart.sourceHeadline).toBe('Revenue Analysis');
  });

  it('collects unique charts', () => {
    const result = extractTopCharts(snapshots);
    expect(result).toHaveLength(3); // Revenue Trend, Cost Breakdown, Market Share
  });

  it('filters out charts with < 2 data points', () => {
    const snaps = [{
      created_at: '2026-03-24T10:00:00Z',
      headline: 'Test',
      chart_specs: [
        { type: 'bar', title: 'Empty', data: [{ x: 1 }], xKey: 'x', yKey: 'y' },
        { type: 'bar', title: 'Valid', data: [{ x: 1 }, { x: 2 }], xKey: 'x', yKey: 'y' },
      ],
    }];
    expect(extractTopCharts(snaps)).toHaveLength(1);
    expect(extractTopCharts(snaps)[0].title).toBe('Valid');
  });

  it('respects limit', () => {
    expect(extractTopCharts(snapshots, 1)).toHaveLength(1);
  });

  it('returns empty for no snapshots', () => {
    expect(extractTopCharts([])).toEqual([]);
  });

  it('attaches source metadata', () => {
    const result = extractTopCharts(snapshots);
    expect(result[0].sourceDate).toBe('2026-03-24');
  });
});

// ── extractTopTables ────────────────────────────────────────────────────────

describe('extractTopTables', () => {
  const snapshots = [
    {
      created_at: '2026-03-24T10:00:00Z',
      headline: 'Sales Report',
      table_specs: [
        { title: 'Top Products', columns: ['Product', 'Revenue'], rows: [['A', '$100'], ['B', '$200']] },
      ],
    },
    {
      created_at: '2026-03-22T10:00:00Z',
      headline: 'Old Report',
      table_specs: [
        { title: 'Top Products', columns: ['Product', 'Revenue'], rows: [['C', '$50']] },
        { title: 'Regional Sales', columns: ['Region', 'Total'], rows: [['East', '$500']] },
      ],
    },
  ];

  it('deduplicates by title, newest wins', () => {
    const result = extractTopTables(snapshots);
    const prodTable = result.find(t => t.title === 'Top Products');
    expect(prodTable.rows[0][0]).toBe('A');
    expect(prodTable.sourceHeadline).toBe('Sales Report');
  });

  it('collects unique tables', () => {
    expect(extractTopTables(snapshots)).toHaveLength(2);
  });

  it('filters out tables with no columns', () => {
    const snaps = [{
      created_at: '2026-03-24T10:00:00Z',
      headline: 'Test',
      table_specs: [
        { title: 'Bad', columns: [], rows: [['x']] },
        { title: 'Good', columns: ['A'], rows: [['1']] },
      ],
    }];
    expect(extractTopTables(snaps)).toHaveLength(1);
    expect(extractTopTables(snaps)[0].title).toBe('Good');
  });

  it('respects limit', () => {
    expect(extractTopTables(snapshots, 1)).toHaveLength(1);
  });

  it('returns empty for no snapshots', () => {
    expect(extractTopTables([])).toEqual([]);
  });

  it('supports headers alias for columns', () => {
    const snaps = [{
      created_at: '2026-03-24T10:00:00Z',
      headline: 'Test',
      table_specs: [{ title: 'Alt', headers: ['X'], data: [['1']] }],
    }];
    const result = extractTopTables(snaps);
    expect(result).toHaveLength(1);
    expect(result[0].columns).toEqual(['X']);
  });
});

// ── buildInsightsSummary ────────────────────────────────────────────────────

describe('buildInsightsSummary', () => {
  const snapshots = [
    {
      key_findings: ['Revenue grew 15% MoM', 'Customer base expanded significantly'],
      implications: ['This means growth is accelerating rapidly'],
      caveats: ['However data quality is limited in some regions'],
      next_steps: ['Recommend deeper dive into regional breakdown'],
    },
    {
      key_findings: ['Revenue grew 15% MoM', 'Costs decreased by 5%'],
      implications: ['This suggests operational efficiency improved'],
      caveats: [],
      next_steps: ['Consider expanding to new markets'],
    },
  ];

  it('deduplicates findings', () => {
    const result = buildInsightsSummary(snapshots);
    const revenueFindings = result.findings.filter(f => f.includes('Revenue grew'));
    expect(revenueFindings).toHaveLength(1);
  });

  it('aggregates implications', () => {
    const result = buildInsightsSummary(snapshots);
    expect(result.implications).toHaveLength(2);
  });

  it('aggregates caveats (skips empty)', () => {
    const result = buildInsightsSummary(snapshots);
    expect(result.caveats).toHaveLength(1);
  });

  it('aggregates next steps', () => {
    const result = buildInsightsSummary(snapshots);
    expect(result.nextSteps).toHaveLength(2);
  });

  it('returns empty arrays for no snapshots', () => {
    const result = buildInsightsSummary([]);
    expect(result).toEqual({ findings: [], implications: [], caveats: [], nextSteps: [] });
  });
});

// ── analyzeCrossMetrics ─────────────────────────────────────────────────────

describe('analyzeCrossMetrics', () => {
  it('detects anomalies (metrics with >20% delta)', () => {
    const snaps = [
      { created_at: '2026-03-20T10:00:00Z', metric_pills: [{ label: 'Revenue', value: '$100K' }] },
      { created_at: '2026-03-24T10:00:00Z', metric_pills: [{ label: 'Revenue', value: '$150K' }] },
    ];
    const result = analyzeCrossMetrics(snaps);
    expect(result.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(result.anomalies[0].metric).toBe('Revenue');
    expect(result.anomalies[0].direction).toBe('up');
  });

  it('detects correlations between metrics moving together', () => {
    const snaps = [
      { created_at: '2026-03-20T10:00:00Z', metric_pills: [{ label: 'Revenue', value: '$100K' }, { label: 'Cost', value: '$50K' }] },
      { created_at: '2026-03-24T10:00:00Z', metric_pills: [{ label: 'Revenue', value: '$130K' }, { label: 'Cost', value: '$70K' }] },
    ];
    const result = analyzeCrossMetrics(snaps);
    expect(result.correlations.length).toBeGreaterThanOrEqual(1);
    expect(result.correlations[0].relationship).toBe('co-moving');
  });

  it('generates insights for revenue vs cost divergence', () => {
    const snaps = [
      { created_at: '2026-03-20T10:00:00Z', metric_pills: [{ label: 'Revenue', value: '$100K' }, { label: 'Total Cost', value: '$50K' }] },
      { created_at: '2026-03-24T10:00:00Z', metric_pills: [{ label: 'Revenue', value: '$110K' }, { label: 'Total Cost', value: '$70K' }] },
    ];
    const result = analyzeCrossMetrics(snaps);
    const marginInsight = result.insights.find(i => i.includes('margin') || i.includes('cost'));
    expect(marginInsight).toBeTruthy();
  });

  it('returns empty for no snapshots', () => {
    const result = analyzeCrossMetrics([]);
    expect(result).toEqual({ anomalies: [], correlations: [], insights: [] });
  });

  it('flags high severity for >50% delta', () => {
    const snaps = [
      { created_at: '2026-03-20T10:00:00Z', metric_pills: [{ label: 'Churn', value: '5%' }] },
      { created_at: '2026-03-24T10:00:00Z', metric_pills: [{ label: 'Churn', value: '10%' }] },
    ];
    const result = analyzeCrossMetrics(snaps);
    const churnAnomaly = result.anomalies.find(a => a.metric === 'Churn');
    expect(churnAnomaly).toBeTruthy();
    expect(churnAnomaly.severity).toBe('high'); // 100% increase
  });
});
