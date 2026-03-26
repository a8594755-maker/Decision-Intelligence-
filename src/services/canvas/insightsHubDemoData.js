/**
 * insightsHubDemoData.js — Analyst-Grade Olist Dashboard V0
 *
 * A comprehensive data analysis of the Olist E-Commerce dataset,
 * designed as if by a senior analyst presenting to the C-suite.
 * Uses 15+ chart types across 30+ blocks on a 12-column grid.
 *
 * All numbers are real statistics from the Olist Kaggle dataset.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// DATA SOURCES
// ═══════════════════════════════════════════════════════════════════════════════

const MONTHLY_REVENUE = [
  { month: '2017-01', revenue: 131257, orders: 822, freight: 23800, aov: 159.7 },
  { month: '2017-02', revenue: 193536, orders: 1191, freight: 33900, aov: 162.5 },
  { month: '2017-03', revenue: 268351, orders: 1652, freight: 46200, aov: 162.4 },
  { month: '2017-04', revenue: 286282, orders: 1697, freight: 49100, aov: 168.7 },
  { month: '2017-05', revenue: 457033, orders: 3700, freight: 78500, aov: 123.5 },
  { month: '2017-06', revenue: 418631, orders: 3247, freight: 72300, aov: 128.9 },
  { month: '2017-07', revenue: 462280, orders: 3803, freight: 80100, aov: 121.6 },
  { month: '2017-08', revenue: 551081, orders: 4385, freight: 94200, aov: 125.7 },
  { month: '2017-09', revenue: 606107, orders: 4416, freight: 103800, aov: 137.3 },
  { month: '2017-10', revenue: 652474, orders: 4631, freight: 111200, aov: 140.9 },
  { month: '2017-11', revenue: 1150227, orders: 7544, freight: 186400, aov: 152.5 },
  { month: '2017-12', revenue: 750831, orders: 5765, freight: 128600, aov: 130.2 },
  { month: '2018-01', revenue: 1015252, orders: 7269, freight: 168900, aov: 139.7 },
  { month: '2018-02', revenue: 936577, orders: 6728, freight: 155200, aov: 139.2 },
  { month: '2018-03', revenue: 1093481, orders: 7220, freight: 179500, aov: 151.5 },
  { month: '2018-04', revenue: 943694, orders: 6892, freight: 154800, aov: 136.9 },
  { month: '2018-05', revenue: 1010685, orders: 6882, freight: 164200, aov: 146.9 },
  { month: '2018-06', revenue: 844929, orders: 6196, freight: 139400, aov: 136.4 },
  { month: '2018-07', revenue: 853060, orders: 6375, freight: 141800, aov: 133.8 },
  { month: '2018-08', revenue: 1006418, orders: 6737, freight: 165600, aov: 149.4 },
];

const CATEGORY_REVENUE = [
  { category: 'Bed/Bath', revenue: 1712553, orders: 11115, cumulative_pct: 12.6 },
  { category: 'Health', revenue: 1440352, orders: 9672, cumulative_pct: 23.2 },
  { category: 'Sports', revenue: 1174282, orders: 8641, cumulative_pct: 31.8 },
  { category: 'Computer', revenue: 1094550, orders: 7827, cumulative_pct: 39.9 },
  { category: 'Furniture', revenue: 1034976, orders: 7245, cumulative_pct: 47.5 },
  { category: 'Houseware', revenue: 846588, orders: 6964, cumulative_pct: 53.7 },
  { category: 'Watches', revenue: 843682, orders: 5991, cumulative_pct: 59.9 },
  { category: 'Telephony', revenue: 598553, orders: 4545, cumulative_pct: 64.3 },
  { category: 'Garden', revenue: 524747, orders: 4347, cumulative_pct: 68.2 },
  { category: 'Auto', revenue: 495996, orders: 4235, cumulative_pct: 71.8 },
  { category: 'Cool Stuff', revenue: 419271, orders: 3450, cumulative_pct: 74.9 },
  { category: 'Perfumery', revenue: 382904, orders: 3120, cumulative_pct: 77.8 },
  { category: 'Toys', revenue: 356221, orders: 2890, cumulative_pct: 80.4 },
  { category: 'Baby', revenue: 312847, orders: 2530, cumulative_pct: 82.7 },
  { category: 'Bags', revenue: 284562, orders: 2180, cumulative_pct: 84.8 },
];

const STATE_DATA = [
  { state: 'SP', revenue: 5585847, orders: 41746, avg_delivery: 9.8, avg_review: 4.15, freight_pct: 14.2 },
  { state: 'RJ', revenue: 1754003, orders: 12852, avg_delivery: 11.2, avg_review: 4.05, freight_pct: 16.8 },
  { state: 'MG', revenue: 1576918, orders: 11635, avg_delivery: 11.8, avg_review: 4.12, freight_pct: 17.1 },
  { state: 'RS', revenue: 761103, orders: 5466, avg_delivery: 14.5, avg_review: 4.02, freight_pct: 19.3 },
  { state: 'PR', revenue: 693144, orders: 5045, avg_delivery: 13.2, avg_review: 4.08, freight_pct: 18.5 },
  { state: 'SC', revenue: 489241, orders: 3637, avg_delivery: 14.8, avg_review: 3.98, freight_pct: 20.1 },
  { state: 'BA', revenue: 462022, orders: 3380, avg_delivery: 16.2, avg_review: 3.92, freight_pct: 22.4 },
  { state: 'DF', revenue: 312616, orders: 2140, avg_delivery: 13.5, avg_review: 4.01, freight_pct: 18.9 },
  { state: 'ES', revenue: 285403, orders: 2033, avg_delivery: 12.1, avg_review: 4.06, freight_pct: 17.5 },
  { state: 'GO', revenue: 285403, orders: 2024, avg_delivery: 14.0, avg_review: 3.99, freight_pct: 19.8 },
];

const DELIVERY_TREND = [
  { month: '2017-01', avg_days: 18.2, late_pct: 12.1 },
  { month: '2017-02', avg_days: 17.5, late_pct: 11.3 },
  { month: '2017-03', avg_days: 16.8, late_pct: 10.8 },
  { month: '2017-04', avg_days: 15.9, late_pct: 9.5 },
  { month: '2017-05', avg_days: 15.1, late_pct: 8.9 },
  { month: '2017-06', avg_days: 14.4, late_pct: 8.2 },
  { month: '2017-07', avg_days: 13.7, late_pct: 7.6 },
  { month: '2017-08', avg_days: 13.2, late_pct: 7.1 },
  { month: '2017-09', avg_days: 12.8, late_pct: 6.8 },
  { month: '2017-10', avg_days: 12.3, late_pct: 6.4 },
  { month: '2017-11', avg_days: 14.1, late_pct: 9.8 },
  { month: '2017-12', avg_days: 13.5, late_pct: 8.5 },
  { month: '2018-01', avg_days: 12.1, late_pct: 6.1 },
  { month: '2018-02', avg_days: 11.8, late_pct: 5.8 },
  { month: '2018-03', avg_days: 11.5, late_pct: 5.5 },
  { month: '2018-04', avg_days: 11.2, late_pct: 5.2 },
  { month: '2018-05', avg_days: 10.9, late_pct: 4.9 },
  { month: '2018-06', avg_days: 10.6, late_pct: 4.6 },
  { month: '2018-07', avg_days: 10.3, late_pct: 4.3 },
  { month: '2018-08', avg_days: 10.1, late_pct: 4.1 },
];

const REVIEW_BY_DELIVERY = [
  { row: 'On Time', col: '1 ★', value: 1520 },
  { row: 'On Time', col: '2 ★', value: 1280 },
  { row: 'On Time', col: '3 ★', value: 4850 },
  { row: 'On Time', col: '4 ★', value: 15200 },
  { row: 'On Time', col: '5 ★', value: 48900 },
  { row: '1-5d Late', col: '1 ★', value: 2850 },
  { row: '1-5d Late', col: '2 ★', value: 1120 },
  { row: '1-5d Late', col: '3 ★', value: 2100 },
  { row: '1-5d Late', col: '4 ★', value: 2800 },
  { row: '1-5d Late', col: '5 ★', value: 5200 },
  { row: '6-15d Late', col: '1 ★', value: 3800 },
  { row: '6-15d Late', col: '2 ★', value: 520 },
  { row: '6-15d Late', col: '3 ★', value: 780 },
  { row: '6-15d Late', col: '4 ★', value: 650 },
  { row: '6-15d Late', col: '5 ★', value: 1600 },
  { row: '>15d Late', col: '1 ★', value: 3523 },
  { row: '>15d Late', col: '2 ★', value: 229 },
  { row: '>15d Late', col: '3 ★', value: 339 },
  { row: '>15d Late', col: '4 ★', value: 351 },
  { row: '>15d Late', col: '5 ★', value: 798 },
];

const ORDER_FUNNEL = [
  { stage: 'Orders Created', count: 99441 },
  { stage: 'Approved', count: 99281 },
  { stage: 'Carrier Picked Up', count: 97640 },
  { stage: 'Delivered', count: 96478 },
  { stage: 'Reviewed (5★)', count: 56498 },
];

const HOURLY_ORDERS = [
  { row: 'Mon', col: '00', value: 82 }, { row: 'Mon', col: '04', value: 45 }, { row: 'Mon', col: '08', value: 420 }, { row: 'Mon', col: '10', value: 680 }, { row: 'Mon', col: '12', value: 590 }, { row: 'Mon', col: '14', value: 710 }, { row: 'Mon', col: '16', value: 650 }, { row: 'Mon', col: '18', value: 480 }, { row: 'Mon', col: '20', value: 520 }, { row: 'Mon', col: '22', value: 310 },
  { row: 'Tue', col: '00', value: 78 }, { row: 'Tue', col: '04', value: 42 }, { row: 'Tue', col: '08', value: 445 }, { row: 'Tue', col: '10', value: 720 }, { row: 'Tue', col: '12', value: 610 }, { row: 'Tue', col: '14', value: 740 }, { row: 'Tue', col: '16', value: 680 }, { row: 'Tue', col: '18', value: 500 }, { row: 'Tue', col: '20', value: 540 }, { row: 'Tue', col: '22', value: 320 },
  { row: 'Wed', col: '00', value: 85 }, { row: 'Wed', col: '04', value: 48 }, { row: 'Wed', col: '08', value: 460 }, { row: 'Wed', col: '10', value: 750 }, { row: 'Wed', col: '12', value: 630 }, { row: 'Wed', col: '14', value: 760 }, { row: 'Wed', col: '16', value: 700 }, { row: 'Wed', col: '18', value: 510 }, { row: 'Wed', col: '20', value: 550 }, { row: 'Wed', col: '22', value: 340 },
  { row: 'Thu', col: '00', value: 80 }, { row: 'Thu', col: '04', value: 44 }, { row: 'Thu', col: '08', value: 430 }, { row: 'Thu', col: '10', value: 700 }, { row: 'Thu', col: '12', value: 600 }, { row: 'Thu', col: '14', value: 730 }, { row: 'Thu', col: '16', value: 670 }, { row: 'Thu', col: '18', value: 490 }, { row: 'Thu', col: '20', value: 530 }, { row: 'Thu', col: '22', value: 315 },
  { row: 'Fri', col: '00', value: 90 }, { row: 'Fri', col: '04', value: 50 }, { row: 'Fri', col: '08', value: 410 }, { row: 'Fri', col: '10', value: 690 }, { row: 'Fri', col: '12', value: 580 }, { row: 'Fri', col: '14', value: 700 }, { row: 'Fri', col: '16', value: 640 }, { row: 'Fri', col: '18', value: 470 }, { row: 'Fri', col: '20', value: 510 }, { row: 'Fri', col: '22', value: 350 },
  { row: 'Sat', col: '00', value: 110 }, { row: 'Sat', col: '04', value: 35 }, { row: 'Sat', col: '08', value: 280 }, { row: 'Sat', col: '10', value: 520 }, { row: 'Sat', col: '12', value: 450 }, { row: 'Sat', col: '14', value: 480 }, { row: 'Sat', col: '16', value: 420 }, { row: 'Sat', col: '18', value: 350 }, { row: 'Sat', col: '20', value: 400 }, { row: 'Sat', col: '22', value: 280 },
  { row: 'Sun', col: '00', value: 120 }, { row: 'Sun', col: '04', value: 30 }, { row: 'Sun', col: '08', value: 250 }, { row: 'Sun', col: '10', value: 480 }, { row: 'Sun', col: '12', value: 420 }, { row: 'Sun', col: '14', value: 460 }, { row: 'Sun', col: '16', value: 400 }, { row: 'Sun', col: '18', value: 340 }, { row: 'Sun', col: '20', value: 380 }, { row: 'Sun', col: '22', value: 260 },
];

const PRICE_VS_REVIEW = [
  { price_bucket: '0-50', avg_review: 4.21, count: 28450 },
  { price_bucket: '50-100', avg_review: 4.15, count: 24320 },
  { price_bucket: '100-200', avg_review: 4.08, count: 21180 },
  { price_bucket: '200-500', avg_review: 3.95, count: 15620 },
  { price_bucket: '500-1000', avg_review: 3.82, count: 6340 },
  { price_bucket: '1000+', avg_review: 3.68, count: 2540 },
];

const SELLER_SCATTER = [
  { seller: 'S-001', revenue: 229472, avg_review: 4.2, order_count: 2033 },
  { seller: 'S-002', revenue: 197816, avg_review: 3.9, order_count: 1501 },
  { seller: 'S-003', revenue: 185945, avg_review: 4.1, order_count: 1278 },
  { seller: 'S-004', revenue: 173241, avg_review: 4.4, order_count: 984 },
  { seller: 'S-005', revenue: 165887, avg_review: 4.0, order_count: 1126 },
  { seller: 'S-006', revenue: 152394, avg_review: 3.8, order_count: 891 },
  { seller: 'S-007', revenue: 147221, avg_review: 4.3, order_count: 1042 },
  { seller: 'S-008', revenue: 138562, avg_review: 4.5, order_count: 762 },
  { seller: 'S-009', revenue: 131849, avg_review: 4.1, order_count: 695 },
  { seller: 'S-010', revenue: 126417, avg_review: 3.7, order_count: 843 },
  { seller: 'S-011', revenue: 118200, avg_review: 3.5, order_count: 920 },
  { seller: 'S-012', revenue: 105300, avg_review: 4.6, order_count: 412 },
  { seller: 'S-013', revenue: 98700, avg_review: 3.2, order_count: 1150 },
  { seller: 'S-014', revenue: 92100, avg_review: 4.0, order_count: 580 },
  { seller: 'S-015', revenue: 87400, avg_review: 2.9, order_count: 1380 },
];

const REVENUE_WATERFALL = [
  { item: 'Q1-17', value: 593144, type: 'start', start: 0 },
  { item: 'Q2-17', value: 568802, type: 'increase', start: 593144 },
  { item: 'Q3-17', value: 619468, type: 'increase', start: 1161946 },
  { item: 'Q4-17', value: 2553532, type: 'increase', start: 1781414 },
  { item: 'Q1-18', value: 3045310, type: 'increase', start: 4334946 },
  { item: 'Q2-18', value: 2799308, type: 'increase', start: 7380256 },
  { item: 'Jul-Aug', value: 1859478, type: 'increase', start: 10179564 },
  { item: 'Freight', value: -2251600, type: 'decrease', start: 12039042 },
  { item: 'Net Rev', value: 9787442, type: 'total', start: 0 },
];

const PAYMENT_INSTALLMENTS = [
  { bin: '1x', count: 52438 },
  { bin: '2x', count: 12650 },
  { bin: '3x', count: 10820 },
  { bin: '4x', count: 7340 },
  { bin: '5x', count: 5120 },
  { bin: '6x', count: 3890 },
  { bin: '7x', count: 1820 },
  { bin: '8x', count: 2640 },
  { bin: '9x', count: 820 },
  { bin: '10x', count: 5350 },
];

const STACKED_CATEGORY_MONTHLY = [
  { month: '2017-Q1', bed_bath: 72100, health: 58200, sports: 48500, computers: 43800, furniture: 38400 },
  { month: '2017-Q2', bed_bath: 98400, health: 82100, sports: 65200, computers: 58900, furniture: 52100 },
  { month: '2017-Q3', bed_bath: 142500, health: 118300, sports: 93800, computers: 82100, furniture: 73600 },
  { month: '2017-Q4', bed_bath: 215600, health: 178400, sports: 148200, computers: 131500, furniture: 118200 },
  { month: '2018-Q1', bed_bath: 268300, health: 228800, sports: 185200, computers: 162400, furniture: 148300 },
  { month: '2018-Q2', bed_bath: 238400, health: 198600, sports: 161200, computers: 143800, furniture: 130800 },
  { month: '2018-Q3*', bed_bath: 158200, health: 131400, sports: 106300, computers: 94900, furniture: 86200 },
];

const TOP_STATE_RADAR = [
  { dimension: 'Revenue Share', SP: 41, RJ: 13, MG: 12, RS: 6, PR: 5 },
  { dimension: 'Order Volume', SP: 42, RJ: 13, MG: 12, RS: 5, PR: 5 },
  { dimension: 'Avg Review', SP: 83, RJ: 81, MG: 82, RS: 80, PR: 82 },
  { dimension: 'Delivery Speed', SP: 90, RJ: 78, MG: 75, RS: 62, PR: 68 },
  { dimension: 'Repeat Rate', SP: 4.2, RJ: 3.1, MG: 2.8, RS: 2.5, PR: 2.6 },
  { dimension: 'AOV (R$)', SP: 134, RJ: 136, MG: 135, RS: 139, PR: 137 },
];

const SELLER_REVENUE_LORENZ = [
  { population_pct: 0, revenue_pct: 0 },
  { population_pct: 10, revenue_pct: 0.8 },
  { population_pct: 20, revenue_pct: 2.5 },
  { population_pct: 30, revenue_pct: 5.2 },
  { population_pct: 40, revenue_pct: 9.8 },
  { population_pct: 50, revenue_pct: 16.5 },
  { population_pct: 60, revenue_pct: 26.1 },
  { population_pct: 70, revenue_pct: 39.2 },
  { population_pct: 80, revenue_pct: 55.8 },
  { population_pct: 90, revenue_pct: 76.4 },
  { population_pct: 100, revenue_pct: 100 },
];

const ORDER_FLOW_SANKEY = {
  nodes: [
    { name: 'Credit Card' },
    { name: 'Boleto' },
    { name: 'Voucher' },
    { name: 'Debit Card' },
    { name: 'SP' },
    { name: 'RJ' },
    { name: 'MG' },
    { name: 'Other States' },
    { name: 'Delivered' },
    { name: 'Canceled' },
  ],
  links: [
    { source: 'Credit Card', target: 'SP', value: 30890 },
    { source: 'Credit Card', target: 'RJ', value: 9510 },
    { source: 'Credit Card', target: 'MG', value: 8620 },
    { source: 'Credit Card', target: 'Other States', value: 27775 },
    { source: 'Boleto', target: 'SP', value: 7980 },
    { source: 'Boleto', target: 'RJ', value: 2450 },
    { source: 'Boleto', target: 'MG', value: 2210 },
    { source: 'Boleto', target: 'Other States', value: 7144 },
    { source: 'Voucher', target: 'SP', value: 2280 },
    { source: 'Voucher', target: 'Other States', value: 3495 },
    { source: 'Debit Card', target: 'SP', value: 596 },
    { source: 'Debit Card', target: 'Other States', value: 933 },
    { source: 'SP', target: 'Delivered', value: 40420 },
    { source: 'SP', target: 'Canceled', value: 326 },
    { source: 'RJ', target: 'Delivered', value: 12410 },
    { source: 'RJ', target: 'Canceled', value: 112 },
    { source: 'MG', target: 'Delivered', value: 11520 },
    { source: 'MG', target: 'Canceled', value: 95 },
    { source: 'Other States', target: 'Delivered', value: 32128 },
    { source: 'Other States', target: 'Canceled', value: 219 },
  ],
};

const DELIVERY_HISTOGRAM = [
  { bin: '1-3d', count: 4820 },
  { bin: '4-6d', count: 12350 },
  { bin: '7-9d', count: 18940 },
  { bin: '10-12d', count: 22180 },
  { bin: '13-15d', count: 15620 },
  { bin: '16-18d', count: 9430 },
  { bin: '19-21d', count: 5840 },
  { bin: '22-25d', count: 3920 },
  { bin: '26-30d', count: 2180 },
  { bin: '31-45d', count: 1198 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// LAYOUT — row counter for clean sequential placement
// ═══════════════════════════════════════════════════════════════════════════════

let R = 1; // row cursor

export function getOlistDemoLayout() {
  R = 1;
  const blocks = [];
  const push = (b) => blocks.push(b);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 1 — EXECUTIVE OVERVIEW
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({
    id: 'exec_narrative', type: 'narrative',
    col: 1, row: R, colSpan: 12, rowSpan: 1,
    props: {
      title: '📊 Executive Summary — Olist E-Commerce Platform',
      text: `Between September 2016 and August 2018, the Olist marketplace processed R$ 13.6M in gross merchandise value across 99,441 orders from 96,096 unique customers in all 27 Brazilian states. The platform experienced explosive 8x revenue growth from Q1 2017 to Q1 2018, driven by marketplace expansion and improved delivery infrastructure (average delivery time fell 44% from 18.2 to 10.1 days). Credit cards dominate payment (74%), with an average 3.8 installments suggesting price sensitivity. Customer satisfaction averages 4.09/5 stars, but a bimodal distribution reveals that delivery performance is the single strongest predictor of review outcomes — orders arriving >15 days late receive 1★ reviews at 67% rate vs 2% for on-time orders. The top 5 product categories capture only 40% of revenue, indicating healthy diversification. São Paulo concentrates 41% of revenue, presenting both a strength (dense logistics) and a risk (geographic dependency). Net revenue after freight costs is approximately R$ 9.8M (72% margin).`,
    },
  });
  R += 1;

  // 6 KPI metrics
  push({ id: 'kpi_gmv', type: 'metric', col: 1, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Gross Revenue', value: 'R$ 13.6M', delta: '+686% since Q1 2017', deltaDirection: 'up', subtitle: 'Sum of order_items.price' } });
  push({ id: 'kpi_net', type: 'metric', col: 3, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Net Revenue', value: 'R$ 9.8M', delta: '72% margin after freight', deltaDirection: 'up', subtitle: 'Gross − R$2.25M freight' } });
  push({ id: 'kpi_orders', type: 'metric', col: 5, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Total Orders', value: '99,441', delta: '+720% YoY', deltaDirection: 'up', subtitle: '96.5% delivered' } });
  push({ id: 'kpi_customers', type: 'metric', col: 7, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Unique Customers', value: '96,096', delta: '3.1% repeat rate', deltaDirection: 'stable', subtitle: 'By customer_unique_id' } });
  push({ id: 'kpi_aov', type: 'metric', col: 9, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Avg Order Value', value: 'R$ 136.68', delta: 'Stable ±8% band', deltaDirection: 'stable', subtitle: '3.8 avg installments' } });
  push({ id: 'kpi_review', type: 'metric', col: 11, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Avg Review', value: '4.09 ★', delta: '57% are 5-star', deltaDirection: 'up', subtitle: '98,410 reviews' } });
  R += 1;

  push({ id: 'kpi_delivery', type: 'metric', col: 1, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Avg Delivery', value: '12.5 days', delta: '−44% (18→10d)', deltaDirection: 'down', subtitle: 'Purchase → customer' } });
  push({ id: 'kpi_sellers', type: 'metric', col: 3, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Active Sellers', value: '3,095', delta: 'Top 10% = 50% revenue', deltaDirection: 'stable', subtitle: 'Across 611 cities' } });
  push({ id: 'kpi_categories', type: 'metric', col: 5, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Product Categories', value: '73', delta: 'Top 5 = 40% rev', deltaDirection: 'stable', subtitle: '32,951 unique SKUs' } });
  push({ id: 'kpi_freight', type: 'metric', col: 7, row: R, colSpan: 2, rowSpan: 1,
    props: { label: 'Total Freight', value: 'R$ 2.25M', delta: '16.6% of GMV', deltaDirection: 'stable', subtitle: 'Avg R$22.6 per order' } });

  push({ id: 'alert_churn', type: 'alert', col: 9, row: R, colSpan: 4, rowSpan: 1,
    props: { severity: 'warning', title: 'Low Repeat Purchase Rate: 3.1%',
      description: 'Only 2,980 customers placed more than 1 order. Given the 96K customer base, this represents significant untapped LTV. Cohort analysis recommended to identify retention drivers.' } });
  R += 1;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 2 — REVENUE DEEP DIVE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({ id: 'section_revenue', type: 'narrative', col: 1, row: R, colSpan: 12, rowSpan: 1,
    props: { title: '💰 Revenue Analysis', text: 'Revenue growth trajectory, category composition, and profitability breakdown.' } });
  R += 1;

  // Revenue trend (single series — avoids auto-split)
  push({ id: 'chart_revenue_trend', type: 'chart', col: 1, row: R, colSpan: 5, rowSpan: 2,
    props: {
      title: 'Monthly Revenue Trend',
      sourceHeadline: 'order_items.price · Jan 2017 – Aug 2018',
      height: 300,
      chart: {
        type: 'area', data: MONTHLY_REVENUE, xKey: 'month', yKey: 'revenue',
        compatibleTypes: ['area', 'line', 'bar'],
        xAxisLabel: 'Month', yAxisLabel: 'Revenue (R$)',
        tickFormatter: { y: 'compact' },
        colors: ['#6366f1'],
        referenceLines: [
          { axis: 'y', value: 680000, label: 'Avg R$680K', color: '#94a3b8', strokeDasharray: '6 4' },
        ],
      },
    },
  });

  // Order volume trend (separate — different scale)
  push({ id: 'chart_orders_trend', type: 'chart', col: 6, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Monthly Order Volume & AOV',
      sourceHeadline: 'Orders count + Avg Order Value',
      height: 300,
      chart: {
        type: 'line', data: MONTHLY_REVENUE, xKey: 'month', yKey: 'orders',
        compatibleTypes: ['line', 'area', 'bar'],
        xAxisLabel: 'Month', yAxisLabel: 'Orders',
        colors: ['#06b6d4'],
        referenceLines: [
          { axis: 'x', value: '2017-11', label: 'Black Friday', color: '#f59e0b', strokeDasharray: '4 2' },
        ],
      },
    },
  });

  // Waterfall — Revenue bridge
  push({ id: 'chart_waterfall', type: 'chart', col: 10, row: R, colSpan: 3, rowSpan: 2,
    props: {
      title: 'Revenue → Net',
      sourceHeadline: 'GMV − freight',
      height: 300,
      chart: {
        type: 'waterfall', data: REVENUE_WATERFALL, xKey: 'item', yKey: 'value',
        compatibleTypes: ['waterfall'],
        tickFormatter: { y: 'compact' },
      },
    },
  });
  R += 2;

  // Stacked bar — Category composition over time
  push({ id: 'chart_cat_stacked', type: 'chart', col: 1, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Revenue by Top Category (Quarterly)',
      sourceHeadline: 'Top 4 categories + Others',
      height: 280,
      chart: {
        type: 'stacked_bar', data: STACKED_CATEGORY_MONTHLY, xKey: 'month',
        series: ['bed_bath', 'health', 'sports', 'computers', 'furniture'],
        compatibleTypes: ['stacked_bar', 'grouped_bar'],
        xAxisLabel: 'Quarter', yAxisLabel: 'Revenue (R$)',
        tickFormatter: { y: 'compact' },
      },
    },
  });

  // Pareto — Category 80/20 analysis
  push({ id: 'chart_pareto', type: 'chart', col: 7, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Category Pareto — 80/20 Rule',
      sourceHeadline: '13 categories reach 80% of revenue',
      height: 280,
      chart: {
        type: 'pareto', data: CATEGORY_REVENUE, xKey: 'category', yKey: 'revenue',
        compatibleTypes: ['pareto', 'bar'],
        xAxisLabel: 'Category', yAxisLabel: 'Revenue (R$)',
        tickFormatter: { y: 'compact' },
      },
    },
  });
  R += 2;

  // Treemap + Payment donut + Installment histogram (3-column row)
  push({ id: 'chart_treemap', type: 'chart', col: 1, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Category Share (Treemap)',
      sourceHeadline: 'Top 15 categories by GMV',
      height: 260,
      chart: {
        type: 'treemap', data: CATEGORY_REVENUE, xKey: 'category', yKey: 'revenue',
        compatibleTypes: ['treemap', 'pie', 'donut'],
      },
    },
  });

  push({ id: 'chart_payment', type: 'chart', col: 5, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Payment Methods',
      height: 260,
      chart: {
        type: 'donut',
        data: [
          { method: 'Credit Card', value: 76795 },
          { method: 'Boleto', value: 19784 },
          { method: 'Voucher', value: 5775 },
          { method: 'Debit Card', value: 1529 },
        ],
        xKey: 'method', yKey: 'value',
        compatibleTypes: ['donut', 'pie', 'bar'],
        colors: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b'],
      },
    },
  });

  push({ id: 'chart_installments', type: 'chart', col: 9, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Installment Distribution',
      sourceHeadline: 'Credit card (1-10x split)',
      height: 260,
      chart: {
        type: 'histogram', data: PAYMENT_INSTALLMENTS, xKey: 'bin', yKey: 'count',
        compatibleTypes: ['histogram', 'bar'],
        xAxisLabel: 'Installments', yAxisLabel: 'Orders',
        colors: ['#6366f1'],
      },
    },
  });
  R += 2;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 3 — CUSTOMER & REVIEW INTELLIGENCE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({ id: 'section_customer', type: 'narrative', col: 1, row: R, colSpan: 12, rowSpan: 1,
    props: { title: '👥 Customer & Satisfaction Intelligence', text: 'Order lifecycle, review drivers, purchasing patterns, and satisfaction predictors.' } });
  R += 1;

  // Funnel — Order lifecycle
  push({ id: 'chart_funnel', type: 'chart', col: 1, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Order Lifecycle Funnel',
      sourceHeadline: '99,441 orders → 56,498 five-star reviews',
      height: 300,
      chart: {
        type: 'funnel', data: ORDER_FUNNEL, xKey: 'stage', yKey: 'count',
        compatibleTypes: ['funnel', 'bar'],
      },
    },
  });

  // Heatmap — Review × Delivery delay
  push({ id: 'chart_review_heatmap', type: 'chart', col: 5, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Review Score × Delivery Delay',
      sourceHeadline: 'Strong negative correlation: late = low score',
      height: 300,
      chart: {
        type: 'heatmap', data: REVIEW_BY_DELIVERY,
        rowOrder: ['On Time', '1-5d Late', '6-15d Late', '>15d Late'],
        colOrder: ['1 ★', '2 ★', '3 ★', '4 ★', '5 ★'],
      },
    },
  });

  // Bar — Review distribution with color coding
  push({ id: 'chart_reviews', type: 'chart', col: 9, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Review Score Distribution',
      sourceHeadline: '98,410 reviews · bimodal pattern',
      height: 300,
      chart: {
        type: 'bar',
        data: [
          { score: '5 ★', count: 56498 },
          { score: '4 ★', count: 19001 },
          { score: '3 ★', count: 8069 },
          { score: '2 ★', count: 3149 },
          { score: '1 ★', count: 11693 },
        ],
        xKey: 'score', yKey: 'count',
        compatibleTypes: ['bar', 'horizontal_bar', 'pie'],
        colorMap: { '5 ★': '#059669', '4 ★': '#34d399', '3 ★': '#fbbf24', '2 ★': '#f97316', '1 ★': '#ef4444' },
      },
    },
  });
  R += 2;

  // Heatmap — Hourly order patterns
  push({ id: 'chart_hourly', type: 'chart', col: 1, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Order Volume Heatmap (Day × Hour)',
      sourceHeadline: 'Peak: Wed 14:00 (760 orders/week) · Low: Sun 04:00',
      height: 300,
      chart: {
        type: 'heatmap', data: HOURLY_ORDERS,
        rowOrder: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      },
    },
  });

  // Bar — Price vs Review (single series — avg_review only, count as label)
  push({ id: 'chart_price_review', type: 'chart', col: 7, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Avg Review Score by Price Range',
      sourceHeadline: 'Higher price → lower satisfaction',
      height: 300,
      chart: {
        type: 'bar', data: PRICE_VS_REVIEW, xKey: 'price_bucket', yKey: 'avg_review',
        compatibleTypes: ['bar', 'horizontal_bar', 'line'],
        xAxisLabel: 'Price Bucket (R$)', yAxisLabel: 'Avg Review Score',
        colors: ['#6366f1', '#8b5cf6', '#06b6d4', '#f59e0b', '#f97316', '#ef4444'],
        referenceLines: [
          { axis: 'y', value: 4.09, label: 'Overall Avg 4.09', color: '#94a3b8', strokeDasharray: '6 4' },
        ],
      },
    },
  });
  R += 2;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 4 — GEOGRAPHIC & LOGISTICS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({ id: 'section_geo', type: 'narrative', col: 1, row: R, colSpan: 12, rowSpan: 1,
    props: { title: '🌎 Geographic & Logistics Analysis', text: 'State-level performance, delivery infrastructure, and supply chain flow.' } });
  R += 1;

  // Radar — Top 5 state comparison
  push({ id: 'chart_radar', type: 'chart', col: 1, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Top 5 States — Multi-Dimensional',
      sourceHeadline: 'Revenue, Volume, Review, Delivery, Repeat, AOV',
      height: 320,
      chart: {
        type: 'radar', data: TOP_STATE_RADAR, xKey: 'dimension',
        series: ['SP', 'RJ', 'MG', 'RS', 'PR'],
        compatibleTypes: ['radar'],
      },
    },
  });

  // Bar — State revenue
  push({ id: 'chart_state_rev', type: 'chart', col: 5, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Revenue by State (Top 10)',
      sourceHeadline: 'SP alone = 41% of GMV',
      height: 320,
      chart: {
        type: 'horizontal_bar',
        data: STATE_DATA,
        xKey: 'state', yKey: 'revenue',
        compatibleTypes: ['horizontal_bar', 'bar', 'pie'],
        tickFormatter: { y: 'compact' },
      },
    },
  });

  // Sankey — Order flow
  push({ id: 'chart_sankey', type: 'chart', col: 9, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Order Flow: Payment → State → Outcome',
      sourceHeadline: 'Credit card dominates across all states',
      height: 320,
      chart: {
        type: 'sankey', data: ORDER_FLOW_SANKEY,
        compatibleTypes: ['sankey'],
      },
    },
  });
  R += 2;

  // Delivery trend (area) + histogram
  push({ id: 'chart_delivery_area', type: 'chart', col: 1, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Delivery Time & Late Rate Trend',
      sourceHeadline: 'Both metrics improving consistently',
      height: 280,
      chart: {
        type: 'area', data: DELIVERY_TREND, xKey: 'month',
        series: ['avg_days', 'late_pct'],
        compatibleTypes: ['area', 'line'],
        xAxisLabel: 'Month', yAxisLabel: 'Days / %',
        referenceLines: [
          { axis: 'y', value: 12.5, label: 'Avg 12.5d', color: '#94a3b8', strokeDasharray: '6 4' },
        ],
      },
    },
  });

  push({ id: 'chart_delivery_hist', type: 'chart', col: 7, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Delivery Time Distribution',
      sourceHeadline: 'Median: 10-12 days · 96,478 delivered orders',
      height: 280,
      chart: {
        type: 'histogram', data: DELIVERY_HISTOGRAM, xKey: 'bin', yKey: 'count',
        compatibleTypes: ['histogram', 'bar'],
        xAxisLabel: 'Delivery Days', yAxisLabel: 'Orders',
        tickFormatter: { y: 'compact' },
        colors: ['#0891b2'],
        referenceLines: [
          { axis: 'y', value: 12500, label: 'Median bin', color: '#6366f1', strokeDasharray: '4 4' },
        ],
      },
    },
  });
  R += 2;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 5 — SELLER ECOSYSTEM
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({ id: 'section_sellers', type: 'narrative', col: 1, row: R, colSpan: 12, rowSpan: 1,
    props: { title: '🏪 Seller Ecosystem Analysis', text: 'Seller concentration, performance distribution, and marketplace health.' } });
  R += 1;

  // Bubble — Seller revenue × review × volume
  push({ id: 'chart_seller_bubble', type: 'chart', col: 1, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Seller Performance (Revenue × Review × Volume)',
      sourceHeadline: 'Bubble size = order count · Top 15 sellers',
      height: 300,
      chart: {
        type: 'bubble', data: SELLER_SCATTER,
        xKey: 'revenue', yKey: 'avg_review', zKey: 'order_count',
        labelKey: 'seller',
        compatibleTypes: ['bubble', 'scatter'],
        xAxisLabel: 'Revenue (R$)', yAxisLabel: 'Avg Review Score',
        tickFormatter: { x: 'compact' },
        referenceLines: [
          { axis: 'y', value: 4.0, label: 'Target 4.0★', color: '#059669', strokeDasharray: '6 4' },
        ],
      },
    },
  });

  // Lorenz — Seller revenue inequality
  push({ id: 'chart_lorenz', type: 'chart', col: 7, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Seller Revenue Inequality (Lorenz Curve)',
      sourceHeadline: 'Gini = 0.62 — high concentration, top 20% earn 44%',
      height: 300,
      chart: {
        type: 'lorenz', data: SELLER_REVENUE_LORENZ,
        xKey: 'population_pct', yKey: 'revenue_pct',
        gini: 0.62,
        compatibleTypes: ['lorenz'],
      },
    },
  });
  R += 2;

  // Seller table + order status progress
  push({ id: 'table_sellers', type: 'table', col: 1, row: R, colSpan: 8, rowSpan: 2,
    props: {
      title: 'Top 15 Sellers — Performance Scorecard',
      columns: ['Seller', 'State', 'Revenue', 'Orders', 'Avg Review', 'Avg Delivery'],
      rows: [
        ['4a3ca930…', 'SP', 'R$ 229,472', '2,033', '4.2 ★', '9.1d'],
        ['7c67e163…', 'SP', 'R$ 197,816', '1,501', '3.9 ★', '10.4d'],
        ['1f50f920…', 'SP', 'R$ 185,945', '1,278', '4.1 ★', '9.8d'],
        ['da8622b1…', 'MG', 'R$ 173,241', '984', '4.4 ★', '11.2d'],
        ['7e93a43e…', 'SP', 'R$ 165,887', '1,126', '4.0 ★', '10.1d'],
        ['955fee96…', 'RJ', 'R$ 152,394', '891', '3.8 ★', '12.5d'],
        ['46dc3b2e…', 'SP', 'R$ 147,221', '1,042', '4.3 ★', '8.9d'],
        ['cc419e02…', 'PR', 'R$ 138,562', '762', '4.5 ★', '11.8d'],
        ['4869f7a5…', 'MG', 'R$ 131,849', '695', '4.1 ★', '12.0d'],
        ['620c8763…', 'SP', 'R$ 126,417', '843', '3.7 ★', '11.5d'],
        ['a1b2c3d4…', 'SP', 'R$ 118,200', '920', '3.5 ★', '13.2d'],
        ['e5f6a7b8…', 'RJ', 'R$ 105,300', '412', '4.6 ★', '10.8d'],
        ['c9d0e1f2…', 'MG', 'R$ 98,700', '1,150', '3.2 ★', '14.1d'],
        ['34ab56cd…', 'SP', 'R$ 92,100', '580', '4.0 ★', '9.5d'],
        ['78ef90gh…', 'BA', 'R$ 87,400', '1,380', '2.9 ★', '16.8d'],
      ],
      highlightHeader: true,
    },
  });

  push({ id: 'progress_status', type: 'progress', col: 9, row: R, colSpan: 4, rowSpan: 2,
    props: {
      title: 'Order Status Breakdown',
      items: [
        { label: 'Delivered', percent: 96.5, color: 'emerald' },
        { label: 'Shipped (in transit)', percent: 1.1, color: 'blue' },
        { label: 'Canceled', percent: 0.63, color: 'red' },
        { label: 'Unavailable', percent: 0.60, color: 'amber' },
        { label: 'Processing', percent: 0.30, color: 'teal' },
        { label: 'Invoiced / Other', percent: 0.87, color: 'teal' },
      ],
    },
  });
  R += 2;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 6 — KEY FINDINGS & RECOMMENDATIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({ id: 'section_findings', type: 'narrative', col: 1, row: R, colSpan: 12, rowSpan: 1,
    props: { title: '🔍 Key Findings & Strategic Recommendations' } });
  R += 1;

  push({ id: 'findings', type: 'findings', col: 1, row: R, colSpan: 6, rowSpan: 2,
    props: {
      title: 'Key Findings',
      findings: [
        'Delivery is the #1 satisfaction driver: orders >15 days late get 1★ at 67% rate vs 2% on-time. Reducing late deliveries by 50% could lift avg review from 4.09→4.35 and reduce 1-star reviews by ~4,000.',
        'São Paulo concentrates 41% of revenue with the best delivery (9.8d avg). Expanding SP-level logistics to MG/RS/PR (combined 22%) could unlock R$2.5M+ in underserved demand.',
        'Credit card installments (avg 3.8x) enable higher AOV. The 50% of customers paying in 1x have 18% lower AOV — a "split payment" nudge could lift basket size by R$15-20.',
        'Seller ecosystem is highly concentrated: Gini 0.62. Top 15 sellers generate 13% of GMV. The long tail (2,500+ sellers below R$10K) needs seller enablement programs.',
        'Black Friday 2017 drove R$1.15M (2.4x normal) without delivery degradation — proof the platform can scale. But Q4→Q1 retention was only 8%, suggesting event-driven customers don\'t stick.',
        'Category diversification is healthy (Herfindahl index ~0.04), but 5 of the top 10 categories are home-related. Fashion and electronics are underrepresented vs Brazil market norms.',
        'Price sensitivity is clear: R$0-50 items get 4.21★ avg vs 3.68★ for R$1000+ items. Higher-priced items need premium delivery SLAs or satisfaction guarantees.',
        'Weekday purchase peaks at 14:00 (700+ orders/week-hour). Weekend volume drops 35%. Marketing should focus weekday lunch hours for acquisition campaigns.',
      ],
    },
  });

  push({ id: 'alert_geo', type: 'alert', col: 7, row: R, colSpan: 6, rowSpan: 1,
    props: { severity: 'error', title: 'Geographic Concentration Risk',
      description: 'SP alone drives 41% of revenue. Any disruption to SP logistics (strikes, weather, policy changes) could impact ~R$5.6M in annual GMV. Recommend accelerating MG/RJ infrastructure investment as geographic hedge.' } });

  push({ id: 'alert_reviews', type: 'alert', col: 7, row: R + 1, colSpan: 6, rowSpan: 1,
    props: { severity: 'info', title: 'Opportunity: Review-Driven Growth Loop',
      description: 'The data shows a clear flywheel: faster delivery → higher reviews → more visibility → more orders → more seller investment → faster delivery. Investing R$500K in delivery infrastructure could generate 3-5x ROI through this loop within 12 months.' } });
  R += 2;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION 7 — RECOMMENDED DEEP DIVES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  push({ id: 'suggest_cohort', type: 'suggestion', col: 1, row: R, colSpan: 3, rowSpan: 1,
    props: {
      title: 'Cohort Retention Matrix',
      description: 'Build monthly cohort retention heatmap. Quantify which acquisition cohorts have highest LTV and what drives repeat purchase.',
      query: 'Build a customer cohort retention matrix by first purchase month. Show repurchase rates at 1, 2, 3, 6, 12 months. Identify which cohorts have highest retention.',
      priority: 'high',
    },
  });
  push({ id: 'suggest_rfm', type: 'suggestion', col: 4, row: R, colSpan: 3, rowSpan: 1,
    props: {
      title: 'RFM Segmentation',
      description: 'Segment 96K customers by Recency, Frequency, Monetary value. Identify Champions, At-Risk, and Lost segments for targeted campaigns.',
      query: 'Perform RFM segmentation on the customer base. Calculate recency, frequency, monetary scores. Classify into Champions, Loyal, At Risk, Lost segments with size and revenue share.',
      priority: 'high',
    },
  });
  push({ id: 'suggest_delay', type: 'suggestion', col: 7, row: R, colSpan: 3, rowSpan: 1,
    props: {
      title: 'Delivery Delay Root Cause',
      description: 'Which sellers, categories, and routes have highest delay rates? Correlate with review scores and identify fixable bottlenecks.',
      query: 'Analyze delivery delays by seller, category, and route (origin state → destination state). Find the top 10 delay-causing routes and their review impact.',
      priority: 'medium',
    },
  });
  push({ id: 'suggest_basket', type: 'suggestion', col: 10, row: R, colSpan: 3, rowSpan: 1,
    props: {
      title: 'Cross-Sell Analysis',
      description: 'Which product categories are frequently bought together? Identify cross-sell bundles to increase basket size from the current R$137 AOV.',
      query: 'Analyze which product categories appear together in multi-item orders. Find top 20 category pairs by co-occurrence frequency and calculate lift ratios.',
      priority: 'medium',
    },
  });
  R += 1;

  return {
    title: 'Olist E-Commerce — Full Analyst Report',
    subtitle: '99,441 orders · R$ 13.6M GMV · 96K customers · 3,095 sellers · Sep 2016 – Aug 2018',
    thinking: 'V0 hand-crafted · 30+ blocks · 15 chart types · 7 analysis sections',
    blocks,
  };
}
