/**
 * olistAnalysisService.js
 *
 * Structured analysis functions for the Olist e-commerce dataset.
 * Each function runs SQL via sapDataQueryService and post-processes results
 * into a unified shape for AnalysisResultCard rendering.
 *
 * Exported functions (7 analyses):
 *   analyzeRevenueTrend, analyzeCustomerRFM, analyzeDeliveryPerformance,
 *   analyzeSellerScorecard, analyzeCategoryInsights, analyzeCustomerSatisfaction,
 *   analyzePaymentBehavior
 *
 * Plus: detectAndRunAnalysis — keyword-based dispatcher for chat intent routing.
 */

import { executeQuery, SAP_TABLE_REGISTRY } from './sapDataQueryService.js';

// ── Keyword matchers for detectAndRunAnalysis ────────────────────────────────

const ANALYSIS_MATCHERS = [
  {
    id: 'revenue',
    fn: () => analyzeRevenueTrend(),
    keywords: /(?:\b(?:revenue|sales.?trend|aov|average.?order|turnover|gmv)\b|營收|銷售趨勢|客單價|銷售額|月營收|營業額)/i,
  },
  {
    id: 'rfm',
    fn: () => analyzeCustomerRFM(),
    keywords: /(?:\b(?:rfm|customer.?segment|retention|repurchase|churn|cohort)\b|留存|回購|客戶分群|流失|客戶價值|客群)/i,
  },
  {
    id: 'delivery',
    fn: () => analyzeDeliveryPerformance(),
    keywords: /(?:\b(?:deliver|logistics|shipping|on.?time|delay|lead.?time|sla)\b|配送|物流|準時率|延遲|出貨|到貨)/i,
  },
  {
    id: 'seller',
    fn: () => analyzeSellerScorecard(),
    keywords: /(?:\b(?:seller|vendor|merchant.?perf|seller.?score|supplier.?rank)\b|賣家|供應商|績效|出貨速度|商家)/i,
  },
  {
    id: 'category',
    fn: () => analyzeCategoryInsights(),
    keywords: /(?:\b(?:category|product.?mix|sku.?analysis|seasonal|pareto)\b|品類|商品分析|季節性|成長率|產品類別)/i,
  },
  {
    id: 'satisfaction',
    fn: () => analyzeCustomerSatisfaction(),
    keywords: /(?:\b(?:satisf\w*|review.?score|nps|csat|rating|comment|sentiment)\b|滿意度|評分|評論|好評|差評|客訴)/i,
  },
  {
    id: 'payment',
    fn: () => analyzePaymentBehavior(),
    keywords: /(?:\b(?:payment|installment|credit.?card|boleto|voucher)\b|付款|分期|信用卡|支付方式|付款行為)/i,
  },
];

/**
 * Detect if a user query matches a known analysis type and run it.
 * Returns the analysis result or null if no match.
 */
export async function detectAndRunAnalysis(userQuery) {
  if (!userQuery || typeof userQuery !== 'string') return null;
  const q = userQuery.trim();
  if (q.length < 3) return null;

  for (const matcher of ANALYSIS_MATCHERS) {
    if (matcher.keywords.test(q)) {
      try {
        _startCapture();
        const result = await matcher.fn();
        const queries = _flushCapture();
        // Attach methodology transparency
        result._methodology = {
          dataSources: _extractTablesFromQueries(queries),
          queries,
          engine: 'AlaSQL (in-browser)',
        };
        return result;
      } catch (err) {
        _flushCapture(); // discard on error
        console.error(`[olistAnalysisService] ${matcher.id} analysis failed:`, err?.message);
        return {
          analysisType: matcher.id,
          title: `${matcher.id} analysis failed`,
          summary: `Error: ${err?.message || 'Unknown error'}`,
          metrics: {},
          charts: [],
          tables: [],
          highlights: [],
          details: [],
        };
      }
    }
  }
  return null;
}

// ── Helper ───────────────────────────────────────────────────────────────────

// Query capture for methodology transparency
let _capturedQueries = [];
function _startCapture() { _capturedQueries = []; }
function _flushCapture() { const q = [..._capturedQueries]; _capturedQueries = []; return q; }

function _extractTablesFromQueries(queries) {
  const tables = new Set();
  for (const q of queries) {
    for (const m of q.sql.matchAll(/\bFROM\s+(\w+)|\bJOIN\s+(\w+)/gi)) {
      tables.add(m[1] || m[2]);
    }
  }
  return [...tables];
}

async function runSql(sql) {
  const result = await executeQuery({ sql });
  if (!result.success) {
    throw new Error(result.error || 'SQL execution failed');
  }
  _capturedQueries.push({ sql: sql.trim(), rowCount: (result.rows || []).length });
  return result.rows || [];
}

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function fmt(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Wraps an analysis function to automatically capture SQL queries and attach _methodology.
 * Used when functions are called directly (e.g. via builtinToolExecutor) rather than through detectAndRunAnalysis.
 */
export function withMethodology(fn) {
  return async function (...args) {
    _startCapture();
    const result = await fn.apply(this, args);
    const queries = _flushCapture();
    if (result && typeof result === 'object' && !result._methodology) {
      result._methodology = {
        dataSources: _extractTablesFromQueries(queries),
        queries,
        engine: 'AlaSQL (in-browser)',
      };
    }
    return result;
  };
}

// ── 1. Revenue Trend ─────────────────────────────────────────────────────────

export async function analyzeRevenueTrend() {
  const [monthlyRows, categoryRows, paymentTotal] = await Promise.all([
    runSql(`
      SELECT
        SUBSTR(o.order_purchase_timestamp, 1, 7) AS month,
        COUNT(DISTINCT o.order_id) AS order_count,
        SUM(oi.price) AS product_revenue,
        SUM(oi.freight_value) AS freight,
        SUM(oi.price) + SUM(oi.freight_value) AS gmv
      FROM orders o
      JOIN order_items oi ON o.order_id = oi.order_id
      WHERE o.order_status = 'delivered'
      GROUP BY SUBSTR(o.order_purchase_timestamp, 1, 7)
      ORDER BY month
    `),
    runSql(`
      SELECT
        COALESCE(ct.product_category_name_english, p.product_category_name, 'unknown') AS category,
        SUM(oi.price) AS product_revenue,
        SUM(oi.freight_value) AS cat_freight,
        SUM(oi.price) + SUM(oi.freight_value) AS gmv,
        COUNT(*) AS items
      FROM order_items oi
      JOIN products p ON oi.product_id = p.product_id
      LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.order_status = 'delivered'
      GROUP BY category
      ORDER BY gmv DESC
      LIMIT 15
    `),
    runSql(`
      SELECT SUM(payment_value) AS total_payment FROM payments
    `),
  ]);

  const totalGmv = monthlyRows.reduce((s, r) => s + (Number(r.gmv) || 0), 0);
  const totalProductRevenue = monthlyRows.reduce((s, r) => s + (Number(r.product_revenue) || 0), 0);
  const totalOrders = monthlyRows.reduce((s, r) => s + (Number(r.order_count) || 0), 0);
  const aov = totalOrders > 0 ? totalGmv / totalOrders : 0;
  const totalFreight = monthlyRows.reduce((s, r) => s + (Number(r.freight) || 0), 0);

  return {
    analysisType: 'revenue',
    title: 'Revenue & Sales Trend Analysis',
    summary: `Analyzed ${fmt(totalOrders)} delivered orders with R$${fmt(totalGmv)} total revenue (GMV).`,
    metrics: {
      'Total Revenue (GMV)': `R$${fmt(totalGmv)}`,
      'Product Revenue': `R$${fmt(totalProductRevenue)}`,
      'Total Orders': fmt(totalOrders),
      'Avg Order Value': `R$${fmt(aov)}`,
      'Total Freight': `R$${fmt(totalFreight)}`,
      'Freight %': `${pct(totalFreight, totalGmv)}%`,
      'Months': monthlyRows.length,
    },
    charts: [
      {
        type: 'line',
        title: 'Monthly Revenue Trend (GMV)',
        data: monthlyRows.map((r) => ({
          month: r.month,
          revenue: Math.round(Number(r.gmv) || 0),
          product_revenue: Math.round(Number(r.product_revenue) || 0),
          freight: Math.round(Number(r.freight) || 0),
          orders: Number(r.order_count) || 0,
        })),
        xKey: 'month',
        yKey: 'revenue',
        label: 'Revenue / GMV (R$)',
      },
      {
        type: 'bar',
        title: 'Top 15 Categories by Revenue (GMV)',
        data: categoryRows.map((r) => ({
          category: String(r.category).slice(0, 20),
          revenue: Math.round(Number(r.gmv) || 0),
        })),
        xKey: 'category',
        yKey: 'revenue',
        label: 'Revenue / GMV (R$)',
      },
    ],
    tables: [{
      title: 'Monthly Breakdown',
      columns: ['Month', 'Orders', 'GMV', 'Product Rev', 'Freight', 'AOV'],
      rows: monthlyRows.map((r) => [
        r.month,
        fmt(r.order_count),
        `R$${fmt(r.gmv)}`,
        `R$${fmt(r.product_revenue)}`,
        `R$${fmt(r.freight)}`,
        `R$${fmt(Number(r.order_count) > 0 ? Number(r.gmv) / Number(r.order_count) : 0)}`,
      ]),
    }],
    highlights: [
      `AOV: R$${fmt(aov)}`,
      `Top category: ${categoryRows[0]?.category || 'N/A'}`,
      `Freight ratio: ${pct(totalFreight, totalGmv)}%`,
    ],
    details: categoryRows.slice(0, 5).map((r) =>
      `${r.category}: R$${fmt(r.gmv)} (${fmt(r.items)} items)`
    ),
    _revenueDefinition: 'GMV = product price + freight',
    _categoryRevenues: categoryRows.map((r) => ({
      category: r.category,
      revenue: Number(r.gmv) || 0,
    })),
  };
}

// ── 2. Customer RFM ──────────────────────────────────────────────────────────

export async function analyzeCustomerRFM() {
  const rows = await runSql(`
    SELECT
      c.customer_unique_id,
      COUNT(DISTINCT o.order_id) AS frequency,
      SUM(oi.price) AS monetary,
      MAX(o.order_purchase_timestamp) AS last_purchase
    FROM customers c
    JOIN orders o ON c.customer_id = o.customer_id
    JOIN order_items oi ON o.order_id = oi.order_id
    WHERE o.order_status = 'delivered'
    GROUP BY c.customer_unique_id
  `);

  const totalCustomers = rows.length;
  if (totalCustomers === 0) {
    return {
      analysisType: 'rfm', title: 'Customer RFM Analysis', summary: 'No customer data found.',
      metrics: {}, charts: [], tables: [], highlights: [], details: [],
    };
  }

  // Find reference date (max date in dataset)
  const maxDate = rows.reduce((m, r) => r.last_purchase > m ? r.last_purchase : m, '');
  const refDate = new Date(maxDate);

  // Score each customer (simple tercile-based)
  const monetaryValues = rows.map((r) => Number(r.monetary) || 0).sort((a, b) => a - b);
  const freqValues = rows.map((r) => Number(r.frequency) || 0).sort((a, b) => a - b);
  const m33 = monetaryValues[Math.floor(totalCustomers * 0.33)];
  const m66 = monetaryValues[Math.floor(totalCustomers * 0.66)];
  const f33 = freqValues[Math.floor(totalCustomers * 0.33)];
  const f66 = freqValues[Math.floor(totalCustomers * 0.66)];

  const segments = { Champions: 0, Loyal: 0, Potential: 0, AtRisk: 0, Lost: 0 };
  let totalMonetary = 0;
  let repeatBuyers = 0;

  for (const r of rows) {
    const freq = Number(r.frequency) || 0;
    const mon = Number(r.monetary) || 0;
    const daysSince = Math.max(0, (refDate - new Date(r.last_purchase)) / 86400000);
    totalMonetary += mon;
    if (freq > 1) repeatBuyers++;

    // Simple segmentation
    if (freq > f66 && mon > m66 && daysSince < 90) segments.Champions++;
    else if (freq > f66 && mon > m33) segments.Loyal++;
    else if (freq <= f33 && mon <= m33 && daysSince > 180) segments.Lost++;
    else if (daysSince > 120) segments.AtRisk++;
    else segments.Potential++;
  }

  const repurchaseRate = pct(repeatBuyers, totalCustomers);
  const avgMonetary = totalMonetary / totalCustomers;

  return {
    analysisType: 'rfm',
    title: 'Customer RFM Segmentation',
    summary: `Segmented ${fmt(totalCustomers)} unique customers into 5 groups based on Recency, Frequency, and Monetary value.`,
    metrics: {
      'Total Customers': fmt(totalCustomers),
      'Repeat Buyers': fmt(repeatBuyers),
      'Repurchase Rate': `${repurchaseRate}%`,
      'Avg Monetary': `R$${fmt(avgMonetary)}`,
      'Champions': fmt(segments.Champions),
      'At-Risk': fmt(segments.AtRisk),
    },
    charts: [
      {
        type: 'bar',
        title: 'Customer Segments',
        data: Object.entries(segments).map(([name, count]) => ({ segment: name, count })),
        xKey: 'segment',
        yKey: 'count',
        label: 'Customers',
      },
    ],
    tables: [{
      title: 'Segment Distribution',
      columns: ['Segment', 'Count', '% of Total'],
      rows: Object.entries(segments).map(([name, count]) => [
        name,
        fmt(count),
        `${pct(count, totalCustomers)}%`,
      ]),
    }],
    highlights: [
      `Repurchase rate: ${repurchaseRate}%`,
      `Champions: ${fmt(segments.Champions)} customers`,
      `At-Risk: ${fmt(segments.AtRisk)} need re-engagement`,
    ],
    details: [
      `Champions (high F, high M, recent): ${fmt(segments.Champions)}`,
      `Loyal (high F, moderate+ M): ${fmt(segments.Loyal)}`,
      `Potential (moderate activity): ${fmt(segments.Potential)}`,
      `At-Risk (inactive >120 days): ${fmt(segments.AtRisk)}`,
      `Lost (low F, low M, inactive >180 days): ${fmt(segments.Lost)}`,
    ],
  };
}

// ── 3. Delivery Performance ──────────────────────────────────────────────────

export async function analyzeDeliveryPerformance() {
  const [deliveryRows, stateRows] = await Promise.all([
    runSql(`
      SELECT
        order_id,
        order_delivered_customer_date,
        order_estimated_delivery_date,
        order_delivered_carrier_date,
        order_approved_at
      FROM orders
      WHERE order_status = 'delivered'
        AND order_delivered_customer_date IS NOT NULL
        AND order_estimated_delivery_date IS NOT NULL
    `),
    runSql(`
      SELECT
        c.customer_state AS state,
        COUNT(*) AS total_count,
        SUM(CASE WHEN o.order_delivered_customer_date <= o.order_estimated_delivery_date THEN 1 ELSE 0 END) AS on_time
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
      WHERE o.order_status = 'delivered'
        AND o.order_delivered_customer_date IS NOT NULL
        AND o.order_estimated_delivery_date IS NOT NULL
      GROUP BY c.customer_state
      ORDER BY total_count DESC
      LIMIT 15
    `),
  ]);

  let onTime = 0;
  let totalDelayDays = 0;
  let earlyCount = 0;
  const delayBuckets = { '0 (on-time)': 0, '1-3 days': 0, '4-7 days': 0, '8-14 days': 0, '15+ days': 0 };
  const deliveryDays = [];

  for (const r of deliveryRows) {
    const delivered = new Date(r.order_delivered_customer_date);
    const estimated = new Date(r.order_estimated_delivery_date);
    const diffDays = Math.round((delivered - estimated) / 86400000);

    if (diffDays <= 0) {
      onTime++;
      delayBuckets['0 (on-time)']++;
      if (diffDays < 0) earlyCount++;
    } else if (diffDays <= 3) delayBuckets['1-3 days']++;
    else if (diffDays <= 7) delayBuckets['4-7 days']++;
    else if (diffDays <= 14) delayBuckets['8-14 days']++;
    else delayBuckets['15+ days']++;

    if (diffDays > 0) totalDelayDays += diffDays;

    // Calculate total delivery days (from approved to delivered)
    if (r.order_approved_at) {
      const approved = new Date(r.order_approved_at);
      const ddays = Math.round((delivered - approved) / 86400000);
      if (ddays > 0 && ddays < 365) deliveryDays.push(ddays);
    }
  }

  const total = deliveryRows.length;
  const lateCount = total - onTime;
  const avgDeliveryDays = deliveryDays.length > 0
    ? deliveryDays.reduce((s, d) => s + d, 0) / deliveryDays.length
    : 0;
  const avgDelayDays = lateCount > 0 ? totalDelayDays / lateCount : 0;

  return {
    analysisType: 'delivery',
    title: 'Delivery Performance Analysis',
    summary: `Analyzed ${fmt(total)} delivered orders. On-time rate: ${pct(onTime, total)}%.`,
    metrics: {
      'Total Delivered': fmt(total),
      'On-Time Rate': `${pct(onTime, total)}%`,
      'Early Delivery': fmt(earlyCount),
      'Late Delivery': fmt(lateCount),
      'Avg Delivery Days': fmt(avgDeliveryDays),
      'Avg Delay (late only)': `${fmt(avgDelayDays)} days`,
    },
    charts: [
      {
        type: 'bar',
        title: 'Delay Distribution',
        data: Object.entries(delayBuckets).map(([bucket, count]) => ({ bucket, count })),
        xKey: 'bucket',
        yKey: 'count',
        label: 'Orders',
      },
      {
        type: 'bar',
        title: 'On-Time Rate by State (Top 15)',
        data: stateRows.map((r) => ({
          state: r.state,
          onTimeRate: pct(Number(r.on_time) || 0, Number(r.total_count) || 1),
        })),
        xKey: 'state',
        yKey: 'onTimeRate',
        label: 'On-Time %',
      },
    ],
    tables: [{
      title: 'State Performance',
      columns: ['State', 'Total Orders', 'On-Time', 'On-Time Rate'],
      rows: stateRows.map((r) => [
        r.state,
        fmt(r.total_count),
        fmt(r.on_time),
        `${pct(Number(r.on_time) || 0, Number(r.total_count) || 1)}%`,
      ]),
    }],
    highlights: [
      `On-time: ${pct(onTime, total)}%`,
      `Avg delivery: ${fmt(avgDeliveryDays)} days`,
      `${fmt(earlyCount)} orders delivered early`,
    ],
    details: Object.entries(delayBuckets).map(([b, c]) =>
      `${b}: ${fmt(c)} orders (${pct(c, total)}%)`
    ),
  };
}

// ── 4. Seller Scorecard ──────────────────────────────────────────────────────

export async function analyzeSellerScorecard() {
  const [sellerRows, topSellers] = await Promise.all([
    runSql(`
      SELECT COUNT(DISTINCT s.seller_id) AS total_sellers,
             COUNT(DISTINCT s.seller_state) AS states
      FROM sellers s
    `),
    runSql(`
      SELECT
        s.seller_id,
        s.seller_city,
        s.seller_state,
        COUNT(DISTINCT oi.order_id) AS order_count,
        SUM(oi.price) AS revenue,
        AVG(r.review_score) AS avg_score
      FROM sellers s
      JOIN order_items oi ON s.seller_id = oi.seller_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN reviews r ON o.order_id = r.order_id
      WHERE o.order_status = 'delivered'
      GROUP BY s.seller_id, s.seller_city, s.seller_state
      ORDER BY revenue DESC
      LIMIT 20
    `),
  ]);

  const stateConcentration = await runSql(`
    SELECT
      s.seller_state AS state,
      COUNT(DISTINCT s.seller_id) AS seller_count,
      SUM(oi.price) AS revenue
    FROM sellers s
    JOIN order_items oi ON s.seller_id = oi.seller_id
    JOIN orders o ON oi.order_id = o.order_id
    WHERE o.order_status = 'delivered'
    GROUP BY s.seller_state
    ORDER BY revenue DESC
    LIMIT 10
  `);

  const totalSellers = Number(sellerRows[0]?.total_sellers) || 0;
  const totalRevenue = topSellers.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const top5Revenue = topSellers.slice(0, 5).reduce((s, r) => s + (Number(r.revenue) || 0), 0);

  return {
    analysisType: 'seller',
    title: 'Seller Performance Scorecard',
    summary: `${fmt(totalSellers)} active sellers across ${sellerRows[0]?.states || '?'} states. Top 5 sellers account for ${pct(top5Revenue, totalRevenue)}% of top-20 revenue.`,
    metrics: {
      'Total Sellers': fmt(totalSellers),
      'States': sellerRows[0]?.states || 0,
      'Top 5 Revenue %': `${pct(top5Revenue, totalRevenue)}%`,
      'Top Seller Revenue': `R$${fmt(topSellers[0]?.revenue)}`,
    },
    charts: [
      {
        type: 'bar',
        title: 'Top 20 Sellers by Revenue',
        data: topSellers.map((r, i) => ({
          seller: `#${i + 1}`,
          revenue: Math.round(Number(r.revenue) || 0),
        })),
        xKey: 'seller',
        yKey: 'revenue',
        label: 'Revenue (R$)',
      },
      {
        type: 'bar',
        title: 'Revenue by State (Top 10)',
        data: stateConcentration.map((r) => ({
          state: r.state,
          revenue: Math.round(Number(r.revenue) || 0),
        })),
        xKey: 'state',
        yKey: 'revenue',
        label: 'Revenue (R$)',
      },
    ],
    tables: [{
      title: 'Top 20 Sellers',
      columns: ['Rank', 'City', 'State', 'Orders', 'Revenue', 'Avg Score'],
      rows: topSellers.map((r, i) => [
        `#${i + 1}`,
        r.seller_city || '',
        r.seller_state || '',
        fmt(r.order_count),
        `R$${fmt(r.revenue)}`,
        r.avg_score != null ? Number(r.avg_score).toFixed(1) : 'N/A',
      ]),
    }],
    highlights: [
      `${fmt(totalSellers)} sellers in ${sellerRows[0]?.states} states`,
      `Top seller: R$${fmt(topSellers[0]?.revenue)}`,
      `Concentration: top 5 = ${pct(top5Revenue, totalRevenue)}%`,
    ],
    details: topSellers.slice(0, 5).map((r, i) =>
      `#${i + 1}: ${r.seller_city}, ${r.seller_state} — R$${fmt(r.revenue)} (${fmt(r.order_count)} orders, avg score ${r.avg_score != null ? Number(r.avg_score).toFixed(1) : 'N/A'})`
    ),
  };
}

// ── 5. Category Insights ─────────────────────────────────────────────────────

export async function analyzeCategoryInsights() {
  const [categoryRows, monthlyRows] = await Promise.all([
    runSql(`
      SELECT
        COALESCE(ct.product_category_name_english, p.product_category_name, 'unknown') AS category,
        COUNT(DISTINCT oi.order_id) AS order_count,
        SUM(oi.price) AS revenue,
        COUNT(*) AS items_sold,
        AVG(oi.price) AS avg_price
      FROM order_items oi
      JOIN products p ON oi.product_id = p.product_id
      LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.order_status = 'delivered'
      GROUP BY category
      ORDER BY revenue DESC
      LIMIT 20
    `),
    runSql(`
      SELECT
        COALESCE(ct.product_category_name_english, p.product_category_name, 'unknown') AS category,
        SUBSTR(o.order_purchase_timestamp, 1, 7) AS month,
        SUM(oi.price) AS revenue
      FROM order_items oi
      JOIN products p ON oi.product_id = p.product_id
      LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.order_status = 'delivered'
      GROUP BY category, month
      ORDER BY category, month
    `),
  ]);

  const totalRevenue = categoryRows.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const totalCategories = categoryRows.length;

  // Pareto: what % of categories drive 80% of revenue
  let cumRev = 0;
  let paretoCount = 0;
  for (const r of categoryRows) {
    cumRev += Number(r.revenue) || 0;
    paretoCount++;
    if (cumRev >= totalRevenue * 0.8) break;
  }

  // Top 5 categories monthly trend (for seasonality chart)
  const top5Categories = categoryRows.slice(0, 5).map((r) => r.category);
  const seasonalData = {};
  for (const r of monthlyRows) {
    if (!top5Categories.includes(r.category)) continue;
    if (!seasonalData[r.month]) seasonalData[r.month] = { month: r.month };
    seasonalData[r.month][r.category] = Math.round(Number(r.revenue) || 0);
  }

  return {
    analysisType: 'category',
    title: 'Category & Product Insights',
    summary: `${totalCategories} product categories analyzed. Top ${paretoCount} categories drive 80% of revenue (Pareto).`,
    metrics: {
      'Total Categories': totalCategories,
      'Total Revenue': `R$${fmt(totalRevenue)}`,
      'Pareto (80%)': `${paretoCount} categories`,
      'Top Category': categoryRows[0]?.category || 'N/A',
      'Top Category Revenue': `R$${fmt(categoryRows[0]?.revenue)}`,
    },
    charts: [
      {
        type: 'bar',
        title: 'Top 20 Categories by Revenue',
        data: categoryRows.map((r) => ({
          category: String(r.category).slice(0, 25),
          revenue: Math.round(Number(r.revenue) || 0),
        })),
        xKey: 'category',
        yKey: 'revenue',
        label: 'Revenue (R$)',
      },
    ],
    tables: [{
      title: 'Category Performance',
      columns: ['Category', 'Orders', 'Items Sold', 'Revenue', '% of Total', 'Avg Price'],
      rows: categoryRows.map((r) => [
        r.category,
        fmt(r.order_count),
        fmt(r.items_sold),
        `R$${fmt(r.revenue)}`,
        `${pct(Number(r.revenue) || 0, totalRevenue)}%`,
        `R$${fmt(r.avg_price)}`,
      ]),
    }],
    highlights: [
      `Pareto: ${paretoCount}/${totalCategories} categories = 80% revenue`,
      `#1: ${categoryRows[0]?.category}`,
      `#2: ${categoryRows[1]?.category || 'N/A'}`,
    ],
    details: categoryRows.slice(0, 10).map((r, i) =>
      `#${i + 1} ${r.category}: R$${fmt(r.revenue)} (${pct(Number(r.revenue) || 0, totalRevenue)}%, ${fmt(r.items_sold)} items)`
    ),
  };
}

// ── 6. Customer Satisfaction ─────────────────────────────────────────────────

export async function analyzeCustomerSatisfaction() {
  const [scoreRows, delayCorrelation, responseTime] = await Promise.all([
    runSql(`
      SELECT
        review_score AS score,
        COUNT(*) AS cnt
      FROM reviews
      GROUP BY review_score
      ORDER BY review_score
    `),
    runSql(`
      SELECT
        CASE
          WHEN o.order_delivered_customer_date <= o.order_estimated_delivery_date THEN 'on_time'
          ELSE 'late'
        END AS delivery_status,
        AVG(r.review_score) AS avg_score,
        COUNT(*) AS cnt
      FROM reviews r
      JOIN orders o ON r.order_id = o.order_id
      WHERE o.order_status = 'delivered'
        AND o.order_delivered_customer_date IS NOT NULL
        AND o.order_estimated_delivery_date IS NOT NULL
      GROUP BY delivery_status
    `),
    runSql(`
      SELECT
        AVG(CAST((JULIANDAY(review_answer_timestamp) - JULIANDAY(review_creation_date)) AS FLOAT)) AS avg_response_days
      FROM reviews
      WHERE review_answer_timestamp IS NOT NULL
        AND review_creation_date IS NOT NULL
    `),
  ]);

  const totalReviews = scoreRows.reduce((s, r) => s + (Number(r.cnt) || 0), 0);
  const weightedSum = scoreRows.reduce((s, r) => s + (Number(r.score) * Number(r.cnt)), 0);
  const avgScore = totalReviews > 0 ? weightedSum / totalReviews : 0;

  const score5 = scoreRows.find((r) => Number(r.score) === 5);
  const score1 = scoreRows.find((r) => Number(r.score) === 1);
  const positiveRate = pct(Number(score5?.cnt) || 0, totalReviews);
  const negativeRate = pct(Number(score1?.cnt) || 0, totalReviews);

  const onTimeRow = delayCorrelation.find((r) => r.delivery_status === 'on_time');
  const lateRow = delayCorrelation.find((r) => r.delivery_status === 'late');

  return {
    analysisType: 'satisfaction',
    title: 'Customer Satisfaction Analysis',
    summary: `${fmt(totalReviews)} reviews analyzed. Average score: ${avgScore.toFixed(2)}/5.`,
    metrics: {
      'Total Reviews': fmt(totalReviews),
      'Avg Score': avgScore.toFixed(2),
      '5-Star Rate': `${positiveRate}%`,
      '1-Star Rate': `${negativeRate}%`,
      'On-Time Avg Score': onTimeRow ? Number(onTimeRow.avg_score).toFixed(2) : 'N/A',
      'Late Avg Score': lateRow ? Number(lateRow.avg_score).toFixed(2) : 'N/A',
    },
    charts: [
      {
        type: 'bar',
        title: 'Review Score Distribution',
        data: scoreRows.map((r) => ({
          score: `${r.score} Star`,
          count: Number(r.cnt) || 0,
        })),
        xKey: 'score',
        yKey: 'count',
        label: 'Reviews',
      },
      {
        type: 'bar',
        title: 'Avg Score: On-Time vs Late Delivery',
        data: delayCorrelation.map((r) => ({
          status: r.delivery_status === 'on_time' ? 'On-Time' : 'Late',
          avgScore: Number(Number(r.avg_score).toFixed(2)),
        })),
        xKey: 'status',
        yKey: 'avgScore',
        label: 'Avg Score',
      },
    ],
    tables: [{
      title: 'Score Distribution',
      columns: ['Score', 'Count', '% of Total'],
      rows: scoreRows.map((r) => [
        `${r.score} Star`,
        fmt(r.cnt),
        `${pct(Number(r.cnt) || 0, totalReviews)}%`,
      ]),
    }],
    highlights: [
      `Average: ${avgScore.toFixed(2)}/5`,
      `Late deliveries: avg ${lateRow ? Number(lateRow.avg_score).toFixed(1) : '?'}/5 vs on-time ${onTimeRow ? Number(onTimeRow.avg_score).toFixed(1) : '?'}/5`,
      `${positiveRate}% gave 5 stars`,
    ],
    details: [
      `On-time orders average ${onTimeRow ? Number(onTimeRow.avg_score).toFixed(2) : 'N/A'}/5 (${fmt(onTimeRow?.cnt)} reviews)`,
      `Late orders average ${lateRow ? Number(lateRow.avg_score).toFixed(2) : 'N/A'}/5 (${fmt(lateRow?.cnt)} reviews)`,
      `Score gap: ${onTimeRow && lateRow ? (Number(onTimeRow.avg_score) - Number(lateRow.avg_score)).toFixed(2) : 'N/A'} points`,
      `Delivery experience is the #1 driver of satisfaction`,
    ],
  };
}

// ── 7. Payment Behavior ──────────────────────────────────────────────────────

export async function analyzePaymentBehavior() {
  const [typeRows, installmentRows, monthlyPayment] = await Promise.all([
    runSql(`
      SELECT
        payment_type,
        COUNT(*) AS tx_count,
        SUM(payment_value) AS total_value,
        AVG(payment_value) AS avg_value
      FROM payments
      GROUP BY payment_type
      ORDER BY total_value DESC
    `),
    runSql(`
      SELECT
        payment_installments AS installments,
        COUNT(*) AS tx_count,
        SUM(payment_value) AS total_value
      FROM payments
      WHERE payment_type = 'credit_card'
      GROUP BY payment_installments
      ORDER BY payment_installments
    `),
    runSql(`
      SELECT
        SUBSTR(o.order_purchase_timestamp, 1, 7) AS month,
        p.payment_type,
        SUM(p.payment_value) AS total_value
      FROM payments p
      JOIN orders o ON p.order_id = o.order_id
      GROUP BY month, p.payment_type
      ORDER BY month
    `),
  ]);

  const totalTx = typeRows.reduce((s, r) => s + (Number(r.tx_count) || 0), 0);
  const totalValue = typeRows.reduce((s, r) => s + (Number(r.total_value) || 0), 0);
  const creditCardRow = typeRows.find((r) => r.payment_type === 'credit_card');
  const creditCardPct = pct(Number(creditCardRow?.total_value) || 0, totalValue);

  // Installment analysis
  const installWithMultiple = installmentRows.filter((r) => Number(r.installments) > 1);
  const multiInstallmentTx = installWithMultiple.reduce((s, r) => s + (Number(r.tx_count) || 0), 0);
  const totalCcTx = installmentRows.reduce((s, r) => s + (Number(r.tx_count) || 0), 0);

  return {
    analysisType: 'payment',
    title: 'Payment Behavior Analysis',
    summary: `${fmt(totalTx)} payment transactions totaling R$${fmt(totalValue)}.`,
    metrics: {
      'Total Transactions': fmt(totalTx),
      'Total Value': `R$${fmt(totalValue)}`,
      'Credit Card %': `${creditCardPct}%`,
      'Multi-Installment %': `${pct(multiInstallmentTx, totalCcTx)}%`,
      'Payment Types': typeRows.length,
      'Avg Tx Value': `R$${fmt(totalValue / totalTx)}`,
    },
    charts: [
      {
        type: 'bar',
        title: 'Payment Value by Type',
        data: typeRows.map((r) => ({
          type: r.payment_type,
          value: Math.round(Number(r.total_value) || 0),
        })),
        xKey: 'type',
        yKey: 'value',
        label: 'Total Value (R$)',
      },
      {
        type: 'bar',
        title: 'Credit Card Installment Distribution',
        data: installmentRows.slice(0, 12).map((r) => ({
          installments: `${r.installments}x`,
          count: Number(r.tx_count) || 0,
        })),
        xKey: 'installments',
        yKey: 'count',
        label: 'Transactions',
      },
    ],
    tables: [{
      title: 'Payment Types',
      columns: ['Type', 'Transactions', 'Total Value', '% of Value', 'Avg Value'],
      rows: typeRows.map((r) => [
        r.payment_type,
        fmt(r.tx_count),
        `R$${fmt(r.total_value)}`,
        `${pct(Number(r.total_value) || 0, totalValue)}%`,
        `R$${fmt(r.avg_value)}`,
      ]),
    }],
    highlights: [
      `Credit card dominates: ${creditCardPct}%`,
      `${pct(multiInstallmentTx, totalCcTx)}% use installments`,
      `${typeRows.length} payment methods available`,
    ],
    details: typeRows.map((r) =>
      `${r.payment_type}: ${fmt(r.tx_count)} tx (R$${fmt(r.total_value)}, avg R$${fmt(r.avg_value)})`
    ),
  };
}

// ── Layer 2: Derived Metrics (JS-computed, not LLM) ─────────────────────────

/**
 * Compute derived metrics that the data card doesn't show.
 * These are pre-calculated in JS so the LLM doesn't hallucinate numbers.
 *
 * @param {string} analysisType
 * @param {Object} result - the unified analysis result
 * @returns {Object} derived metrics keyed by name
 */
export function computeDerivedMetrics(analysisType, result) {
  const derived = {};
  const chartData = result.charts?.[0]?.data || [];
  const tableRows = result.tables?.[0]?.rows || [];

  switch (analysisType) {
    case 'revenue': {
      // Filter sparse months (< 10 orders) to avoid skewing trend calculations
      const MIN_ORDERS = 10;
      const validMonths = chartData.filter((d) => (Number(d.orders) || 0) >= MIN_ORDERS);
      const revenues = validMonths.map((d) => Number(d.revenue) || 0);

      // Track excluded months for transparency
      const excludedMonths = chartData.filter((d) => (Number(d.orders) || 0) < MIN_ORDERS);
      if (excludedMonths.length > 0) {
        derived._excluded_months = excludedMonths.map((d) => `${d.month} (${d.orders} orders)`);
      }

      if (revenues.length >= 2) {
        // MoM growth: median of month-over-month % changes (resists outliers)
        const momRates = [];
        for (let i = 1; i < revenues.length; i++) {
          if (revenues[i - 1] > 0) {
            momRates.push(((revenues[i] - revenues[i - 1]) / revenues[i - 1]) * 100);
          }
        }
        if (momRates.length > 0) {
          momRates.sort((a, b) => a - b);
          derived.mom_growth_median = `${momRates[Math.floor(momRates.length / 2)].toFixed(1)}%`;
          derived.mom_growth_mean = `${(momRates.reduce((a, b) => a + b, 0) / momRates.length).toFixed(1)}%`;
        }

        // Peak month — search validMonths directly to avoid index misalignment
        const peakEntry = validMonths.reduce((best, d) =>
          (Number(d.revenue) || 0) > (Number(best.revenue) || 0) ? d : best, validMonths[0]);
        derived.peak_month = peakEntry?.month;
        const avgRev = revenues.reduce((a, b) => a + b, 0) / revenues.length;
        if (avgRev > 0) {
          derived.peak_vs_avg = `+${(((Number(peakEntry.revenue) - avgRev) / avgRev) * 100).toFixed(0)}%`;
        }

        // Volatility (coefficient of variation) on filtered months
        const mean = avgRev;
        if (mean > 0) {
          const variance = revenues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / revenues.length;
          const cv = (Math.sqrt(variance) / mean) * 100;
          derived.volatility = cv < 20 ? 'low' : cv < 40 ? 'moderate' : 'high';
          derived.volatility_cv = `${cv.toFixed(1)}%`;
        }
      }

      // AOV trend — compute from revenue/orders (not from missing d.aov field)
      const aovs = validMonths
        .filter((d) => (Number(d.orders) || 0) > 0)
        .map((d) => Number(d.revenue) / Number(d.orders));
      if (aovs.length >= 3) {
        const firstHalf = aovs.slice(0, Math.floor(aovs.length / 2));
        const secondHalf = aovs.slice(Math.floor(aovs.length / 2));
        const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        derived.aov_trend = avgSecond > avgFirst * 1.02 ? 'rising' : avgSecond < avgFirst * 0.98 ? 'declining' : 'stable';
      }

      // Freight ratio trend — compute from chart data freight/revenue fields
      const freightRatios = validMonths
        .filter((d) => (Number(d.revenue) || 0) > 0)
        .map((d) => ((Number(d.freight) || 0) / Number(d.revenue)) * 100);
      if (freightRatios.length >= 3) {
        const firstHalf = freightRatios.slice(0, Math.floor(freightRatios.length / 2));
        const secondHalf = freightRatios.slice(Math.floor(freightRatios.length / 2));
        const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        derived.freight_trend = avgSecond < avgFirst * 0.98 ? 'improving' : avgSecond > avgFirst * 1.02 ? 'worsening' : 'stable';
      }

      // Top 3 category concentration — use structured _categoryRevenues, not regex parsing
      const catRevs = result._categoryRevenues || [];
      const totalGmvStr = String(result.metrics?.['Total Revenue (GMV)'] || '0').replace(/[R$,]/g, '');
      const totalGmv = Number(totalGmvStr);
      if (catRevs.length >= 3 && totalGmv > 0) {
        const top3 = catRevs.slice(0, 3).reduce((s, c) => s + (c.revenue || 0), 0);
        derived.top3_concentration = `${((top3 / totalGmv) * 100).toFixed(1)}%`;
      }
      break;
    }

    case 'rfm': {
      const segTable = result.tables?.[0]?.rows || [];
      // Parse segment distribution: each row is [segment, count, pct, ...]
      const segments = {};
      for (const row of segTable) {
        const cells = Array.isArray(row) ? row : Object.values(row);
        const name = String(cells[0] || '').toLowerCase();
        const count = Number(String(cells[1] || '0').replace(/,/g, ''));
        segments[name] = count;
      }
      const total = Object.values(segments).reduce((a, b) => a + b, 0);
      if (total > 0) {
        derived.champion_pct = `${(((segments.champions || segments.champion || 0) / total) * 100).toFixed(1)}%`;
        derived.lost_pct = `${(((segments.lost || segments['lost customers'] || 0) / total) * 100).toFixed(1)}%`;
        derived.lost_warning = (segments.lost || segments['lost customers'] || 0) / total > 0.3;
        derived.repeat_rate = `${((1 - (segments['one-time'] || segments['one_time'] || 0) / total) * 100).toFixed(1)}%`;
      }
      break;
    }

    case 'delivery': {
      const onTimeStr = result.metrics?.['On-Time Rate'] || '';
      const onTimeRate = parseFloat(onTimeStr);
      if (!isNaN(onTimeRate)) {
        derived.on_time_warning = onTimeRate < 80;
        derived.on_time_level = onTimeRate >= 90 ? 'good' : onTimeRate >= 80 ? 'acceptable' : 'critical';
      }
      // State gap from tables
      const stateTable = result.tables?.[1]?.rows || result.tables?.[0]?.rows || [];
      if (stateTable.length >= 2) {
        const rates = stateTable.map((row) => {
          const cells = Array.isArray(row) ? row : Object.values(row);
          return parseFloat(String(cells[cells.length - 1] || '0').replace('%', ''));
        }).filter((v) => !isNaN(v) && v > 0);
        if (rates.length >= 2) {
          derived.best_state_rate = `${Math.max(...rates).toFixed(1)}%`;
          derived.worst_state_rate = `${Math.min(...rates).toFixed(1)}%`;
          derived.state_gap = `${(Math.max(...rates) - Math.min(...rates)).toFixed(1)}pp`;
        }
      }
      break;
    }

    case 'seller': {
      const sellerTable = result.tables?.[0]?.rows || [];
      if (sellerTable.length >= 2) {
        const revenues = sellerTable.map((row) => {
          const cells = Array.isArray(row) ? row : Object.values(row);
          const revCell = cells.find((c) => String(c).startsWith('R$')) || cells[3] || '0';
          return Number(String(revCell).replace(/[R$,]/g, ''));
        });
        const totalSellerRev = revenues.reduce((a, b) => a + b, 0);
        const top20Count = Math.max(1, Math.ceil(revenues.length * 0.2));
        const top20Rev = revenues.slice(0, top20Count).reduce((a, b) => a + b, 0);
        if (totalSellerRev > 0) {
          derived.top20_revenue_share = `${((top20Rev / totalSellerRev) * 100).toFixed(1)}%`;
        }
      }
      break;
    }

    case 'category': {
      const paretoStr = result.metrics?.['Pareto (80%)'];
      if (paretoStr) derived.pareto_categories = paretoStr;
      break;
    }

    case 'satisfaction': {
      const avgStr = result.metrics?.['Avg Score'] || '';
      const avg = parseFloat(avgStr);
      if (!isNaN(avg)) {
        derived.satisfaction_level = avg >= 4.0 ? 'good' : avg >= 3.5 ? 'moderate' : 'poor';
      }
      const onTimeScore = parseFloat(result.metrics?.['On-Time Avg Score'] || '0');
      const lateScore = parseFloat(result.metrics?.['Late Avg Score'] || '0');
      if (onTimeScore > 0 && lateScore > 0) {
        derived.delivery_score_gap = (onTimeScore - lateScore).toFixed(2);
        derived.delivery_impact = onTimeScore - lateScore > 1.0 ? 'strong' : 'moderate';
      }
      break;
    }

    case 'payment': {
      const payTable = result.tables?.[0]?.rows || [];
      let totalTx = 0;
      let ccValue = 0;
      let totalValue = 0;
      for (const row of payTable) {
        const cells = Array.isArray(row) ? row : Object.values(row);
        const type = String(cells[0] || '').toLowerCase();
        const tx = Number(String(cells[1] || '0').replace(/,/g, ''));
        const val = Number(String(cells[2] || '0').replace(/[R$,]/g, ''));
        totalTx += tx;
        totalValue += val;
        if (type.includes('credit')) ccValue = val;
      }
      if (totalValue > 0) {
        derived.credit_card_value_pct = `${((ccValue / totalValue) * 100).toFixed(1)}%`;
      }
      break;
    }
  }

  return derived;
}

// ── Layer 2: Cross-Analysis Queries ─────────────────────────────────────────

/**
 * Run 1-2 automatic cross-analysis queries to enrich the insight.
 * These are AlaSQL in-memory queries (< 50ms each).
 *
 * @param {string} analysisType
 * @returns {Promise<{ queries: Array<{ label: string, data: any[] }>, summary: string }>}
 */
export async function computeCrossInsights(analysisType) {
  const cross = { queries: [], summary: '' };

  try {
    switch (analysisType) {
      case 'revenue': {
        // Cross 1: monthly avg review score alongside revenue
        const satByMonth = await runSql(`
          SELECT
            SUBSTR(o.order_purchase_timestamp, 1, 7) AS month,
            AVG(r.review_score) AS avg_score,
            COUNT(*) AS review_count
          FROM orders o
          JOIN reviews r ON o.order_id = r.order_id
          WHERE o.order_status = 'delivered'
          GROUP BY SUBSTR(o.order_purchase_timestamp, 1, 7)
          ORDER BY month
        `);
        cross.queries.push({ label: 'Monthly satisfaction alongside revenue', data: satByMonth.slice(-12) });

        // Cross 2: top 3 categories month-over-month (GMV)
        const catTrend = await runSql(`
          SELECT
            SUBSTR(o.order_purchase_timestamp, 1, 7) AS month,
            COALESCE(ct.product_category_name_english, p.product_category_name) AS category,
            SUM(oi.price) + SUM(oi.freight_value) AS revenue
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
          WHERE o.order_status = 'delivered'
            AND category IN (
              SELECT TOP 3 COALESCE(ct2.product_category_name_english, p2.product_category_name)
              FROM order_items oi2
              JOIN products p2 ON oi2.product_id = p2.product_id
              LEFT JOIN category_translation ct2 ON p2.product_category_name = ct2.product_category_name
              JOIN orders o2 ON oi2.order_id = o2.order_id
              WHERE o2.order_status = 'delivered'
              GROUP BY COALESCE(ct2.product_category_name_english, p2.product_category_name)
              ORDER BY SUM(oi2.price) + SUM(oi2.freight_value) DESC
            )
          GROUP BY month, category
          ORDER BY month
        `);
        cross.queries.push({ label: 'Top 3 category monthly revenue trend', data: catTrend });
        break;
      }

      case 'delivery': {
        // Cross: late orders by category
        const lateCats = await runSql(`
          SELECT
            COALESCE(ct.product_category_name_english, p.product_category_name) AS category,
            COUNT(*) AS late_orders
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
          WHERE o.order_status = 'delivered'
            AND o.order_delivered_customer_date > o.order_estimated_delivery_date
          GROUP BY category
          ORDER BY late_orders DESC
          LIMIT 10
        `);
        cross.queries.push({ label: 'Late deliveries by product category', data: lateCats });
        break;
      }

      case 'rfm': {
        // Cross: what categories do "lost" customers (frequency=1, old purchase) buy
        const lostCats = await runSql(`
          SELECT
            COALESCE(ct.product_category_name_english, p.product_category_name) AS category,
            COUNT(DISTINCT c.customer_unique_id) AS lost_customers
          FROM customers c
          JOIN orders o ON c.customer_id = o.customer_id
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
          WHERE c.customer_unique_id IN (
            SELECT customer_unique_id FROM customers c2
            JOIN orders o2 ON c2.customer_id = o2.customer_id
            WHERE o2.order_status = 'delivered'
            GROUP BY c2.customer_unique_id
            HAVING COUNT(*) = 1
          )
          GROUP BY category
          ORDER BY lost_customers DESC
          LIMIT 8
        `);
        cross.queries.push({ label: 'Product categories purchased by one-time customers', data: lostCats });
        break;
      }

      case 'satisfaction': {
        // Cross: low-score orders by payment type
        const lowScorePayment = await runSql(`
          SELECT
            p.payment_type,
            COUNT(*) AS low_score_orders,
            AVG(r.review_score) AS avg_score
          FROM reviews r
          JOIN orders o ON r.order_id = o.order_id
          JOIN payments p ON o.order_id = p.order_id
          WHERE r.review_score <= 2
          GROUP BY p.payment_type
          ORDER BY low_score_orders DESC
        `);
        cross.queries.push({ label: 'Payment methods for low-score (1-2) orders', data: lowScorePayment });
        break;
      }

      case 'payment': {
        // Cross: high installment (≥6) orders by category
        const highInstCats = await runSql(`
          SELECT
            COALESCE(ct.product_category_name_english, pr.product_category_name) AS category,
            COUNT(*) AS high_installment_orders,
            AVG(p.payment_value) AS avg_value
          FROM payments p
          JOIN orders o ON p.order_id = o.order_id
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products pr ON oi.product_id = pr.product_id
          LEFT JOIN category_translation ct ON pr.product_category_name = ct.product_category_name
          WHERE p.payment_type = 'credit_card' AND p.payment_installments >= 6
          GROUP BY category
          ORDER BY high_installment_orders DESC
          LIMIT 8
        `);
        cross.queries.push({ label: 'Categories with high installment (6+) purchases', data: highInstCats });
        break;
      }

      case 'seller': {
        // Cross: low-rated sellers cancellation
        const lowRatedSellers = await runSql(`
          SELECT
            COUNT(DISTINCT CASE WHEN o.order_status IN ('canceled','unavailable') THEN o.order_id END) AS problem_orders,
            COUNT(DISTINCT o.order_id) AS total_orders
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.order_id
          JOIN (
            SELECT oi2.seller_id, AVG(r.review_score) AS avg_score
            FROM order_items oi2
            JOIN orders o2 ON oi2.order_id = o2.order_id
            JOIN reviews r ON o2.order_id = r.order_id
            GROUP BY oi2.seller_id
            HAVING AVG(r.review_score) < 3.5
          ) low ON oi.seller_id = low.seller_id
        `);
        cross.queries.push({ label: 'Problem order rate for low-rated sellers (<3.5)', data: lowRatedSellers });
        break;
      }

      case 'category': {
        // Cross: avg delivery days per category
        const catDelivery = await runSql(`
          SELECT
            COALESCE(ct.product_category_name_english, p.product_category_name) AS category,
            AVG(CAST((JULIANDAY(o.order_delivered_customer_date) - JULIANDAY(o.order_purchase_timestamp)) AS FLOAT)) AS avg_delivery_days,
            COUNT(*) AS order_count
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          LEFT JOIN category_translation ct ON p.product_category_name = ct.product_category_name
          WHERE o.order_status = 'delivered' AND o.order_delivered_customer_date IS NOT NULL
          GROUP BY category
          HAVING COUNT(*) >= 50
          ORDER BY avg_delivery_days DESC
          LIMIT 10
        `);
        cross.queries.push({ label: 'Average delivery days by category (top 10 slowest)', data: catDelivery });
        break;
      }
    }

    // Build summary
    cross.summary = cross.queries.map((q) => {
      const rowCount = q.data?.length || 0;
      return `${q.label}: ${rowCount} rows`;
    }).join('; ');
  } catch (err) {
    console.warn('[olistAnalysisService] Cross-insight query failed:', err?.message);
    cross.summary = `Cross-analysis failed: ${err?.message}`;
  }

  return cross;
}

// ── Layer 3: Deep Dive Suggestions ──────────────────────────────────────────

/**
 * Generate 2-3 suggested deep-dive follow-up analyses based on results.
 *
 * @param {string} analysisType
 * @param {Object} result - primary analysis result
 * @param {Object} derived - derived metrics
 * @param {Object} cross - cross insights
 * @returns {Array<{ id: string, label: string, query: string }>}
 */
export function suggestDeepDives(analysisType, result, derived, cross, userQuery = '') {
  // Detect language from user query — if contains CJK characters, use ZH
  const isChinese = /[\u4e00-\u9fff]/.test(userQuery);
  const L = (zh, en) => isChinese ? zh : en;

  const suggestions = [];

  switch (analysisType) {
    case 'revenue': {
      if (derived.peak_month) {
        suggestions.push({
          id: 'peak_breakdown',
          label: L(
            `${derived.peak_month} 營收峰值的品類組成是什麼？是否為促銷季？`,
            `What categories drove the ${derived.peak_month} revenue peak? Was it a promotional season?`
          ),
          query: `/analyze category`,
        });
      }
      if (derived.aov_trend === 'declining') {
        suggestions.push({
          id: 'aov_decline',
          label: L(
            `AOV 呈下降趨勢 — 是新客群帶動還是品類結構變化？`,
            `AOV is declining — driven by new customer segments or category mix shift?`
          ),
          query: `/analyze rfm`,
        });
      }
      if (derived.freight_trend === 'worsening') {
        suggestions.push({
          id: 'freight_issue',
          label: L(
            `運費佔比惡化 — 查看哪些地區/品類運費最高`,
            `Freight ratio worsening — which regions/categories have highest shipping costs?`
          ),
          query: `/analyze delivery`,
        });
      }
      if (suggestions.length < 2) {
        suggestions.push({
          id: 'satisfaction_check',
          label: L(
            `營收成長期間客戶滿意度是否同步提升？`,
            `Did customer satisfaction improve alongside revenue growth?`
          ),
          query: `/analyze satisfaction`,
        });
      }
      break;
    }

    case 'rfm': {
      if (derived.lost_warning) {
        suggestions.push({
          id: 'lost_recovery',
          label: L(
            `流失客群佔比 ${derived.lost_pct} — 查看他們的購買偏好和付款模式`,
            `Lost customers at ${derived.lost_pct} — check their purchase preferences and payment patterns`
          ),
          query: `/analyze payment`,
        });
      }
      suggestions.push({
        id: 'champion_categories',
        label: L(
          `高價值客群 (Champions) 最愛購買哪些品類？`,
          `Which categories do high-value Champions prefer?`
        ),
        query: `/analyze category`,
      });
      suggestions.push({
        id: 'rfm_delivery',
        label: L(
          `客戶流失是否與配送體驗有關？`,
          `Is customer churn related to delivery experience?`
        ),
        query: `/analyze delivery`,
      });
      break;
    }

    case 'delivery': {
      if (derived.on_time_warning) {
        suggestions.push({
          id: 'delay_impact',
          label: L(
            `準時率偏低 (${derived.on_time_level}) — 延遲對評分的影響有多大？`,
            `On-time rate is low (${derived.on_time_level}) — how much do delays impact review scores?`
          ),
          query: `/analyze satisfaction`,
        });
      }
      suggestions.push({
        id: 'delay_sellers',
        label: L(
          `哪些賣家的出貨延遲最嚴重？`,
          `Which sellers have the worst shipping delays?`
        ),
        query: `/analyze seller`,
      });
      suggestions.push({
        id: 'delay_categories',
        label: L(
          `延遲主要集中在哪些品類？`,
          `Which categories have the most delivery delays?`
        ),
        query: `/analyze category`,
      });
      break;
    }

    case 'seller': {
      suggestions.push({
        id: 'seller_satisfaction',
        label: L(
          `頭部賣家 vs 尾部賣家的客戶滿意度差異`,
          `Customer satisfaction gap: top sellers vs bottom sellers`
        ),
        query: `/analyze satisfaction`,
      });
      suggestions.push({
        id: 'seller_categories',
        label: L(
          `高績效賣家主要經營哪些品類？`,
          `Which categories do top-performing sellers focus on?`
        ),
        query: `/analyze category`,
      });
      break;
    }

    case 'category': {
      suggestions.push({
        id: 'cat_revenue',
        label: L(
          `品類營收的月度趨勢和季節性變化`,
          `Monthly revenue trends and seasonality by category`
        ),
        query: `/analyze revenue`,
      });
      suggestions.push({
        id: 'cat_delivery',
        label: L(
          `不同品類的配送表現差異`,
          `Delivery performance differences across categories`
        ),
        query: `/analyze delivery`,
      });
      break;
    }

    case 'satisfaction': {
      suggestions.push({
        id: 'sat_delivery',
        label: L(
          `低評分是否與配送延遲強相關？按地區查看`,
          `Are low ratings strongly correlated with delivery delays? View by region`
        ),
        query: `/analyze delivery`,
      });
      suggestions.push({
        id: 'sat_seller',
        label: L(
          `哪些賣家收到最多低評？`,
          `Which sellers receive the most low ratings?`
        ),
        query: `/analyze seller`,
      });
      break;
    }

    case 'payment': {
      suggestions.push({
        id: 'pay_category',
        label: L(
          `高分期購買集中在哪些品類？客單價如何？`,
          `Which categories have the most installment purchases? What's the AOV?`
        ),
        query: `/analyze category`,
      });
      suggestions.push({
        id: 'pay_satisfaction',
        label: L(
          `不同付款方式的客戶滿意度是否有差異？`,
          `Does customer satisfaction vary by payment method?`
        ),
        query: `/analyze satisfaction`,
      });
      break;
    }
  }

  return suggestions.slice(0, 3);
}

// ── Data Profile Builder ─────────────────────────────────────────────────────

/**
 * Build a data profile for LLM context: schema, date range, data quality flags.
 */
export function buildDataProfile(result) {
  const chartData = result.charts?.[0]?.data || [];
  const months = chartData.map((d) => d.month).filter(Boolean).sort();
  const sparseMonths = chartData.filter((d) => (Number(d.orders) || 0) < 10);

  const csvTables = Object.entries(SAP_TABLE_REGISTRY)
    .filter(([, v]) => v.source === 'csv')
    .map(([name, v]) => `${name}: ${v.columns.join(', ')}`);

  return {
    dataset: 'Olist Brazilian E-Commerce (Kaggle, 2016-2018)',
    revenue_definition: result._revenueDefinition || 'SUM(price)',
    date_range: months.length > 0 ? `${months[0]} to ${months[months.length - 1]}` : 'unknown',
    total_months: months.length,
    sparse_months: sparseMonths.map((d) => `${d.month} (${d.orders} orders)`),
    tables: csvTables,
  };
}

// ── LLM Insight Prompt Builder (v3 — with data profile + raw data) ───────────

/**
 * Build a system + user prompt pair for LLM to generate a deep analytical insight.
 * Includes: data profile, raw monthly data, derived metrics, cross-analysis, methodology notes.
 *
 * @param {Object} analysisResult - the unified shape from any analyze* function
 * @param {Object} derivedMetrics - from computeDerivedMetrics()
 * @param {Object} crossInsights - from computeCrossInsights()
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildAnalysisInsightPrompt(analysisResult, derivedMetrics, crossInsights) {
  const { title, metrics, highlights, details } = analysisResult;

  // Serialize card metrics (user already sees these — tell LLM not to repeat)
  const cardMetrics = Object.entries(metrics || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // Serialize derived metrics (LLM should USE these)
  const derivedBlock = Object.entries(derivedMetrics || {})
    .filter(([k, v]) => v !== undefined && v !== null && v !== '' && !k.startsWith('_'))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  // Serialize cross-analysis results with column headers
  let crossBlock = '';
  if (crossInsights?.queries?.length > 0) {
    crossBlock = crossInsights.queries.map((q) => {
      const rows = (q.data || []).slice(0, 20);
      const header = rows.length > 0 ? `Columns: ${Object.keys(rows[0]).join(', ')}` : '';
      const rowsStr = rows.map((r) => JSON.stringify(r)).join('\n');
      return `### Cross-Analysis: ${q.label}\n${header}\n${rowsStr || '(no data)'}`;
    }).join('\n\n');
  }

  // Build data profile
  const profile = buildDataProfile(analysisResult);

  // Raw monthly data for LLM to verify and compute from
  const rawMonthlyData = (analysisResult.charts?.[0]?.data || [])
    .map((r) => JSON.stringify(r)).join('\n');

  const systemPrompt = `You are a senior e-commerce data analyst. The user has ALREADY seen a data card showing raw metrics, charts, and tables. Your job is to provide insights they CANNOT see on the card.

STRICT OUTPUT — respond with ONLY a JSON object (no markdown fences):
{
  "executive_summary": "2-3 sentences, high-level interpretation, NO citations",
  "key_findings": ["3-4 genuine insights using derived/cross data, max 1 citation each"],
  "risk_alerts": ["0-2 risks or anomalies worth flagging"],
  "recommendations": ["2-3 specific, actionable suggestions with expected impact"],
  "data_sources": ["source 1 (≤15 words)", "source 2"]
}

CRITICAL RULES:
1. DO NOT repeat numbers already on the data card.
2. Focus on: growth rates, trends, cross-metric correlations, anomaly explanations, concentration risks.
3. Citations: use sparingly (≤6 total), format: [metric = value]. NO citations in executive_summary.
4. Recommendations must be specific (name categories/months/segments) with expected impact.
5. Use DERIVED METRICS and CROSS-ANALYSIS data — that's your unique value.
6. You have raw monthly data — use it to verify derived metrics and spot anomalies.
7. Note data quality issues: sparse months, missing data, outliers.
8. When claiming trends, specify the time period and which months were included/excluded.
9. Under 400 words total. Respond in the user's language.

METHODOLOGY NOTES:
- Revenue = ${profile.revenue_definition}
- MoM growth: median of month-over-month % changes (months with <10 orders excluded)
- Volatility CV: std_dev / mean × 100 (sparse months excluded)
- Top3 concentration: top 3 categories' revenue / total revenue
- Freight %: freight / total revenue (not freight / product_revenue)`;

  const userPrompt = `Analyze "${title}" results. User query: "${analysisResult._userQuery || ''}"

## Data Profile
- Dataset: ${profile.dataset}
- Date range: ${profile.date_range} (${profile.total_months} months)
- Revenue definition: ${profile.revenue_definition}
${profile.sparse_months.length > 0 ? `- Sparse months (excluded from trends): ${profile.sparse_months.join(', ')}` : '- No sparse months'}

## Available Tables (for context — reference these dimensions in analysis):
${profile.tables.join('\n')}

## Already on the data card (DO NOT repeat):
${cardMetrics}

## Raw Monthly Data (use for your own calculations and verification):
${rawMonthlyData || '(no monthly data)'}

## Derived Metrics (JS pre-computed):
${derivedBlock || '(none computed)'}

## Cross-Analysis Results (auto-queried from related tables):
${crossBlock || '(none available)'}

## Context:
Highlights: ${(highlights || []).join('; ')}
Details: ${(details || []).slice(0, 5).join('; ')}

Write your analysis focusing on what the card DOESN'T show. Cross-reference the raw data to verify claims.`;

  return { systemPrompt, userPrompt };
}
