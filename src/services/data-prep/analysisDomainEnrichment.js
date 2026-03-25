/**
 * analysisDomainEnrichment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Domain knowledge enrichment for the analysis pipeline.
 *
 * Detects question domain (supply chain, finance, marketing, etc.) and injects
 * canonical formulas, methodology alternatives, and parameter guidance into
 * agent prompts, challenger instructions, and judge evaluation criteria.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { selectRecipe as _selectRecipe, buildRecipePrompt as _buildRecipePrompt } from '../charts/analysisRecipeCatalog.js';

// ── Domain Detection Patterns ────────────────────────────────────────────────

const DOMAIN_CATALOGS = Object.freeze({
  supply_chain: {
    label: 'Supply Chain Inventory',
    patterns: [
      /\bsafety stock\b/i, /\breorder point\b/i, /\breplenishment\b/i,
      /\bEOQ\b/i, /\beconomic order quantity\b/i, /\bservice level\b/i,
      /\binventory polic/i, /\bstock.?out\b/i, /\bfill rate\b/i,
      /\bholding cost\b/i, /\blead time variab/i, /\bdemand variab/i,
      /\bMOQ\b/i, /\bmin(?:imum)? order/i,
      /(安全庫存|安全存量)/, /(補貨點|再訂購點|補貨參數)/,
      /(經濟訂購量)/, /(服務水準|服務水平)/,
      /(庫存策略|庫存政策)/, /(缺貨|斷貨)/,
      /(持有成本)/, /(前置時間|交期).*波動/,
      /(需求波動|需求變異)/, /(補貨量|訂購量)/,
    ],
    concepts: {
      safety_stock: [/\bsafety stock\b/i, /(安全庫存|安全存量)/],
      reorder_point: [/\breorder point\b/i, /\bROP\b/, /(補貨點|再訂購點|補貨參數)/],
      eoq: [/\bEOQ\b/i, /\beconomic order quantity\b/i, /(經濟訂購量)/],
      service_level: [/\bservice level\b/i, /(服務水準|服務水平)/],
      lead_time: [/\blead time\b/i, /(前置時間|交期)/],
      demand_variability: [/\bdemand variab/i, /\bCV\b/, /(需求波動|變異係數)/],
      replenishment: [/\breplenish/i, /(補貨)/],
      inventory_policy: [/\binventory polic/i, /(庫存策略|庫存政策)/],
    },
  },

  general: {
    label: 'General Data Analysis',
    patterns: [
      /\b(EDA|exploratory)\b/i, /\bdistribution\b/i, /\bcorrelation\b/i,
      /\bstatistic/i, /\boutlier/i, /\banomaly\b/i, /\btrend\b/i,
      /\bpattern/i, /\bcluster/i, /\bsegment/i, /\bclassif/i,
      /\bregression\b/i, /\bforecast\b/i, /\bpredict/i,
      /(探索性分析|資料分析|數據分析|統計分析)/,
      /(分布|相關性|離群值|異常值|趨勢|模式|聚類|分群|迴歸)/,
    ],
    concepts: {
      distribution: [/\bdistribution\b/i, /\bhistogram\b/i, /\bskew/i, /(分布|直方圖)/],
      correlation: [/\bcorrelation\b/i, /\brelation/i, /(相關|關聯)/],
      outlier: [/\boutlier/i, /\banomaly\b/i, /(離群值|異常值)/],
      trend: [/\btrend\b/i, /\btime.?series\b/i, /(趨勢|時序)/],
      segmentation: [/\bsegment/i, /\bcluster/i, /\bcohort\b/i, /(分群|聚類|世代)/],
      summary: [/\bsummar/i, /\bdescrib/i, /\boverview\b/i, /(摘要|概覽|描述)/],
    },
  },

  finance: {
    label: 'Finance & Accounting',
    patterns: [
      /\brevenue\b/i, /\bprofit\b/i, /\bmargin\b/i, /\bcost\b/i,
      /\bP&L\b/i, /\bcash flow\b/i, /\bbalance sheet\b/i,
      /\bROI\b/i, /\bROE\b/i, /\bROA\b/i, /\bEBITDA\b/i,
      /\bDSO\b/i, /\bDPO\b/i, /\bworking capital\b/i,
      /\bAR aging\b/i, /\bAP aging\b/i, /\breceivable/i, /\bpayable/i,
      /\bbudget\b/i, /\bvariance\b/i,
      /(營收|利潤|毛利|淨利|成本|現金流)/,
      /(應收帳款|應付帳款|帳齡|週轉天數)/,
      /(預算|差異分析|損益|資產負債)/,
    ],
    concepts: {
      gross_margin: [/\bgross margin\b/i, /\bgross profit\b/i, /(毛利率|毛利)/],
      net_margin: [/\bnet margin\b/i, /\bnet profit\b/i, /(淨利率|淨利)/],
      dso: [/\bDSO\b/, /days sales outstanding/i, /(銷貨天數|應收帳款週轉)/],
      dpo: [/\bDPO\b/, /days payable outstanding/i, /(付款天數|應付帳款週轉)/],
      working_capital: [/\bworking capital\b/i, /(營運資金|周轉金)/],
      revenue_growth: [/\brevenue growth\b/i, /(營收成長|收入增長)/],
      cost_structure: [/\bcost structure\b/i, /\bcost breakdown\b/i, /(成本結構|成本分析)/],
    },
  },

  ecommerce: {
    label: 'E-Commerce & Retail',
    patterns: [
      /\bconversion\b/i, /\bfunnel\b/i, /\bcart\b/i, /\bcheckout\b/i,
      /\bGMV\b/i, /\bAOV\b/i, /\bbasket size\b/i, /\breturn rate\b/i,
      /\brepeat.*purchase\b/i, /\bcustomer.*lifetime\b/i, /\bLTV\b/i,
      /\bretention\b/i, /\bchurn\b/i, /\bcohort\b/i,
      /\bseller\b/i, /\bmerchant\b/i, /\bproduct.*review/i,
      /(轉換率|漏斗|購物車|結帳)/,
      /(客單價|GMV|復購率|留存率|流失率)/,
      /(賣家|商戶|商品評價|退貨率)/,
    ],
    concepts: {
      conversion_rate: [/\bconversion rate\b/i, /(轉換率)/],
      aov: [/\bAOV\b/, /\baverage order\b/i, /(客單價|平均訂單)/],
      gmv: [/\bGMV\b/, /\bgross merchandise\b/i, /(交易總額|GMV)/],
      retention: [/\bretention\b/i, /\brepeat\b/i, /(留存|復購)/],
      churn: [/\bchurn\b/i, /(流失|流失率)/],
      ltv: [/\bLTV\b/, /\blifetime value\b/i, /(客戶終身價值|LTV)/],
      basket_analysis: [/\bbasket\b/i, /\bcross.?sell\b/i, /(購物籃|交叉銷售)/],
    },
  },

  marketing: {
    label: 'Marketing & Growth',
    patterns: [
      /\bCAC\b/i, /\bcustomer acquisition\b/i, /\bCTR\b/i,
      /\bROAS\b/i, /\bcampaign\b/i, /\bad spend\b/i,
      /\bimpression\b/i, /\bclick.?through\b/i, /\bengagement\b/i,
      /\bSEO\b/i, /\bSEM\b/i, /\bchannel\b/i, /\battribution\b/i,
      /(行銷|獲客成本|點擊率|廣告投報率)/,
      /(活動|投放|曝光|互動率|歸因)/,
    ],
    concepts: {
      cac: [/\bCAC\b/, /\bacquisition cost\b/i, /(獲客成本|CAC)/],
      ctr: [/\bCTR\b/, /\bclick.?through\b/i, /(點擊率|CTR)/],
      roas: [/\bROAS\b/, /\breturn on ad\b/i, /(廣告投報率|ROAS)/],
      campaign_roi: [/\bcampaign.*ROI\b/i, /(活動投報)/],
      channel_mix: [/\bchannel mix\b/i, /\battribution\b/i, /(渠道組合|歸因)/],
    },
  },

  hr: {
    label: 'HR & Workforce Analytics',
    patterns: [
      /\bturnover\b/i, /\battrition\b/i, /\bheadcount\b/i,
      /\btenure\b/i, /\bsatisfaction\b/i, /\bperformance review\b/i,
      /\bcompensation\b/i, /\bsalary\b/i, /\babsentee/i,
      /\brecruit/i, /\bhiring\b/i, /\bemployee engagement\b/i,
      /(離職率|員工流失|人數|年資|滿意度)/,
      /(績效考核|薪酬|出勤|招聘|員工參與度)/,
    ],
    concepts: {
      attrition: [/\battrition\b/i, /\bturnover\b/i, /(離職率|流失率)/],
      engagement: [/\bengagement\b/i, /\bsatisfaction\b/i, /(參與度|滿意度)/],
      compensation: [/\bcompensation\b/i, /\bsalary\b/i, /(薪酬|薪資)/],
      productivity: [/\bproductivit/i, /\boutput per\b/i, /(人均產出|生產力)/],
      headcount: [/\bheadcount\b/i, /\bworkforce\b/i, /(人數|人力)/],
    },
  },
});

// ── Domain Detection ─────────────────────────────────────────────────────────

/**
 * Detect the analysis domain from the user message.
 * @param {string} userMessage
 * @returns {{ domainKey: string|null, matchedConcepts: string[], label: string|null }}
 */
export function detectDomain(userMessage) {
  const text = String(userMessage || '');
  for (const [domainKey, catalog] of Object.entries(DOMAIN_CATALOGS)) {
    const domainMatch = catalog.patterns.some((p) => p.test(text));
    if (!domainMatch) continue;

    const matchedConcepts = [];
    for (const [concept, patterns] of Object.entries(catalog.concepts)) {
      if (patterns.some((p) => p.test(text))) {
        matchedConcepts.push(concept);
      }
    }
    return { domainKey, matchedConcepts, label: catalog.label };
  }
  return { domainKey: null, matchedConcepts: [], label: null };
}

// ── Domain Enrichment Prompts ────────────────────────────────────────────────

const SUPPLY_CHAIN_ENRICHMENT = `## Domain Context: Supply Chain Inventory

Canonical formulas (MUST be cited when recommending parameters):
- Safety Stock (FULL formula, preferred): SS = Z × √(LT × σ²_d_daily + d̄_daily² × σ²_LT)
  where Z = service-level z-score, LT = mean lead time (days),
  d̄_daily = mean demand per day, σ_d_daily = std dev of daily demand,
  σ_LT = std dev of lead time (days)
- Safety Stock (simplified, when σ_LT=0): SS = Z × σ_d_daily × √(LT)
- Reorder Point: ROP = d̄_daily × LT + SS
- EOQ: EOQ = √(2DS/H)  where D = annual demand, S = ordering cost, H = holding cost per unit per year

z-scores: 85%→1.036, 90%→1.282, 93%→1.48, 95%→1.645, 97%→1.88, 99%→2.326

Common methodologies:
- Continuous review (Q,R): fixed order quantity Q when inventory hits reorder point R
- Periodic review (T,S): review every T periods, order up to level S
- ABC-XYZ classification: ABC by revenue (A=top 80%, B=next 15%, C=bottom 5%), XYZ by CV (X<0.25, Y<0.50, Z≥0.50)
- Differentiated service levels: A=95%, B=90%, C=85%

CRITICAL: Before computing any statistics, CHECK FOR TREND. If demand grew significantly over
the data period (e.g., platform growth), use only the RECENT STABLE window to compute CV and σ.
Using full-period data with a growth trend will INFLATE CV by 2-5x.

Required output structure:
- ABC-XYZ classification table
- Per-item/category parameter table with ALL intermediate values
- Sensitivity table: SS and ROP at multiple service levels AND (if LT is proxy) multiple assumed LTs
- Formula disclosure: state the exact formula used, all parameter values, and proxy disclosures`;

const GENERAL_ENRICHMENT = `## Domain Context: General Data Analysis

Analytical Framework (apply to ANY dataset):
1. DESCRIPTIVE: summary stats (mean, median, std, quartiles), distributions, missing patterns
2. DIAGNOSTIC: correlations, group comparisons, trend decomposition, anomaly detection
3. PREDICTIVE: regression models, time-series forecasts (if temporal data exists)
4. PRESCRIPTIVE: actionable recommendations based on findings

Statistical Methods (cite when applied):
- Central tendency: Mean, Median, Mode — report all three for skewed data
- Dispersion: Std Dev, IQR, CV (coefficient of variation = σ/μ)
- Distribution shape: Skewness (>1 = right-skewed), Kurtosis (>3 = heavy tails)
- Correlation: Pearson r (linear), Spearman ρ (monotonic) — always report p-value
- Group comparison: t-test (2 groups), ANOVA (3+ groups), Chi-square (categorical)
- Effect size: Cohen's d (small=0.2, medium=0.5, large=0.8)

Required output:
- Data quality summary (rows, columns, missing %, duplicates)
- Per-column type inference and statistical summary
- Top correlations (|r| > 0.5) with scatter plots
- Distribution highlights (skewed columns, outliers)
- Actionable insights with supporting evidence`;

const FINANCE_ENRICHMENT = `## Domain Context: Finance & Accounting

Canonical formulas:
- Gross Margin: (Revenue - COGS) / Revenue × 100%
- Net Margin: Net Income / Revenue × 100%
- DSO (Days Sales Outstanding): (Accounts Receivable / Revenue) × Days
- DPO (Days Payable Outstanding): (Accounts Payable / COGS) × Days
- Working Capital: Current Assets - Current Liabilities
- ROI: (Gain - Cost) / Cost × 100%
- EBITDA Margin: EBITDA / Revenue × 100%

Variance Analysis (MANDATORY for budget vs actual):
- Price Variance: (Actual Price - Standard Price) × Actual Quantity
- Volume Variance: (Actual Quantity - Budgeted Quantity) × Standard Price
- Mix Variance: when multiple products/channels exist

AR/AP Aging Buckets: Current, 1-30, 31-60, 61-90, 90+ days

Required output:
- KPI dashboard (margin %, DSO, DPO, working capital)
- Trend analysis (MoM, QoQ, YoY comparisons)
- Variance decomposition (price × volume × mix)
- Risk flags (aging > 90 days, margin compression, cash flow warnings)`;

const ECOMMERCE_ENRICHMENT = `## Domain Context: E-Commerce & Retail

Key Metrics:
- Conversion Rate: Orders / Sessions × 100%
- AOV (Average Order Value): Revenue / Number of Orders
- GMV (Gross Merchandise Value): Sum of all transaction values
- Repeat Purchase Rate: Customers with 2+ orders / Total customers
- Customer Lifetime Value (LTV): AOV × Purchase Frequency × Avg Customer Lifespan
- Basket Size: Items per Order
- Return Rate: Returned Orders / Total Orders × 100%

Cohort Analysis (MANDATORY for retention):
- Group customers by first-purchase month
- Track retention: % active in month 1, 2, 3... after first purchase
- Visualize as retention heatmap

RFM Segmentation:
- Recency (days since last purchase), Frequency (# orders), Monetary (total spend)
- Score 1-5 per dimension, segment into Champions, Loyal, At Risk, Lost

Funnel Analysis:
- Define stages: Visit → Browse → Add to Cart → Checkout → Purchase
- Calculate drop-off rate between each stage
- Segment by channel, device, customer type

Required output:
- Core metrics (GMV, AOV, Conversion, Repeat Rate)
- Trend charts (daily/weekly/monthly)
- Customer segmentation (RFM or cohort)
- Funnel visualization with drop-off analysis`;

const MARKETING_ENRICHMENT = `## Domain Context: Marketing & Growth

Key Metrics:
- CAC (Customer Acquisition Cost): Total Marketing Spend / New Customers Acquired
- ROAS (Return on Ad Spend): Revenue from Ads / Ad Spend
- CTR (Click-Through Rate): Clicks / Impressions × 100%
- CPC (Cost Per Click): Ad Spend / Clicks
- CPM (Cost Per Mille): Ad Spend / Impressions × 1000
- LTV:CAC Ratio: Customer Lifetime Value / Customer Acquisition Cost (healthy > 3:1)

Attribution Models:
- Last-touch: 100% credit to last interaction before conversion
- First-touch: 100% credit to first interaction
- Linear: equal credit to all touchpoints
- Time-decay: more credit to recent touchpoints

Campaign Analysis Framework:
1. Reach: impressions, unique reach, frequency
2. Engagement: CTR, time on page, scroll depth
3. Conversion: conversion rate, cost per conversion
4. Revenue: ROAS, revenue per click, incremental revenue

Required output:
- Channel performance comparison (CAC, ROAS, CTR by channel)
- Campaign ROI analysis with breakdowns
- Funnel metrics per channel/campaign
- Recommendations on budget allocation`;

const HR_ENRICHMENT = `## Domain Context: HR & Workforce Analytics

Key Metrics:
- Attrition Rate: Departures / Average Headcount × 100% (monthly/annual)
- Voluntary vs Involuntary turnover (separate tracking)
- Employee Engagement Score: survey-based composite (0-100 or 1-5 scale)
- Time to Hire: Days from job posting to offer acceptance
- Cost per Hire: Total recruitment cost / Number of hires
- Revenue per Employee: Total Revenue / Average Headcount
- Absenteeism Rate: Absent Days / Available Days × 100%

Compensation Analysis:
- Compa-Ratio: Actual Salary / Midpoint of Pay Band
- Pay equity: compare across gender, department, tenure (use regression to control for confounders)
- Total Compensation: Base + Variable + Benefits

Tenure & Lifecycle:
- Average tenure by department, role, level
- Survival curve (Kaplan-Meier) for employee retention
- Flight risk indicators: engagement drop, tenure milestone, market conditions

Required output:
- Workforce dashboard (headcount, attrition, engagement)
- Trend analysis (monthly/quarterly)
- Segment breakdowns (department, level, location)
- Actionable risk flags (high attrition teams, pay inequity)`;

/**
 * Build a domain enrichment prompt block for injection into agent system prompts.
 * When a structured recipe matches (domain + concepts + taskType), returns the
 * prescriptive multi-step methodology. Otherwise falls back to static enrichment.
 * @param {string} domainKey
 * @param {string[]} matchedConcepts
 * @param {string|null} taskType — from answer contract
 * @returns {string}
 */
export function buildDomainEnrichmentPrompt(domainKey, matchedConcepts = [], taskType = null) {
  // Try recipe-driven methodology first (imported at top of file)
  if (_selectRecipe && _buildRecipePrompt) {
    const recipe = _selectRecipe(domainKey, matchedConcepts, taskType);
    if (recipe) return _buildRecipePrompt(recipe);
  }

  const ENRICHMENT_MAP = {
    supply_chain: SUPPLY_CHAIN_ENRICHMENT,
    general: GENERAL_ENRICHMENT,
    finance: FINANCE_ENRICHMENT,
    ecommerce: ECOMMERCE_ENRICHMENT,
    marketing: MARKETING_ENRICHMENT,
    hr: HR_ENRICHMENT,
  };
  return ENRICHMENT_MAP[domainKey] || '';
}

// ── Parameter Sweep Instruction ──────────────────────────────────────────────

/**
 * Build mandatory parameter sweep instructions for the agent.
 * Injected when the question is a parameter optimization type.
 * @param {string} domainKey
 * @returns {string}
 */
export function buildParameterSweepInstruction(domainKey) {
  if (domainKey === 'supply_chain') {
    return `MANDATORY SENSITIVITY ANALYSIS:
After computing primary recommendations, you MUST generate an additional "Sensitivity Analysis" table with columns:
["Service Level", "Z-Score", "Safety Stock Formula", "Example Category SS", "ROP Impact"]
Include rows for service levels: 90% (z=1.28), 95% (z=1.645), 99% (z=2.33).
Compute actual SS values from the data for at least one representative category in each row.
This table is REQUIRED — omitting it is a QA failure.`;
  }
  if (domainKey === 'finance') {
    return `MANDATORY SENSITIVITY ANALYSIS:
Generate a scenario comparison table showing impact on key KPIs (margin, DSO, working capital) under:
- Pessimistic (-10% revenue, +5% COGS)
- Base case (current trend)
- Optimistic (+10% revenue, -5% COGS)
This table is REQUIRED.`;
  }
  if (domainKey === 'ecommerce') {
    return `MANDATORY SENSITIVITY ANALYSIS:
Generate a conversion impact table showing revenue change if conversion rate changes by ±1%, ±2%, ±5%.
Include impact on AOV and total orders. This table is REQUIRED.`;
  }
  return '';
}

// ── Challenger Instruction Builder ───────────────────────────────────────────

const GENERIC_CHALLENGER_INSTRUCTION = `You are the CHALLENGER analyst. Provide a genuinely different analytical angle:
1. DIFFERENT METHODOLOGY: If the obvious approach is historical mean, use median or weighted-recent instead.
2. DIFFERENT SCOPE: Focus on the most impactful subset (top decile, worst performers, newest cohort).
3. STRESS TEST: Challenge the most optimistic assumption. What breaks if demand grows 20%?
4. RELATIVE CONTEXT: Emphasize relative positioning (vs. category average, vs. prior period, as % of total).
Do NOT run the same queries with the same framing. Your value is surfacing what the primary answer misses.`;

const SUPPLY_CHAIN_CHALLENGER_INSTRUCTION = `You are the CHALLENGER analyst for a supply chain inventory analysis.

METHODOLOGY DIVERGENCE (MANDATORY — pick a DIFFERENT approach from the obvious one):
- If the primary likely uses continuous-review (Q,R) with z-score, you MUST use periodic-review (T,S) or empirical bootstrap percentile approach.
- If the primary uses historical mean demand, you MUST use median demand or weighted-recent (last 3 months weighted 2x).
- Sweep multiple service levels: compute SS at 90% (z=1.28), 95% (z=1.645), 99% (z=2.33).
- If the primary ignores lead time variability (σ_L), you MUST include it: SS = z × √(L × σ_d² + d̄² × σ_L²).

COVERAGE MANDATE: Cover ALL categories/items in the dataset. Partial coverage is a FAILURE.
If there are 15 categories, your table must have 15 rows. Do not limit to "top 5" or "top 10".

STRESS TEST: What breaks if demand grows 20%? If lead time doubles? Show the impact.

SENSITIVITY TABLE: You MUST produce a sensitivity analysis table showing how SS and ROP change across at least 3 service levels.

FORMULA DISCLOSURE: State every formula you use with all parameter values.`;

/**
 * Build challenger instruction text, with domain-awareness and optional primary output injection.
 * @param {object} params
 * @param {object} params.answerContract
 * @param {string|null} params.domainKey
 * @param {object|null} params.primaryBrief - If available (sequential/auto-escalation path), inject primary summary for targeted critique
 * @returns {string}
 */
const FINANCE_CHALLENGER_INSTRUCTION = `You are the CHALLENGER analyst for a finance/accounting analysis.

METHODOLOGY DIVERGENCE (MANDATORY):
- If the primary uses trailing averages, use growth-adjusted forecasts.
- If the primary focuses on absolute values, you MUST focus on ratios and margins.
- Decompose variances differently (price/volume/mix vs. contribution margin approach).
- Stress test: What happens if revenue drops 15%? If payment terms extend by 15 days?
- Include peer/industry benchmarks where possible.
- Always cross-check totals (revenue - COGS = gross profit, etc.).`;

const ECOMMERCE_CHALLENGER_INSTRUCTION = `You are the CHALLENGER analyst for an e-commerce/retail analysis.

METHODOLOGY DIVERGENCE (MANDATORY):
- If the primary uses aggregate metrics, you MUST segment by customer cohort or channel.
- If the primary focuses on revenue, you MUST focus on unit economics (CAC, LTV, contribution margin).
- Use different time windows for retention analysis (weekly vs monthly cohorts).
- Stress test: What if conversion drops 1%? What if return rate increases 5%?
- Apply RFM segmentation if the primary didn't, or use a different segmentation approach.`;

export function buildChallengerInstruction({ answerContract, domainKey, primaryBrief = null }) {
  const CHALLENGER_MAP = {
    supply_chain: SUPPLY_CHAIN_CHALLENGER_INSTRUCTION,
    finance: FINANCE_CHALLENGER_INSTRUCTION,
    ecommerce: ECOMMERCE_CHALLENGER_INSTRUCTION,
  };
  let instruction = CHALLENGER_MAP[domainKey] || GENERIC_CHALLENGER_INSTRUCTION;

  // When primary output is available (auto-escalation path), inject summary for targeted critique
  if (primaryBrief) {
    const headline = primaryBrief.headline || '';
    const findings = Array.isArray(primaryBrief.key_findings) ? primaryBrief.key_findings.slice(0, 5) : [];
    const caveats = Array.isArray(primaryBrief.caveats) ? primaryBrief.caveats.slice(0, 3) : [];
    const metrics = Array.isArray(primaryBrief.metric_pills)
      ? primaryBrief.metric_pills.slice(0, 8).map((m) => `${m.label}: ${m.value}`).join(', ')
      : '';
    const tables = Array.isArray(primaryBrief.tables)
      ? primaryBrief.tables.slice(0, 2).map((t) => {
        const header = Array.isArray(t.columns) ? t.columns.join(' | ') : '';
        const rows = Array.isArray(t.rows) ? t.rows.slice(0, 5).map((r) => (Array.isArray(r) ? r.join(' | ') : '')).join('\n  ') : '';
        return `  ${t.title || 'Table'}:\n  ${header}\n  ${rows}`;
      }).join('\n')
      : '';
    const primarySummary = [
      headline,
      ...findings,
      ...(caveats.length > 0 ? ['Caveats: ' + caveats.join('; ')] : []),
    ].filter(Boolean).join('\n- ');

    if (primarySummary) {
      instruction += `\n\nPRIMARY AGENT SUMMARY (for targeted critique):
- ${primarySummary}${metrics ? `\n\nPrimary Metrics: ${metrics}` : ''}${tables ? `\n\nPrimary Evidence Tables:\n${tables}` : ''}

Your job: (a) verify these numbers are mathematically consistent with the data — cross-check by running your own query_sap_data or run_python_analysis on the same dataset, (b) identify what the primary missed or got wrong, (c) provide an alternative methodology as instructed above.`;
    }
  }

  return instruction;
}

// ── Judge Domain Criteria ────────────────────────────────────────────────────

/**
 * Build domain-specific evaluation criteria for the judge prompt.
 * @param {string} domainKey
 * @returns {string}
 */
export function buildJudgeDomainCriteria(domainKey) {
  if (domainKey === 'supply_chain') {
    return `## Domain Evaluation Criteria (Supply Chain Inventory)
When judging supply chain analysis (safety stock, replenishment, inventory parameters):
- FORMULA CORRECTNESS: Verify that SS = Z × √(LT × σ²_d + d̄² × σ²_LT) (full) or SS = Z × σ_d × √(LT) (simplified) is correctly applied. Check z-scores match service levels (z=1.036→85%, z=1.282→90%, z=1.645→95%, z=2.326→99%). Prefer full formula with lead time variability. If candidate's numbers don't match the formula, that is a critical correctness failure.
- COVERAGE COMPLETENESS: The better answer covers MORE items/categories from the dataset. Covering 5 of 15 categories is INCOMPLETE and loses on completeness.
- SENSITIVITY ANALYSIS: Strongly prefer the candidate that shows parameter sensitivity across multiple service levels over one that gives only a single-point recommendation.
- METHODOLOGY TRANSPARENCY: Strongly prefer the candidate that explicitly states its formula and all parameter values. "Based on historical data" is NOT sufficient — the formula must be shown.
- PARAMETER REASONABLENESS: Safety stock should typically be 0.5x-3x of σ_d × √(L/T). Values outside this range should be flagged.
- Lead with domain correctness, then completeness, then methodology — writing style is the lowest priority.`;
  }
  if (domainKey === 'finance') {
    return `## Domain Evaluation Criteria (Finance & Accounting)
- ARITHMETIC CONSISTENCY: Revenue - COGS = Gross Profit. Check totals add up.
- RATIO CORRECTNESS: Margins should be calculated from correct base. DSO/DPO formulas must match stated definitions.
- TREND ANALYSIS: Prefer answers that show period-over-period change (MoM, QoQ, YoY) over static snapshots.
- VARIANCE DECOMPOSITION: If budget vs actual is discussed, prefer decomposition (price × volume × mix) over simple percentage change.
- COMPLETENESS: Cover all financial dimensions present in the data — do not cherry-pick only favorable metrics.`;
  }
  if (domainKey === 'ecommerce') {
    return `## Domain Evaluation Criteria (E-Commerce & Retail)
- METRIC DEFINITIONS: Conversion rate denominator matters (sessions vs visitors). AOV should use orders, not sessions.
- SEGMENTATION: Prefer answers that break down by customer segment, channel, or cohort over aggregate-only analysis.
- RETENTION ANALYSIS: If cohort data is available, the better answer includes a retention curve or heatmap.
- UNIT ECONOMICS: Prefer answers that calculate CAC and LTV, not just top-line revenue.
- ACTIONABILITY: Prefer recommendations tied to specific, measurable actions (e.g., "improve cart-to-checkout rate" vs "increase sales").`;
  }
  if (domainKey === 'general') {
    return `## Domain Evaluation Criteria (General Data Analysis)
- STATISTICAL RIGOR: Prefer answers that state methodology, assumptions, and limitations.
- EVIDENCE-FIRST: Prefer answers backed by actual data queries over narrative-only claims.
- DISTRIBUTION AWARENESS: Prefer answers that check distribution shape before applying mean-based methods.
- OUTLIER HANDLING: Prefer answers that acknowledge and handle outliers explicitly.
- COMPLETENESS: Cover all columns/dimensions in the data — do not analyze only a subset without justification.`;
  }
  return '';
}

// ── Formula Verification Helpers ─────────────────────────────────────────────

/**
 * Extract supply chain parameters from SQL query result rows for formula verification.
 * Looks for columns like avg_monthly_demand, sd_monthly_demand, avg_lead_time_days, etc.
 * @param {Array} toolCalls
 * @returns {Array<{category: string, demand_mean: number, demand_std: number, lead_time_days: number}>}
 */
export function extractSupplyChainParams(toolCalls) {
  const params = [];
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    if (tc?.name !== 'query_sap_data' || !tc?.result?.success) continue;
    const rows = tc?.result?.result?.rows || tc?.result?.rows || [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const category = row.category || row.product_category || row.item || row.material || null;
      const demandMean = Number(row.avg_monthly_demand ?? row.demand_mean ?? row.avg_demand ?? NaN);
      const demandStd = Number(row.sd_monthly_demand ?? row.demand_std ?? row.std_demand ?? row.demand_stddev ?? NaN);
      const leadTimeDays = Number(row.avg_lead_time_days ?? row.lead_time_days ?? row.avg_leadtime ?? NaN);
      const leadTimeStd = Number(row.sd_lead_time_days ?? row.lead_time_std ?? row.std_lt ?? row.leadtime_std ?? NaN);
      if (category && Number.isFinite(demandMean) && Number.isFinite(demandStd) && Number.isFinite(leadTimeDays)) {
        params.push({
          category,
          demand_mean: demandMean,
          demand_std: demandStd,
          lead_time_days: leadTimeDays,
          lead_time_std: Number.isFinite(leadTimeStd) ? leadTimeStd : null,
        });
      }
    }
  }
  return params;
}

/**
 * Extract safety stock values from brief tables for verification.
 * @param {object} brief
 * @returns {Array<{category: string, safety_stock: number}>}
 */
export function extractBriefSafetyStockValues(brief) {
  const values = [];
  for (const table of Array.isArray(brief?.tables) ? brief.tables : []) {
    const columns = Array.isArray(table?.columns) ? table.columns.map((c) => String(c || '').toLowerCase()) : [];
    const ssColIdx = columns.findIndex((c) => /safety.?stock|安全庫存|ss/i.test(c));
    const catColIdx = columns.findIndex((c) => /cate|品類|item|material|類別/i.test(c));
    if (ssColIdx < 0 || catColIdx < 0) continue;
    for (const row of Array.isArray(table?.rows) ? table.rows : []) {
      const cells = Array.isArray(row) ? row : columns.map((c) => row?.[c]);
      const category = String(cells[catColIdx] || '');
      const ss = Number(String(cells[ssColIdx] || '').replace(/[^0-9.]/g, ''));
      if (category && Number.isFinite(ss) && ss > 0) {
        values.push({ category, safety_stock: ss });
      }
    }
  }
  return values;
}

/**
 * Verify formula consistency between brief safety stock values and SQL evidence.
 * Returns array of inconsistency findings.
 * @param {object} brief
 * @param {Array} toolCalls
 * @param {string} domainKey
 * @param {number} [serviceZ=1.645] — assumed z-score if not stated (95%)
 * @param {number} [tolerancePct=0.20] — tolerance for mismatch (20%)
 * @returns {string[]}
 */
export function verifyFormulaConsistency(brief, toolCalls, domainKey, serviceZ = 1.645, tolerancePct = 0.20) {
  if (domainKey !== 'supply_chain') return [];

  const sqlParams = extractSupplyChainParams(toolCalls);
  const briefValues = extractBriefSafetyStockValues(brief);
  if (sqlParams.length === 0 || briefValues.length === 0) return [];

  const findings = [];
  for (const bv of briefValues) {
    const match = sqlParams.find((p) =>
      p.category.toLowerCase() === bv.category.toLowerCase()
      || bv.category.toLowerCase().includes(p.category.toLowerCase())
      || p.category.toLowerCase().includes(bv.category.toLowerCase())
    );
    if (!match) continue;

    // Full formula: SS = Z × √(LT_periods × σ²_d + d̄² × σ²_LT)
    // Simplified (when σ_LT unknown): SS = Z × σ_d × √(LT_periods)
    const ltPeriods = match.lead_time_days / 30;
    const expectedSS = match.lead_time_std != null
      ? serviceZ * Math.sqrt(ltPeriods * match.demand_std ** 2 + match.demand_mean ** 2 * (match.lead_time_std / 30) ** 2)
      : serviceZ * match.demand_std * Math.sqrt(ltPeriods);
    if (expectedSS <= 0) continue;

    const pctDiff = Math.abs(bv.safety_stock - expectedSS) / expectedSS;
    if (pctDiff > tolerancePct) {
      findings.push(
        `Safety stock for "${bv.category}": brief says ${bv.safety_stock}, but SS = ${serviceZ} × ${match.demand_std.toFixed(1)} × √(${match.lead_time_days}/30) ≈ ${Math.round(expectedSS)} (${(pctDiff * 100).toFixed(0)}% difference)`
      );
    }
  }
  return findings;
}

// ── Detect Parameter Optimization Question ───────────────────────────────────

/**
 * Detect if the question is asking "how much" / "what value" for a parameter.
 * Used to decide whether to inject parameter sweep instructions.
 * @param {string} userMessage
 * @param {string} taskType
 * @returns {boolean}
 */
export function isParameterOptimizationQuestion(userMessage, taskType) {
  if (taskType !== 'recommendation' && taskType !== 'diagnostic' && taskType !== 'mixed') return false;
  return /how much|how many|what.*should.*set|optimal|應該.*多少|設多少|要幾|最佳|怎麼設/i.test(String(userMessage || ''));
}

/**
 * Build optimizer instruction for B agent — reads A's output and improves it.
 * Unlike challenger (independent analysis), optimizer focuses on fixing QA issues.
 *
 * @param {object} params
 * @param {object} params.primaryBrief - A's synthesized brief
 * @param {object} params.primaryQa - A's QA scorecard (issues, blockers, dimension_scores)
 * @param {object[]} params.primaryToolSummary - summarizeToolCallsForPrompt(A's toolCalls)
 * @param {object} [params.answerContract] - answer contract for dimension context
 * @returns {string}
 */
export function buildOptimizerInstruction({ primaryBrief, primaryQa, primaryToolSummary, answerContract }) {
  const headline = primaryBrief?.headline || '';
  const findings = Array.isArray(primaryBrief?.key_findings) ? primaryBrief.key_findings.slice(0, 6) : [];
  const caveats = Array.isArray(primaryBrief?.caveats) ? primaryBrief.caveats.slice(0, 4) : [];
  const metrics = Array.isArray(primaryBrief?.metric_pills)
    ? primaryBrief.metric_pills.slice(0, 8).map((m) => `${m.label}: ${m.value}`).join(', ')
    : '';

  // QA issues are the optimizer's task list
  const blockers = Array.isArray(primaryQa?.blockers) ? primaryQa.blockers : [];
  const issues = Array.isArray(primaryQa?.issues) ? primaryQa.issues : [];
  const qaScore = Number(primaryQa?.score || 0).toFixed(1);
  const dimScores = primaryQa?.dimension_scores || {};

  // Detect if issues are purely narrative (no missing data/dimensions)
  const NARRATIVE_ISSUE_PATTERNS = /restat|verbatim|information.density|redundan|dedup|caveat.*contradict|self.contradictory|duplicate|overlap|clarity|density/i;
  const DATA_ISSUE_PATTERNS = /missing.*dimension|missing.*evidence|zero.row|no.*evidence|chart.*mismatch|incomplete|not.*found/i;
  const allIssueTexts = [...blockers, ...issues].join(' ');
  const narrativeOnlyIssues = NARRATIVE_ISSUE_PATTERNS.test(allIssueTexts) && !DATA_ISSUE_PATTERNS.test(allIssueTexts);

  // Tool calls A already made — include full error messages so optimizer knows why they failed
  const toolSummary = Array.isArray(primaryToolSummary)
    ? primaryToolSummary.map((tc) => {
      const status = tc.success ? `✅ ${tc.rowCount ?? '?'} rows` : `❌ FAILED: ${tc.error || 'unknown error'}`;
      return `- ${tc.name}(${JSON.stringify(tc.args).slice(0, 120)}): ${status}`;
    }).join('\n')
    : 'No tool calls recorded.';

  // Summarize successful data so optimizer doesn't re-query
  const successfulDataSummary = Array.isArray(primaryToolSummary)
    ? primaryToolSummary
      .filter((tc) => tc.success && tc.rowCount > 0)
      .map((tc) => `- ${tc.name}: ${tc.rowCount} rows (${JSON.stringify(tc.args).slice(0, 80)})`)
      .join('\n')
    : '';

  // Dimension gap analysis
  const requiredDims = Array.isArray(answerContract?.required_dimensions) ? answerContract.required_dimensions : [];
  const requiredOutputs = Array.isArray(answerContract?.required_outputs) ? answerContract.required_outputs : [];

  const weakDimensions = Object.entries(dimScores)
    .filter(([, score]) => Number(score) < 7)
    .map(([dim, score]) => `${dim}: ${Number(score).toFixed(1)}/10`)
    .join(', ');

  // Extract failed tool details for optimizer awareness
  const failedToolDetails = Array.isArray(primaryToolSummary)
    ? primaryToolSummary
        .filter(tc => !tc.success)
        .map(tc => `- ❌ ${tc.name}: "${tc.error || 'unknown error'}"`)
        .join('\n')
    : '';

  return `⚠️ ABSOLUTE RULE: You MUST NOT call query_sap_data or run_python_analysis with the same parameters as any PRIMARY TOOL CALL listed below. Duplicate calls will be blocked and return cached results. Violation wastes your iteration budget.

You are the OPTIMIZER agent. The primary agent (A) has completed its analysis but has quality issues (QA score: ${qaScore}/10). Your job is to FIX and IMPROVE A's work — NOT to redo it from scratch.

🚫 CRITICAL: You MUST NOT call query_sap_data for any SQL query that A already executed successfully. Re-querying wastes time and budget. Use A's data directly from the PRIMARY AGENT SUCCESSFUL DATA section below. Only run NEW queries for dimensions or tables A did NOT cover.

== PRIMARY AGENT OUTPUT ==
Headline: ${headline}
Key Findings:
${findings.map((f) => `- ${f}`).join('\n')}
${caveats.length > 0 ? `Caveats:\n${caveats.map((c) => `- ${c}`).join('\n')}` : ''}
${metrics ? `Metrics: ${metrics}` : ''}

== QA ISSUES TO FIX (your task list) ==
${blockers.length > 0 ? `BLOCKERS (must fix):\n${blockers.map((b) => `🔴 ${b}`).join('\n')}` : 'No blockers.'}
${issues.length > 0 ? `Issues:\n${issues.map((iss) => `⚠️ ${iss}`).join('\n')}` : ''}
${weakDimensions ? `Weak dimensions: ${weakDimensions}` : ''}

== PRIMARY TOOL CALLS (already executed) ==
${toolSummary}
${successfulDataSummary ? `\n== PRIMARY AGENT SUCCESSFUL DATA (do NOT re-query) ==\n${successfulDataSummary}\nUse this data directly. Only run NEW queries for dimensions A did NOT cover.\n` : ''}
== SANDBOX CONSTRAINTS ==
run_python_analysis: pandas, numpy, scipy, statsmodels (seasonal_decompose, Holt-Winters, ADF test), sklearn (KMeans, LinearRegression, StandardScaler), calendar, statistics, collections, itertools, datetime, dateutil, math, json, re, copy, decimal, uuid are available.
matplotlib, seaborn, plotly are NOT available. Use generate_chart for visualization.
${failedToolDetails ? `\n== PRIMARY AGENT FAILURES (DO NOT REPEAT) ==\n${failedToolDetails}\nDo NOT attempt the same tool calls that failed above. Use different approaches.\n` : ''}
== YOUR INSTRUCTIONS ==
${narrativeOnlyIssues
    ? `⚠ NARRATIVE-ONLY REPAIR MODE: The QA issues are about writing quality (deduplication, caveats, information density), NOT missing data. You MUST NOT call query_sap_data or generate_chart — A's data is correct. Focus exclusively on rewriting the narrative.
1. Fix ALL blockers listed above by rewriting the brief narrative only.
2. Do NOT re-query any data. A's tool calls are correct and complete.
3. Copy exact numeric values from A's output. Do NOT round or approximate.
4. Rewrite summary/findings/caveats to fix the specific QA issues listed above.`
    : `1. Fix ALL blockers listed above. Each blocker is a specific, actionable item.
2. Fill missing dimensions: ${requiredDims.join(', ') || 'none specified'}. Missing outputs: ${requiredOutputs.join(', ') || 'none'}.
3. Cross-verify key numbers from A's output by running your own query_sap_data or run_python_analysis.
4. Do NOT repeat A's successful tool calls unless you need different parameters.
5. Do NOT start from scratch. Build on A's findings — add what's missing, fix what's wrong.
6. Copy exact numeric values from tool results. Do NOT round or approximate.
7. If A's tool calls covered the data correctly, acknowledge and extend rather than redo.`}

== ANTI-DUPLICATION RULES ==
8. Your output will be compared against A's output by a judge. If you produce a brief that is >70% similar in content to A's brief, you will be scored LOWER than A. Differentiate by:
   - Adding NEW analysis angles A missed (e.g., time trends, category breakdowns, cohort analysis)
   - Providing deeper interpretation of A's existing numbers
   - Fixing specific QA issues WITHOUT restating A's correct findings
9. If A's tool calls already returned the correct data, do NOT re-query. Use A's evidence directly.
10. Your key_findings must contain at least 2 findings NOT present in A's findings.

CRITICAL FORMAT REQUIREMENT: Your final answer MUST be a single valid JSON object matching the schema above. Do NOT output prose, markdown, or any text outside the JSON. Start your response with { and end with }. No exceptions.`;
}

export default {
  detectDomain,
  buildDomainEnrichmentPrompt,
  buildParameterSweepInstruction,
  buildChallengerInstruction,
  buildOptimizerInstruction,
  buildJudgeDomainCriteria,
  extractSupplyChainParams,
  extractBriefSafetyStockValues,
  verifyFormulaConsistency,
  isParameterOptimizationQuestion,
};
