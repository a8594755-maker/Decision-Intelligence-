// @product: olist-analysis
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sapDataQueryService — return synthetic data for each SQL query
vi.mock('./sapDataQueryService.js', () => ({
  SAP_TABLE_REGISTRY: {
    customers: { source: 'csv', columns: ['customer_id', 'customer_unique_id', 'customer_zip_code_prefix', 'customer_city', 'customer_state'] },
    orders: { source: 'csv', columns: ['order_id', 'customer_id', 'order_status', 'order_purchase_timestamp'] },
    order_items: { source: 'csv', columns: ['order_id', 'order_item_id', 'product_id', 'seller_id', 'price', 'freight_value'] },
    payments: { source: 'csv', columns: ['order_id', 'payment_type', 'payment_installments', 'payment_value'] },
    reviews: { source: 'csv', columns: ['review_id', 'order_id', 'review_score'] },
    products: { source: 'csv', columns: ['product_id', 'product_category_name'] },
    sellers: { source: 'csv', columns: ['seller_id', 'seller_city', 'seller_state'] },
  },
  executeQuery: vi.fn(({ sql }) => {
    // Revenue monthly query (GMV)
    if (sql.includes('SUBSTR') && sql.includes('order_purchase_timestamp') && sql.includes('SUM(oi.price)')) {
      return {
        success: true,
        rows: [
          { month: '2017-01', order_count: 100, product_revenue: 15000, freight: 2000, gmv: 17000 },
          { month: '2017-02', order_count: 120, product_revenue: 18000, freight: 2500, gmv: 20500 },
          { month: '2017-03', order_count: 150, product_revenue: 22000, freight: 3000, gmv: 25000 },
        ],
        rowCount: 3,
      };
    }
    // Category revenue query (GMV)
    if (sql.includes('product_category_name_english') && sql.includes('SUM(oi.price)') && sql.includes('GROUP BY category')) {
      return {
        success: true,
        rows: [
          { category: 'electronics', product_revenue: 30000, cat_freight: 4000, gmv: 34000, items: 500 },
          { category: 'furniture', product_revenue: 20000, cat_freight: 3000, gmv: 23000, items: 300 },
          { category: 'toys', product_revenue: 10000, cat_freight: 1500, gmv: 11500, items: 200 },
        ],
        rowCount: 3,
      };
    }
    // Payment total
    if (sql.includes('SUM(payment_value) AS total_payment')) {
      return { success: true, rows: [{ total_payment: 55000 }], rowCount: 1 };
    }
    // RFM query
    if (sql.includes('customer_unique_id') && sql.includes('frequency') && sql.includes('monetary')) {
      return {
        success: true,
        rows: [
          { customer_unique_id: 'c1', frequency: 5, monetary: 500, last_purchase: '2018-07-01' },
          { customer_unique_id: 'c2', frequency: 1, monetary: 50, last_purchase: '2017-01-15' },
          { customer_unique_id: 'c3', frequency: 3, monetary: 300, last_purchase: '2018-06-01' },
          { customer_unique_id: 'c4', frequency: 2, monetary: 150, last_purchase: '2018-03-01' },
          { customer_unique_id: 'c5', frequency: 1, monetary: 30, last_purchase: '2017-06-01' },
        ],
        rowCount: 5,
      };
    }
    // Delivery rows
    if (sql.includes('order_delivered_customer_date') && sql.includes('order_estimated_delivery_date') && !sql.includes('customer_state')) {
      return {
        success: true,
        rows: [
          { order_id: 'o1', order_delivered_customer_date: '2018-01-10', order_estimated_delivery_date: '2018-01-15', order_delivered_carrier_date: '2018-01-05', order_approved_at: '2018-01-02' },
          { order_id: 'o2', order_delivered_customer_date: '2018-01-20', order_estimated_delivery_date: '2018-01-18', order_delivered_carrier_date: '2018-01-12', order_approved_at: '2018-01-08' },
          { order_id: 'o3', order_delivered_customer_date: '2018-02-05', order_estimated_delivery_date: '2018-02-01', order_delivered_carrier_date: '2018-01-28', order_approved_at: '2018-01-25' },
        ],
        rowCount: 3,
      };
    }
    // Delivery by state
    if (sql.includes('customer_state') && sql.includes('total_count')) {
      return {
        success: true,
        rows: [
          { state: 'SP', total_count: 100, on_time: 85 },
          { state: 'RJ', total_count: 50, on_time: 40 },
        ],
        rowCount: 2,
      };
    }
    // Seller count
    if (sql.includes('COUNT(DISTINCT s.seller_id) AS total_sellers')) {
      return { success: true, rows: [{ total_sellers: 50, states: 10 }], rowCount: 1 };
    }
    // Top sellers
    if (sql.includes('seller_id') && sql.includes('revenue') && sql.includes('avg_score')) {
      return {
        success: true,
        rows: [
          { seller_id: 's1', seller_city: 'São Paulo', seller_state: 'SP', order_count: 200, revenue: 50000, avg_score: 4.5 },
          { seller_id: 's2', seller_city: 'Rio', seller_state: 'RJ', order_count: 100, revenue: 25000, avg_score: 4.0 },
        ],
        rowCount: 2,
      };
    }
    // Seller state concentration
    if (sql.includes('seller_state AS state') && sql.includes('seller_count')) {
      return {
        success: true,
        rows: [
          { state: 'SP', seller_count: 30, revenue: 60000 },
          { state: 'RJ', seller_count: 10, revenue: 20000 },
        ],
        rowCount: 2,
      };
    }
    // Category with order_count / items_sold / avg_price
    if (sql.includes('items_sold') || sql.includes('avg_price')) {
      return {
        success: true,
        rows: [
          { category: 'electronics', order_count: 300, revenue: 45000, items_sold: 500, avg_price: 90 },
          { category: 'furniture', order_count: 150, revenue: 22000, items_sold: 200, avg_price: 110 },
        ],
        rowCount: 2,
      };
    }
    // Category monthly (seasonality)
    if (sql.includes('category') && sql.includes('month') && sql.includes('GROUP BY category, month')) {
      return {
        success: true,
        rows: [
          { category: 'electronics', month: '2017-01', revenue: 5000 },
          { category: 'electronics', month: '2017-02', revenue: 6000 },
        ],
        rowCount: 2,
      };
    }
    // Review score distribution
    if (sql.includes('review_score AS score') && sql.includes('GROUP BY review_score')) {
      return {
        success: true,
        rows: [
          { score: 1, cnt: 50 },
          { score: 2, cnt: 30 },
          { score: 3, cnt: 40 },
          { score: 4, cnt: 80 },
          { score: 5, cnt: 200 },
        ],
        rowCount: 5,
      };
    }
    // Delivery-satisfaction correlation
    if (sql.includes('delivery_status') && sql.includes('avg_score')) {
      return {
        success: true,
        rows: [
          { delivery_status: 'on_time', avg_score: 4.3, cnt: 300 },
          { delivery_status: 'late', avg_score: 2.8, cnt: 100 },
        ],
        rowCount: 2,
      };
    }
    // Review response time
    if (sql.includes('avg_response_days')) {
      return { success: true, rows: [{ avg_response_days: 3.5 }], rowCount: 1 };
    }
    // Payment types
    if (sql.includes('payment_type') && sql.includes('tx_count') && !sql.includes('payment_installments') && !sql.includes('month')) {
      return {
        success: true,
        rows: [
          { payment_type: 'credit_card', tx_count: 500, total_value: 40000, avg_value: 80 },
          { payment_type: 'boleto', tx_count: 200, total_value: 12000, avg_value: 60 },
          { payment_type: 'voucher', tx_count: 50, total_value: 3000, avg_value: 60 },
        ],
        rowCount: 3,
      };
    }
    // Installment distribution
    if (sql.includes('payment_installments') && sql.includes('credit_card')) {
      return {
        success: true,
        rows: [
          { installments: 1, tx_count: 200, total_value: 15000 },
          { installments: 2, tx_count: 100, total_value: 10000 },
          { installments: 3, tx_count: 80, total_value: 8000 },
          { installments: 6, tx_count: 50, total_value: 5000 },
          { installments: 10, tx_count: 30, total_value: 4000 },
        ],
        rowCount: 5,
      };
    }
    // Monthly payment trend
    if (sql.includes('payment_type') && sql.includes('month')) {
      return {
        success: true,
        rows: [
          { month: '2017-01', payment_type: 'credit_card', total_value: 10000 },
          { month: '2017-02', payment_type: 'credit_card', total_value: 12000 },
        ],
        rowCount: 2,
      };
    }
    // Default fallback
    return { success: true, rows: [], rowCount: 0 };
  }),
}));

import {
  analyzeRevenueTrend,
  analyzeCustomerRFM,
  analyzeDeliveryPerformance,
  analyzeSellerScorecard,
  analyzeCategoryInsights,
  analyzeCustomerSatisfaction,
  analyzePaymentBehavior,
  detectAndRunAnalysis,
  buildAnalysisInsightPrompt,
  buildDataProfile,
  computeDerivedMetrics,
  computeCrossInsights,
  suggestDeepDives,
} from './olistAnalysisService';

// ── Shared shape validator ──────────────────────────────────────────────────

function assertAnalysisShape(result, expectedType) {
  expect(result).toBeDefined();
  expect(result.analysisType).toBe(expectedType);
  expect(typeof result.title).toBe('string');
  expect(result.title.length).toBeGreaterThan(0);
  expect(typeof result.summary).toBe('string');
  expect(typeof result.metrics).toBe('object');
  expect(Array.isArray(result.charts)).toBe(true);
  expect(Array.isArray(result.tables)).toBe(true);
  expect(Array.isArray(result.highlights)).toBe(true);
  expect(Array.isArray(result.details)).toBe(true);
}

function assertChartShape(chart) {
  expect(['bar', 'line', 'pie']).toContain(chart.type);
  expect(Array.isArray(chart.data)).toBe(true);
  expect(typeof chart.xKey).toBe('string');
  expect(typeof chart.yKey).toBe('string');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('olistAnalysisService', () => {
  describe('analyzeRevenueTrend', () => {
    it('returns correct shape', async () => {
      const result = await analyzeRevenueTrend();
      assertAnalysisShape(result, 'revenue');
    });

    it('calculates GMV-based metrics correctly', async () => {
      const result = await analyzeRevenueTrend();
      expect(result.metrics['Total Orders']).toBe('370');
      expect(result.metrics.Months).toBe(3);
      // GMV = 17000 + 20500 + 25000 = 62500
      expect(result.metrics['Total Revenue (GMV)']).toMatch(/R\$62,500/);
      // Product Revenue = 15000 + 18000 + 22000 = 55000
      expect(result.metrics['Product Revenue']).toMatch(/R\$55,000/);
      // AOV = GMV / orders = 62500 / 370 ≈ 168.9
      expect(result.metrics['Avg Order Value']).toMatch(/R\$168/);
      // Freight % = 7500 / 62500 = 12%
      expect(result.metrics['Freight %']).toMatch(/12/);
      expect(result.charts.length).toBeGreaterThanOrEqual(1);
      expect(result.tables.length).toBe(1);
    });

    it('chart data includes all required fields', async () => {
      const result = await analyzeRevenueTrend();
      const chartPoint = result.charts[0].data[0];
      expect(chartPoint).toHaveProperty('month');
      expect(chartPoint).toHaveProperty('revenue');        // GMV
      expect(chartPoint).toHaveProperty('product_revenue');
      expect(chartPoint).toHaveProperty('freight');
      expect(chartPoint).toHaveProperty('orders');
    });

    it('includes _categoryRevenues and _revenueDefinition', async () => {
      const result = await analyzeRevenueTrend();
      expect(result._revenueDefinition).toBe('GMV = product price + freight');
      expect(Array.isArray(result._categoryRevenues)).toBe(true);
      expect(result._categoryRevenues[0]).toHaveProperty('category');
      expect(result._categoryRevenues[0]).toHaveProperty('revenue');
    });

    it('charts have correct shape', async () => {
      const result = await analyzeRevenueTrend();
      for (const chart of result.charts) {
        assertChartShape(chart);
      }
    });
  });

  describe('analyzeCustomerRFM', () => {
    it('returns correct shape', async () => {
      const result = await analyzeCustomerRFM();
      assertAnalysisShape(result, 'rfm');
    });

    it('segments customers', async () => {
      const result = await analyzeCustomerRFM();
      expect(result.metrics['Total Customers']).toBe('5');
      expect(result.tables[0].rows.length).toBe(5); // 5 segments
    });
  });

  describe('analyzeDeliveryPerformance', () => {
    it('returns correct shape', async () => {
      const result = await analyzeDeliveryPerformance();
      assertAnalysisShape(result, 'delivery');
    });

    it('calculates on-time rate', async () => {
      const result = await analyzeDeliveryPerformance();
      expect(result.metrics['Total Delivered']).toBe('3');
      // 1 on-time (o1: delivered before estimated), 2 late
      expect(result.charts.length).toBe(2);
    });
  });

  describe('analyzeSellerScorecard', () => {
    it('returns correct shape', async () => {
      const result = await analyzeSellerScorecard();
      assertAnalysisShape(result, 'seller');
    });

    it('shows seller count', async () => {
      const result = await analyzeSellerScorecard();
      expect(result.metrics['Total Sellers']).toBe('50');
    });
  });

  describe('analyzeCategoryInsights', () => {
    it('returns correct shape', async () => {
      const result = await analyzeCategoryInsights();
      assertAnalysisShape(result, 'category');
    });

    it('calculates Pareto', async () => {
      const result = await analyzeCategoryInsights();
      expect(result.metrics['Total Categories']).toBeGreaterThan(0);
      expect(result.metrics['Pareto (80%)']).toBeDefined();
    });
  });

  describe('analyzeCustomerSatisfaction', () => {
    it('returns correct shape', async () => {
      const result = await analyzeCustomerSatisfaction();
      assertAnalysisShape(result, 'satisfaction');
    });

    it('calculates avg score', async () => {
      const result = await analyzeCustomerSatisfaction();
      const avgScore = parseFloat(result.metrics['Avg Score']);
      expect(avgScore).toBeGreaterThan(0);
      expect(avgScore).toBeLessThanOrEqual(5);
    });

    it('shows delivery correlation', async () => {
      const result = await analyzeCustomerSatisfaction();
      expect(result.metrics['On-Time Avg Score']).toBeDefined();
      expect(result.metrics['Late Avg Score']).toBeDefined();
    });
  });

  describe('analyzePaymentBehavior', () => {
    it('returns correct shape', async () => {
      const result = await analyzePaymentBehavior();
      assertAnalysisShape(result, 'payment');
    });

    it('shows payment types', async () => {
      const result = await analyzePaymentBehavior();
      expect(result.metrics['Payment Types']).toBe(3);
      expect(result.tables[0].rows.length).toBe(3);
    });
  });

  describe('detectAndRunAnalysis', () => {
    it('detects revenue keywords (EN)', async () => {
      const result = await detectAndRunAnalysis('show me revenue trends');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('revenue');
    });

    it('detects revenue keywords (ZH)', async () => {
      const result = await detectAndRunAnalysis('分析營收趨勢');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('revenue');
    });

    it('detects RFM keywords', async () => {
      const result = await detectAndRunAnalysis('customer segmentation RFM');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('rfm');
    });

    it('detects delivery keywords (ZH)', async () => {
      const result = await detectAndRunAnalysis('物流配送表現如何');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('delivery');
    });

    it('detects seller keywords', async () => {
      const result = await detectAndRunAnalysis('seller performance scorecard');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('seller');
    });

    it('detects category keywords', async () => {
      const result = await detectAndRunAnalysis('product category analysis');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('category');
    });

    it('detects satisfaction keywords', async () => {
      const result = await detectAndRunAnalysis('customer satisfaction ratings');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('satisfaction');
    });

    it('detects payment keywords (ZH)', async () => {
      const result = await detectAndRunAnalysis('付款方式分析');
      expect(result).not.toBeNull();
      expect(result.analysisType).toBe('payment');
    });

    it('returns null for unrelated queries', async () => {
      const result = await detectAndRunAnalysis('what is the weather today');
      expect(result).toBeNull();
    });

    it('returns null for empty input', async () => {
      expect(await detectAndRunAnalysis('')).toBeNull();
      expect(await detectAndRunAnalysis(null)).toBeNull();
      expect(await detectAndRunAnalysis('ab')).toBeNull(); // too short
    });
  });

  describe('buildAnalysisInsightPrompt (v3)', () => {
    it('returns systemPrompt and userPrompt with data profile + derived + cross', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      const cross = { queries: [{ label: 'test', data: [{ x: 1 }] }], summary: 'test' };
      const { systemPrompt, userPrompt } = buildAnalysisInsightPrompt(result, derived, cross);
      expect(systemPrompt).toContain('DO NOT repeat');
      expect(systemPrompt).toContain('risk_alerts');
      expect(systemPrompt).toContain('METHODOLOGY NOTES');
      expect(systemPrompt).toContain('GMV');
      expect(userPrompt).toContain('Data Profile');
      expect(userPrompt).toContain('Available Tables');
      expect(userPrompt).toContain('Raw Monthly Data');
      expect(userPrompt).toContain('Derived Metrics');
      expect(userPrompt).toContain('Cross-Analysis');
    });

    it('includes card metrics and data profile', async () => {
      const result = await analyzeRevenueTrend();
      const { userPrompt } = buildAnalysisInsightPrompt(result, {}, { queries: [] });
      expect(userPrompt).toContain('Already on the data card');
      expect(userPrompt).toContain('Total Orders');
      expect(userPrompt).toContain('Revenue definition: GMV');
      expect(userPrompt).toContain('customer_id'); // from table schema
    });

    it('handles empty derived and cross gracefully', () => {
      const { systemPrompt, userPrompt } = buildAnalysisInsightPrompt({
        analysisType: 'test', title: 'Test', summary: 'Empty',
        metrics: {}, charts: [], tables: [], highlights: [], details: [],
      }, {}, { queries: [] });
      expect(systemPrompt.length).toBeGreaterThan(0);
      expect(userPrompt).toContain('Test');
    });
  });

  describe('computeDerivedMetrics', () => {
    it('computes revenue derived metrics with correct fields', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      expect(derived).toBeDefined();
      // All 3 mock months have >= 10 orders, so all should be included
      expect(derived.mom_growth_median).toBeDefined();
      expect(derived.mom_growth_mean).toBeDefined();
      expect(derived.peak_month).toBe('2017-03');
      expect(derived.peak_vs_avg).toMatch(/^\+\d+%$/);
      expect(derived.volatility).toBeDefined();
      expect(derived.volatility_cv).toBeDefined();
    });

    it('computes aov_trend and freight_trend (no longer broken)', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      // With 3 valid months, aov_trend should be computed
      expect(derived.aov_trend).toBeDefined();
      expect(['rising', 'declining', 'stable']).toContain(derived.aov_trend);
      // freight_trend should also work now that chart data has freight field
      expect(derived.freight_trend).toBeDefined();
      expect(['improving', 'worsening', 'stable']).toContain(derived.freight_trend);
    });

    it('uses _categoryRevenues for top3_concentration', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      // top3 GMV = 34000 + 23000 + 11500 = 68500; total GMV = 62500
      // Concentration = 68500 / 62500 > 100% because categories include all orders not just the 3 months
      // What matters is it's computed (not regex-parsed)
      expect(derived.top3_concentration).toBeDefined();
      expect(derived.top3_concentration).toMatch(/^\d+\.\d+%$/);
    });

    it('excludes sparse months from calculations', () => {
      const result = {
        metrics: { 'Total Revenue (GMV)': 'R$100,000' },
        charts: [{
          data: [
            { month: '2016-09', revenue: 300, product_revenue: 250, freight: 50, orders: 1 },
            { month: '2017-01', revenue: 50000, product_revenue: 42000, freight: 8000, orders: 500 },
            { month: '2017-02', revenue: 50000, product_revenue: 42000, freight: 8000, orders: 600 },
          ],
        }],
        tables: [],
        _categoryRevenues: [],
      };
      const derived = computeDerivedMetrics('revenue', result);
      // 2016-09 should be excluded (1 order < 10 threshold)
      expect(derived._excluded_months).toBeDefined();
      expect(derived._excluded_months[0]).toContain('2016-09');
      // Growth should be based on only the 2 valid months
      expect(derived.mom_growth_median).toBeDefined();
    });

    it('computes rfm derived metrics', async () => {
      const result = await analyzeCustomerRFM();
      const derived = computeDerivedMetrics('rfm', result);
      expect(derived).toBeDefined();
    });

    it('computes delivery derived metrics', async () => {
      const result = await analyzeDeliveryPerformance();
      const derived = computeDerivedMetrics('delivery', result);
      expect(derived).toBeDefined();
    });

    it('computes satisfaction derived metrics', async () => {
      const result = await analyzeCustomerSatisfaction();
      const derived = computeDerivedMetrics('satisfaction', result);
      expect(derived).toBeDefined();
    });

    it('handles unknown type gracefully', () => {
      const derived = computeDerivedMetrics('unknown', { metrics: {}, charts: [], tables: [] });
      expect(derived).toEqual({});
    });
  });

  describe('buildDataProfile', () => {
    it('returns data profile with tables from SAP_TABLE_REGISTRY', async () => {
      const result = await analyzeRevenueTrend();
      const profile = buildDataProfile(result);
      expect(profile.dataset).toContain('Olist');
      expect(profile.revenue_definition).toBe('GMV = product price + freight');
      expect(profile.date_range).toBe('2017-01 to 2017-03');
      expect(profile.total_months).toBe(3);
      expect(Array.isArray(profile.tables)).toBe(true);
      expect(profile.tables.length).toBeGreaterThan(0);
      expect(profile.tables[0]).toContain('customer_id'); // customers table
    });

    it('detects sparse months', () => {
      const result = {
        charts: [{
          data: [
            { month: '2016-09', orders: 1 },
            { month: '2017-01', orders: 500 },
          ],
        }],
        _revenueDefinition: 'test',
      };
      const profile = buildDataProfile(result);
      expect(profile.sparse_months.length).toBe(1);
      expect(profile.sparse_months[0]).toContain('2016-09');
    });
  });

  describe('suggestDeepDives', () => {
    it('returns 2-3 suggestions for revenue', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      const suggestions = suggestDeepDives('revenue', result, derived, { queries: [] });
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions.length).toBeLessThanOrEqual(3);
      expect(suggestions[0]).toHaveProperty('id');
      expect(suggestions[0]).toHaveProperty('label');
      expect(suggestions[0]).toHaveProperty('query');
    });

    it('returns suggestions for each analysis type', async () => {
      const types = ['rfm', 'delivery', 'seller', 'category', 'satisfaction', 'payment'];
      for (const type of types) {
        const suggestions = suggestDeepDives(type, { metrics: {}, charts: [], tables: [], details: [] }, {}, { queries: [] });
        expect(Array.isArray(suggestions)).toBe(true);
        expect(suggestions.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('returns English labels when userQuery is in English', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      const suggestions = suggestDeepDives('revenue', result, derived, { queries: [] }, 'analyze revenue trends');
      expect(suggestions[0].label).toMatch(/[A-Za-z]/);
      expect(suggestions[0].label).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('returns Chinese labels when userQuery is in Chinese', async () => {
      const result = await analyzeRevenueTrend();
      const derived = computeDerivedMetrics('revenue', result);
      const suggestions = suggestDeepDives('revenue', result, derived, { queries: [] }, '分析營收趨勢');
      expect(suggestions[0].label).toMatch(/[\u4e00-\u9fff]/);
    });
  });
});
