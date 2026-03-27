import { describe, it, expect } from 'vitest';
import {
  checkTimeSeriesStationarity,
  checkSeasonality,
  checkSampleSize,
  checkOutlierContamination,
  checkHighCardinality,
  checkDataGaps,
  checkPartialYearCoverage,
  detectBusinessContext,
  validateQueryResultData,
  formatWarningsForAgent,
  getWarningIds,
  WARNING_ACKNOWLEDGMENT_PATTERNS,
} from './preAnalysisDataValidator.js';

// ── Helper: generate monthly time series ────────────────────────────────────

function generateMonthlyRows(startYear, startMonth, count, valueFn) {
  const rows = [];
  let y = startYear;
  let m = startMonth;
  for (let i = 0; i < count; i++) {
    rows.push({
      order_month: `${y}-${String(m).padStart(2, '0')}-01`,
      monthly_demand: valueFn(i),
    });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return rows;
}

// ── checkTimeSeriesStationarity ─────────────────────────────────────────────

describe('checkTimeSeriesStationarity', () => {
  it('detects upward trend when second half mean is 30%+ higher', () => {
    // First 12 months: ~100, last 12 months: ~150 (50% increase)
    const rows = generateMonthlyRows(2017, 1, 24, (i) => (i < 12 ? 100 : 150));
    const warnings = checkTimeSeriesStationarity(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe('non_stationary_trend');
    expect(warnings[0].severity).toBe('high');
    expect(warnings[0].message).toContain('upward');
    expect(warnings[0].message).toContain('50%');
  });

  it('detects downward trend', () => {
    const rows = generateMonthlyRows(2017, 1, 24, (i) => (i < 12 ? 200 : 100));
    const warnings = checkTimeSeriesStationarity(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('downward');
  });

  it('returns no warning for flat data', () => {
    const rows = generateMonthlyRows(2017, 1, 24, () => 100 + Math.random() * 5);
    const warnings = checkTimeSeriesStationarity(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(0);
  });

  it('skips when fewer than 6 data points', () => {
    const rows = generateMonthlyRows(2017, 1, 4, (i) => (i < 2 ? 100 : 200));
    const warnings = checkTimeSeriesStationarity(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(0);
  });

  it('skips columns without a date column', () => {
    const rows = [{ value: 100 }, { value: 200 }];
    const warnings = checkTimeSeriesStationarity(rows, ['value']);
    expect(warnings).toHaveLength(0);
  });
});

// ── checkSeasonality ────────────────────────────────────────────────────────

describe('checkSeasonality', () => {
  it('detects seasonal variation when monthly means differ significantly', () => {
    // Simulate seasonal pattern: months 11,12 have 3x demand
    const rows = generateMonthlyRows(2016, 1, 36, (i) => {
      const month = ((i % 12) + 1);
      return month >= 11 ? 300 : 100;
    });
    const warnings = checkSeasonality(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe('seasonal_pattern');
    expect(warnings[0].severity).toBe('medium');
  });

  it('returns no warning for uniform monthly data', () => {
    const rows = generateMonthlyRows(2016, 1, 24, () => 100);
    const warnings = checkSeasonality(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(0);
  });

  it('skips with fewer than 4 distinct months', () => {
    const rows = generateMonthlyRows(2017, 1, 3, (i) => (i === 2 ? 500 : 100));
    const warnings = checkSeasonality(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(0);
  });
});

describe('checkPartialYearCoverage', () => {
  it('tells the agent to compute overall coverage from the full dataset instead of MAX(covered_months)', () => {
    const warnings = checkPartialYearCoverage(
      [
        { year: 2016, revenue: 10 },
        { year: 2017, revenue: 20 },
        { year: 2018, revenue: 30 },
      ],
      ['year', 'revenue'],
      'SELECT EXTRACT(YEAR FROM order_purchase_timestamp) AS year, SUM(price) AS revenue FROM orders GROUP BY 1'
    );

    expect(warnings[0]?.id).toBe('partial_year_coverage');
    expect(warnings[0]?.instruction).toContain("COUNT(DISTINCT DATE_TRUNC('month'");
    expect(warnings[0]?.instruction).toContain('NEVER infer it via MAX(covered_months)');
  });
});

// ── checkSampleSize ─────────────────────────────────────────────────────────

describe('checkSampleSize', () => {
  it('returns high severity for fewer than 12 rows', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ value: i }));
    const warnings = checkSampleSize(rows, ['value']);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample');
    expect(sizeWarning).toBeDefined();
    expect(sizeWarning.severity).toBe('high');
  });

  it('returns medium severity for 12-29 rows', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ value: i }));
    const warnings = checkSampleSize(rows, ['value']);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample');
    expect(sizeWarning).toBeDefined();
    expect(sizeWarning.severity).toBe('medium');
  });

  it('returns no warning for 30+ rows (no date column)', () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ value: i }));
    const warnings = checkSampleSize(rows, ['value']);
    expect(warnings).toHaveLength(0);
  });

  it('warns about insufficient time periods', () => {
    const rows = generateMonthlyRows(2018, 1, 8, (i) => i * 10);
    const warnings = checkSampleSize(rows, ['order_month', 'monthly_demand']);
    const periodWarning = warnings.find((w) => w.column === 'order_month');
    expect(periodWarning).toBeDefined();
    expect(periodWarning.message).toContain('8 distinct time periods');
  });

  it('treats integer year columns as distinct yearly periods', () => {
    const rows = [
      { year: 2016, revenue: 10 },
      { year: 2017, revenue: 20 },
      { year: 2018, revenue: 30 },
    ];
    const warnings = checkSampleSize(rows, ['year', 'revenue']);
    const periodWarning = warnings.find((w) => w.column === 'year');
    expect(periodWarning).toBeDefined();
    expect(periodWarning.message).toContain('3 distinct time periods');
  });
});

// ── checkSampleSize: aggregation-aware ─────────────────────────────────────

describe('checkSampleSize — aggregated queries', () => {
  const groupBySql = 'SELECT bracket, COUNT(*) AS count FROM sellers GROUP BY bracket';

  it('skips small_sample when GROUP BY count col sums to >= 30', () => {
    const rows = [
      { bracket: 'low', count: 1500 },
      { bracket: 'mid', count: 2000 },
      { bracket: 'high', count: 1500 },
    ];
    const warnings = checkSampleSize(rows, ['bracket', 'count'], groupBySql);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample' && w.column === null);
    expect(sizeWarning).toBeUndefined();
  });

  it('warns when GROUP BY count col sums to < 30', () => {
    const rows = [
      { bracket: 'low', count: 5 },
      { bracket: 'mid', count: 7 },
      { bracket: 'high', count: 3 },
    ];
    const warnings = checkSampleSize(rows, ['bracket', 'count'], groupBySql);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample' && w.column === null);
    expect(sizeWarning).toBeDefined();
    expect(sizeWarning.message).toContain('aggregated');
    expect(sizeWarning.message).toContain('~15');
  });

  it('does not warn for GROUP BY with no count col and >= 5 rows', () => {
    const sql = 'SELECT category, AVG(price) AS avg_price FROM products GROUP BY category';
    const rows = Array.from({ length: 8 }, (_, i) => ({ category: `C${i}`, avg_price: 100 + i }));
    const warnings = checkSampleSize(rows, ['category', 'avg_price'], sql);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample' && w.column === null);
    expect(sizeWarning).toBeUndefined();
  });

  it('warns for GROUP BY with no count col and < 5 rows', () => {
    const sql = 'SELECT region, SUM(sales) AS total FROM orders GROUP BY region';
    const rows = [
      { region: 'East', total: 5000 },
      { region: 'West', total: 3000 },
      { region: 'South', total: 4000 },
    ];
    const warnings = checkSampleSize(rows, ['region', 'total'], sql);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample' && w.column === null);
    expect(sizeWarning).toBeDefined();
    expect(sizeWarning.message).toContain('aggregated groups');
  });

  it('preserves original behavior for non-GROUP BY queries', () => {
    const sql = 'SELECT * FROM orders LIMIT 8';
    const rows = Array.from({ length: 8 }, (_, i) => ({ value: i }));
    const warnings = checkSampleSize(rows, ['value'], sql);
    const sizeWarning = warnings.find((w) => w.id === 'small_sample');
    expect(sizeWarning).toBeDefined();
    expect(sizeWarning.severity).toBe('high');
  });

  it('preserves original behavior when sql is null/undefined', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ value: i }));
    const warnings = checkSampleSize(rows, ['value'], null);
    expect(warnings.find((w) => w.id === 'small_sample')).toBeDefined();

    const warnings2 = checkSampleSize(rows, ['value']);
    expect(warnings2.find((w) => w.id === 'small_sample')).toBeDefined();
  });
});

// ── checkOutlierContamination ───────────────────────────────────────────────

describe('checkOutlierContamination', () => {
  it('detects columns with extreme outliers', () => {
    // 90 normal values + 10 extreme outliers = 10%
    const rows = [
      ...Array.from({ length: 90 }, () => ({ amount: 100 + Math.random() * 20 })),
      ...Array.from({ length: 10 }, () => ({ amount: 10000 })),
    ];
    const warnings = checkOutlierContamination(rows, ['amount']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe('outlier_contamination');
    expect(warnings[0].column).toBe('amount');
  });

  it('returns no warning for clean data', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ amount: 100 + i }));
    const warnings = checkOutlierContamination(rows, ['amount']);
    expect(warnings).toHaveLength(0);
  });

  it('skips columns with fewer than 10 values', () => {
    const rows = Array.from({ length: 5 }, () => ({ amount: 100 }));
    rows.push({ amount: 99999 });
    const warnings = checkOutlierContamination(rows, ['amount']);
    expect(warnings).toHaveLength(0);
  });
});

// ── checkHighCardinality ────────────────────────────────────────────────────

describe('checkHighCardinality', () => {
  it('warns when groups have too few observations', () => {
    const rows = [
      { category: 'A', value: 1 },
      { category: 'B', value: 2 },
      { category: 'C', value: 3 },
      { category: 'D', value: 4 },
      { category: 'E', value: 5 },
      { category: 'F', value: 6 },
    ];
    const warnings = checkHighCardinality(rows, ['category', 'value']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe('insufficient_groups');
    expect(warnings[0].column).toBe('category');
  });

  it('returns no warning when groups have sufficient data', () => {
    const rows = [];
    for (const cat of ['A', 'B']) {
      for (let i = 0; i < 10; i++) rows.push({ category: cat, value: i });
    }
    const warnings = checkHighCardinality(rows, ['category', 'value']);
    expect(warnings).toHaveLength(0);
  });
});

// ── checkDataGaps ───────────────────────────────────────────────────────────

describe('checkDataGaps', () => {
  it('detects missing months in time series', () => {
    const rows = [
      { order_month: '2017-01-01', demand: 100 },
      { order_month: '2017-02-01', demand: 110 },
      { order_month: '2017-03-01', demand: 120 },
      // gap: April missing
      { order_month: '2017-05-01', demand: 130 },
      { order_month: '2017-06-01', demand: 140 },
      { order_month: '2017-07-01', demand: 150 },
    ];
    const warnings = checkDataGaps(rows, ['order_month', 'demand']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe('data_gaps');
    expect(warnings[0].message).toContain('1 gap');
  });

  it('returns no warning for continuous time series', () => {
    const rows = generateMonthlyRows(2017, 1, 12, () => 100);
    const warnings = checkDataGaps(rows, ['order_month', 'monthly_demand']);
    expect(warnings).toHaveLength(0);
  });

  it('skips with fewer than 6 data points', () => {
    const rows = [
      { order_month: '2017-01-01', demand: 100 },
      { order_month: '2017-06-01', demand: 200 },
    ];
    const warnings = checkDataGaps(rows, ['order_month', 'demand']);
    expect(warnings).toHaveLength(0);
  });
});

// ── detectBusinessContext ───────────────────────────────────────────────────

describe('detectBusinessContext', () => {
  it('detects multi-party marketplace from seller+customer columns', () => {
    const rows = [
      { seller_id: 'S1', customer_id: 'C1', order_id: 'O1' },
      { seller_id: 'S2', customer_id: 'C2', order_id: 'O2' },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'multi_party_marketplace')).toBe(true);
    expect(clues.find((c) => c.id === 'multi_party_marketplace').message).toContain('marketplace');
  });

  it('detects multi-entity from warehouse_id with multiple values', () => {
    const rows = [
      { warehouse_id: 'W1', sku: 'SKU1', qty: 100 },
      { warehouse_id: 'W2', sku: 'SKU2', qty: 200 },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'multi_entity')).toBe(true);
    expect(clues.find((c) => c.id === 'multi_entity').message).toContain('2 distinct');
  });

  it('does not flag multi-entity for single warehouse', () => {
    const rows = [
      { warehouse_id: 'W1', sku: 'SKU1', qty: 100 },
      { warehouse_id: 'W1', sku: 'SKU2', qty: 200 },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'multi_entity')).toBe(false);
  });

  it('detects pre-aggregated data from column prefixes', () => {
    const rows = [
      { category: 'A', avg_demand: 100, sum_revenue: 50000, count_orders: 200 },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'pre_aggregated')).toBe(true);
  });

  it('does not flag aggregation with only one agg column', () => {
    const rows = [{ category: 'A', avg_demand: 100, raw_price: 50 }];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'pre_aggregated')).toBe(false);
  });

  it('detects short time window', () => {
    const rows = [
      { order_date: '2018-01-01', value: 100 },
      { order_date: '2018-02-15', value: 200 },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'short_time_window')).toBe(true);
  });

  it('detects long time window', () => {
    const rows = [
      { order_date: '2014-01-01', value: 100 },
      { order_date: '2018-06-01', value: 200 },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues.some((c) => c.id === 'long_time_window')).toBe(true);
  });

  it('returns empty for clean single-entity data', () => {
    const rows = [
      { product: 'Widget', price: 10, qty: 50 },
      { product: 'Gadget', price: 20, qty: 30 },
    ];
    const clues = detectBusinessContext(rows);
    expect(clues).toHaveLength(0);
  });

  it('handles empty/null input', () => {
    expect(detectBusinessContext([])).toHaveLength(0);
    expect(detectBusinessContext(null)).toHaveLength(0);
    expect(detectBusinessContext(undefined)).toHaveLength(0);
  });

  it('does not flag pre-aggregated when SQL has GROUP BY', () => {
    const rows = [
      { month: '2017-01', max_monthly_revenue: 120098, min_monthly_revenue: 50000, count_orders: 787 },
      { month: '2017-02', max_monthly_revenue: 244959, min_monthly_revenue: 80000, count_orders: 1718 },
    ];
    const sql = 'SELECT month, MAX(revenue) as max_monthly_revenue, MIN(revenue) as min_monthly_revenue, COUNT(*) as count_orders FROM orders GROUP BY month';
    const clues = detectBusinessContext(rows, sql);
    expect(clues.some((c) => c.id === 'pre_aggregated')).toBe(false);
  });

  it('still flags pre-aggregated when SQL has no GROUP BY', () => {
    const rows = [
      { category: 'A', avg_demand: 100, sum_revenue: 50000, count_orders: 200 },
    ];
    const sql = 'SELECT * FROM pre_aggregated_table';
    const clues = detectBusinessContext(rows, sql);
    expect(clues.some((c) => c.id === 'pre_aggregated')).toBe(true);
  });
});

// ── validateQueryResultData (end-to-end) ────────────────────────────────────

describe('validateQueryResultData', () => {
  it('combines multiple warnings from a problematic dataset', () => {
    // Small sample + trend
    const rows = generateMonthlyRows(2017, 1, 8, (i) => (i < 4 ? 100 : 200));
    const { warnings } = validateQueryResultData(rows, ['order_month', 'monthly_demand'], 'SELECT ...');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const ids = getWarningIds(warnings);
    expect(ids).toContain('small_sample');
    expect(ids).toContain('non_stationary_trend');
  });

  it('returns empty warnings for valid data', () => {
    const rows = generateMonthlyRows(2016, 1, 36, () => 100 + Math.random() * 10);
    const { warnings } = validateQueryResultData(rows, ['order_month', 'monthly_demand'], 'SELECT ...');
    // No trend, no seasonality, >=30 rows
    const highWarnings = warnings.filter((w) => w.severity === 'high');
    expect(highWarnings).toHaveLength(0);
  });

  it('handles empty input gracefully', () => {
    expect(validateQueryResultData([], [], '').warnings).toHaveLength(0);
    expect(validateQueryResultData(null, null, '').warnings).toHaveLength(0);
  });
});

// ── formatWarningsForAgent ──────────────────────────────────────────────────

describe('formatWarningsForAgent', () => {
  it('formats warnings into readable markdown', () => {
    const warnings = [
      { id: 'non_stationary_trend', severity: 'high', message: 'Trend detected', instruction: 'Decompose trend' },
      { id: 'small_sample', severity: 'medium', message: 'Small sample', instruction: 'Use robust estimators' },
    ];
    const text = formatWarningsForAgent(warnings);
    expect(text).toContain('🔴 HIGH');
    expect(text).toContain('🟡 MEDIUM');
    expect(text).toContain('Trend detected');
    expect(text).toContain('Action: Decompose trend');
  });

  it('returns empty string for no warnings', () => {
    expect(formatWarningsForAgent([])).toBe('');
    expect(formatWarningsForAgent(null)).toBe('');
  });
});

// ── getWarningIds ───────────────────────────────────────────────────────────

describe('getWarningIds', () => {
  it('extracts warning IDs', () => {
    const warnings = [{ id: 'a' }, { id: 'b' }];
    expect(getWarningIds(warnings)).toEqual(['a', 'b']);
  });

  it('handles null', () => {
    expect(getWarningIds(null)).toEqual([]);
  });
});

// ── WARNING_ACKNOWLEDGMENT_PATTERNS ─────────────────────────────────────────

describe('WARNING_ACKNOWLEDGMENT_PATTERNS', () => {
  it('non_stationary_trend patterns match expected text', () => {
    const patterns = WARNING_ACKNOWLEDGMENT_PATTERNS.non_stationary_trend;
    expect(patterns.some((p) => p.test('The data shows a growth trend'))).toBe(true);
    expect(patterns.some((p) => p.test('非平穩數據需要去趨勢處理'))).toBe(true);
    expect(patterns.some((p) => p.test('Revenue was $500'))).toBe(false);
  });

  it('seasonal_pattern patterns match expected text', () => {
    const patterns = WARNING_ACKNOWLEDGMENT_PATTERNS.seasonal_pattern;
    expect(patterns.some((p) => p.test('After seasonal decomposition'))).toBe(true);
    expect(patterns.some((p) => p.test('季節性分解後'))).toBe(true);
  });

  it('small_sample patterns match expected text', () => {
    const patterns = WARNING_ACKNOWLEDGMENT_PATTERNS.small_sample;
    expect(patterns.some((p) => p.test('Due to the small sample size'))).toBe(true);
    expect(patterns.some((p) => p.test('資料不足以做可靠估計'))).toBe(true);
    expect(patterns.some((p) => p.test('This result has limited annual coverage and only three yearly observations'))).toBe(true);
    expect(patterns.some((p) => p.test('由於年度覆蓋有限，只有三個年度觀測值'))).toBe(true);
  });
});
