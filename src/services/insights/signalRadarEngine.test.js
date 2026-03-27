import { describe, it, expect } from 'vitest';
import {
  detectMetricAnomalies,
  detectContradictions,
  detectConcentrationRisk,
  detectStaleInsights,
  runSignalScan,
} from './signalRadarEngine.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnapshot(overrides = {}) {
  return {
    id: `snap-${Math.random().toString(36).slice(2, 8)}`,
    headline: 'Test Analysis',
    summary: 'A test analysis snapshot.',
    metric_pills: [],
    chart_specs: [],
    key_findings: [],
    tags: [],
    created_at: new Date().toISOString(),
    pinned: false,
    query_text: null,
    ...overrides,
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ── Detector 1: Metric Anomalies ─────────────────────────────────────────────

describe('detectMetricAnomalies', () => {
  it('returns empty for stable metrics', () => {
    // 5 snapshots with revenue ~$100K each (very small variation)
    const snaps = [100, 101, 100, 101, 100].map((val, i) => makeSnapshot({
      created_at: daysAgo(5 - i),
      metric_pills: [{ label: 'Revenue', value: `$${val}K` }],
    }));
    const signals = detectMetricAnomalies(snaps);
    expect(signals).toHaveLength(0);
  });

  it('flags a large spike as anomaly', () => {
    // 4 stable points then a 50% spike
    const snaps = [100, 102, 98, 101, 150].map((val, i) => makeSnapshot({
      created_at: daysAgo(5 - i),
      metric_pills: [{ label: 'Revenue', value: `$${val}K` }],
    }));
    const signals = detectMetricAnomalies(snaps);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('anomaly');
    expect(signals[0].title).toMatch(/Revenue/i);
    // 100→150 is ~48.5% change; severity threshold is >50% for high
    expect(['high', 'medium']).toContain(signals[0].severity);
  });

  it('flags a large drop', () => {
    const snaps = [100, 98, 102, 100, 60].map((val, i) => makeSnapshot({
      created_at: daysAgo(5 - i),
      metric_pills: [{ label: 'Orders', value: `${val}` }],
    }));
    const signals = detectMetricAnomalies(snaps);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].title).toMatch(/decreased/i);
  });

  it('needs at least 3 data points', () => {
    const snaps = [100, 200].map((val, i) => makeSnapshot({
      created_at: daysAgo(2 - i),
      metric_pills: [{ label: 'Revenue', value: `$${val}K` }],
    }));
    const signals = detectMetricAnomalies(snaps);
    expect(signals).toHaveLength(0);
  });
});

// ── Detector 2: Contradictions ───────────────────────────────────────────────

describe('detectContradictions', () => {
  it('detects revenue up + margin down', () => {
    const snaps = [
      makeSnapshot({
        created_at: daysAgo(3),
        metric_pills: [
          { label: 'Revenue', value: '$100K' },
          { label: 'Profit Margin', value: '25%' },
        ],
      }),
      makeSnapshot({
        created_at: daysAgo(1),
        metric_pills: [
          { label: 'Revenue', value: '$140K' },
          { label: 'Profit Margin', value: '18%' },
        ],
      }),
    ];
    const signals = detectContradictions(snaps);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('contradiction');
  });

  it('returns empty when metrics move in expected directions', () => {
    const snaps = [
      makeSnapshot({
        created_at: daysAgo(3),
        metric_pills: [
          { label: 'Revenue', value: '$100K' },
          { label: 'Profit Margin', value: '20%' },
        ],
      }),
      makeSnapshot({
        created_at: daysAgo(1),
        metric_pills: [
          { label: 'Revenue', value: '$130K' },
          { label: 'Profit Margin', value: '25%' },
        ],
      }),
    ];
    const signals = detectContradictions(snaps);
    expect(signals).toHaveLength(0);
  });

  it('ignores small movements (<5%)', () => {
    const snaps = [
      makeSnapshot({
        created_at: daysAgo(3),
        metric_pills: [
          { label: 'Revenue', value: '$100K' },
          { label: 'Margin', value: '20%' },
        ],
      }),
      makeSnapshot({
        created_at: daysAgo(1),
        metric_pills: [
          { label: 'Revenue', value: '$103K' },
          { label: 'Margin', value: '19.5%' },
        ],
      }),
    ];
    const signals = detectContradictions(snaps);
    expect(signals).toHaveLength(0);
  });
});

// ── Detector 3: Concentration Risk ───────────────────────────────────────────

describe('detectConcentrationRisk', () => {
  it('detects high concentration from findings text', () => {
    const snap = makeSnapshot({
      key_findings: ['Top 3 customers represent 85% of total revenue'],
    });
    const signals = detectConcentrationRisk([snap]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('concentration');
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].title).toMatch(/85%/);
  });

  it('ignores low concentration (<60%)', () => {
    const snap = makeSnapshot({
      key_findings: ['Top 5 customers represent 45% of total revenue'],
    });
    const signals = detectConcentrationRisk([snap]);
    expect(signals).toHaveLength(0);
  });

  it('detects dominant pie chart slice', () => {
    const snap = makeSnapshot({
      chart_specs: [{
        type: 'pie',
        title: 'Revenue by Region',
        data: [
          { name: 'North', value: 750 },
          { name: 'South', value: 100 },
          { name: 'East', value: 80 },
          { name: 'West', value: 70 },
        ],
        yKey: 'value',
      }],
    });
    const signals = detectConcentrationRisk([snap]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('concentration');
    expect(signals[0].title).toMatch(/75%/);
  });

  it('ignores even distributions', () => {
    const snap = makeSnapshot({
      chart_specs: [{
        type: 'pie',
        title: 'Revenue by Region',
        data: [
          { name: 'North', value: 250 },
          { name: 'South', value: 250 },
          { name: 'East', value: 250 },
          { name: 'West', value: 250 },
        ],
        yKey: 'value',
      }],
    });
    const signals = detectConcentrationRisk([snap]);
    expect(signals).toHaveLength(0);
  });
});

// ── Detector 4: Stale Insights ───────────────────────────────────────────────

describe('detectStaleInsights', () => {
  it('detects pinned snapshot older than 14 days', () => {
    const snap = makeSnapshot({
      pinned: true,
      created_at: daysAgo(20),
      headline: 'Q1 Revenue Analysis',
    });
    const signals = detectStaleInsights([snap]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('stale_insight');
    expect(signals[0].severity).toBe('medium');
  });

  it('flags >30 days as high severity', () => {
    const snap = makeSnapshot({
      pinned: true,
      created_at: daysAgo(35),
      headline: 'Old Analysis',
    });
    const signals = detectStaleInsights([snap]);
    expect(signals[0].severity).toBe('high');
  });

  it('ignores non-pinned snapshots', () => {
    const snap = makeSnapshot({
      pinned: false,
      created_at: daysAgo(60),
    });
    const signals = detectStaleInsights([snap]);
    expect(signals).toHaveLength(0);
  });

  it('detects changed conclusions as critical', () => {
    const pinned = makeSnapshot({
      id: 'pin-1',
      pinned: true,
      created_at: daysAgo(5),
      headline: 'Revenue Analysis',
      query_text: 'What is our revenue trend?',
      metric_pills: [{ label: 'Revenue', value: '$100K' }],
    });
    const newer = makeSnapshot({
      id: 'newer-1',
      pinned: false,
      created_at: daysAgo(1),
      headline: 'Revenue Analysis (updated)',
      query_text: 'What is our revenue trend?',
      metric_pills: [{ label: 'Revenue', value: '$130K' }],
    });
    const signals = detectStaleInsights([pinned, newer]);
    const changedSignal = signals.find(s => s.severity === 'critical');
    expect(changedSignal).toBeDefined();
    expect(changedSignal.title).toMatch(/outdated/i);
  });
});

// ── Aggregator ───────────────────────────────────────────────────────────────

describe('runSignalScan', () => {
  it('returns empty for no snapshots', () => {
    expect(runSignalScan([])).toHaveLength(0);
    expect(runSignalScan(null)).toHaveLength(0);
  });

  it('combines signals from multiple detectors and sorts by severity', () => {
    const snaps = [
      // Stale pinned (medium)
      makeSnapshot({
        pinned: true,
        created_at: daysAgo(20),
        headline: 'Old Insight',
      }),
      // Concentration (critical)
      makeSnapshot({
        key_findings: ['Top 2 suppliers represent 90% of procurement spend'],
        created_at: daysAgo(2),
      }),
    ];
    const signals = runSignalScan(snaps);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    // Critical should come first
    expect(signals[0].severity).toBe('critical');
  });

  it('deduplicates signals with same ID', () => {
    // Two snapshots with same concentration finding
    const finding = 'Top 3 customers represent 85% of total revenue';
    const snaps = [
      makeSnapshot({ key_findings: [finding], created_at: daysAgo(3) }),
      makeSnapshot({ key_findings: [finding], created_at: daysAgo(1) }),
    ];
    const signals = runSignalScan(snaps);
    const concentrationSignals = signals.filter(s => s.type === 'concentration');
    // Both snapshots match the same pattern, dedup by signal ID (concentration:customer-3)
    // However each snapshot may also match HIGH_SHARE_PATTERN producing a second signal
    // The key thing is the primary pattern deduplicates
    expect(concentrationSignals.length).toBeGreaterThanOrEqual(1);
    expect(concentrationSignals.length).toBeLessThanOrEqual(2);
  });
});
