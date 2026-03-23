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

import { selectRecipe as _selectRecipe, buildRecipePrompt as _buildRecipePrompt } from './analysisRecipeCatalog.js';

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

  if (domainKey === 'supply_chain') {
    return SUPPLY_CHAIN_ENRICHMENT;
  }
  return '';
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
export function buildChallengerInstruction({ answerContract, domainKey, primaryBrief = null }) {
  let instruction = domainKey === 'supply_chain'
    ? SUPPLY_CHAIN_CHALLENGER_INSTRUCTION
    : GENERIC_CHALLENGER_INSTRUCTION;

  // When primary output is available (auto-escalation path), inject summary for targeted critique
  if (primaryBrief) {
    const headline = primaryBrief.headline || '';
    const findings = Array.isArray(primaryBrief.key_findings) ? primaryBrief.key_findings.slice(0, 5) : [];
    const caveats = Array.isArray(primaryBrief.caveats) ? primaryBrief.caveats.slice(0, 3) : [];
    const primarySummary = [
      headline,
      ...findings,
      ...(caveats.length > 0 ? ['Caveats: ' + caveats.join('; ')] : []),
    ].filter(Boolean).join('\n- ');

    if (primarySummary) {
      instruction += `\n\nPRIMARY AGENT SUMMARY (for targeted critique):
- ${primarySummary}

Your job: (a) verify these numbers are mathematically consistent with the data, (b) identify what the primary missed or got wrong, (c) provide an alternative methodology as instructed above.`;
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

export default {
  detectDomain,
  buildDomainEnrichmentPrompt,
  buildParameterSweepInstruction,
  buildChallengerInstruction,
  buildJudgeDomainCriteria,
  extractSupplyChainParams,
  extractBriefSafetyStockValues,
  verifyFormulaConsistency,
  isParameterOptimizationQuestion,
};
