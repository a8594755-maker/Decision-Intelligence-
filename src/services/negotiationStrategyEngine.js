/**
 * Negotiation Strategy Engine
 *
 * Game-theoretic negotiation strategy for procurement negotiations.
 * Evaluates buyer/supplier positions, recommends concessions, and generates
 * counter-offer strategies based on BATNA analysis and multi-round tactics.
 *
 * Strategy Types:
 *   - COMPETITIVE: strong buyer position, push for max concession
 *   - COLLABORATIVE: balanced, aim for win-win
 *   - ACCOMMODATING: weak buyer position, minimize losses
 *
 * Round Tactics:
 *   - OPENING: anchor aggressively, establish range
 *   - CONCESSION: graduated concessions with reciprocity checks
 *   - CLOSING: final offer with deadline pressure
 */

// ── Strategy Configuration ──────────────────────────────────────────────────

const STRATEGY_CONFIG = {
  // Buyer position strength buckets
  position_thresholds: {
    STRONG: { min_score: 70, strategy: 'COMPETITIVE' },
    NEUTRAL: { min_score: 40, strategy: 'COLLABORATIVE' },
    WEAK: { min_score: 0, strategy: 'ACCOMMODATING' },
  },

  // Concession parameters by strategy
  concession_rates: {
    COMPETITIVE: { initial: 0.05, per_round: 0.03, max_total: 0.15 },
    COLLABORATIVE: { initial: 0.10, per_round: 0.05, max_total: 0.25 },
    ACCOMMODATING: { initial: 0.15, per_round: 0.07, max_total: 0.35 },
  },

  // BATNA (Best Alternative To Negotiated Agreement) defaults
  batna_defaults: {
    alternative_supplier_premium_pct: 0.15, // 15% more expensive alternative
    switching_cost_usd: 5000,
    qualification_time_days: 60,
  },

  max_rounds: 3,
};

// ── Strategy Determination ──────────────────────────────────────────────────

/**
 * Determine negotiation strategy based on buyer position analysis.
 *
 * @param {Object} params
 * @param {Object} params.buyerPosition - { risk_score, signals_used }
 * @param {Object} params.supplierKpis  - { on_time_rate, quality_rate, avg_lead_time }
 * @param {number} params.alternativeCount - number of qualified alternative suppliers
 * @param {number} [params.urgency]     - 0-100, how urgently material is needed
 * @returns {{ strategy, positionStrength, reasoning, batna }}
 */
export function determineStrategy({
  buyerPosition = {},
  supplierKpis = {},
  alternativeCount = 0,
  urgency = 50,
} = {}) {
  // Score buyer's negotiating power (0-100)
  let powerScore = 50; // baseline
  const reasoning = [];

  // Factor 1: Alternative suppliers
  if (alternativeCount >= 3) {
    powerScore += 20;
    reasoning.push(`${alternativeCount} alternative suppliers available (+20)`);
  } else if (alternativeCount >= 1) {
    powerScore += 10;
    reasoning.push(`${alternativeCount} alternative supplier(s) available (+10)`);
  } else {
    powerScore -= 15;
    reasoning.push('No alternative suppliers available (-15)');
  }

  // Factor 2: Supplier performance issues
  const onTimeRate = supplierKpis.on_time_rate ?? supplierKpis.onTimeRate ?? 1;
  if (onTimeRate < 0.80) {
    powerScore += 15;
    reasoning.push(`Poor supplier on-time rate ${(onTimeRate * 100).toFixed(0)}% (+15)`);
  } else if (onTimeRate < 0.90) {
    powerScore += 8;
    reasoning.push(`Below-target on-time rate ${(onTimeRate * 100).toFixed(0)}% (+8)`);
  }

  // Factor 3: Quality issues
  const qualityRate = supplierKpis.quality_rate ?? supplierKpis.qualityRate ?? 1;
  if (qualityRate < 0.95) {
    powerScore += 10;
    reasoning.push(`Quality issues: ${(qualityRate * 100).toFixed(1)}% pass rate (+10)`);
  }

  // Factor 4: Urgency (high urgency weakens buyer)
  if (urgency > 80) {
    powerScore -= 20;
    reasoning.push(`High urgency (${urgency}) weakens position (-20)`);
  } else if (urgency > 60) {
    powerScore -= 10;
    reasoning.push(`Moderate urgency (${urgency}) (-10)`);
  }

  // Factor 5: Risk score (higher risk = more leverage for buyer)
  const riskScore = buyerPosition.risk_score ?? 0;
  if (riskScore > 70) {
    powerScore += 10;
    reasoning.push(`High supplier risk score ${riskScore} gives leverage (+10)`);
  }

  // Clamp
  powerScore = Math.max(0, Math.min(100, powerScore));

  // Determine strategy from power score
  let strategy = 'COLLABORATIVE';
  let positionStrength = 'NEUTRAL';
  for (const [strength, cfg] of Object.entries(STRATEGY_CONFIG.position_thresholds)) {
    if (powerScore >= cfg.min_score) {
      strategy = cfg.strategy;
      positionStrength = strength;
      break;
    }
  }

  // BATNA analysis
  const batna = computeBATNA({ alternativeCount, supplierKpis, urgency });

  return {
    strategy,
    positionStrength,
    powerScore,
    reasoning,
    batna,
  };
}

// ── Counter-Offer Generation ────────────────────────────────────────────────

/**
 * Generate a counter-offer recommendation for the current negotiation round.
 *
 * @param {Object} params
 * @param {string} params.strategy        - 'COMPETITIVE' | 'COLLABORATIVE' | 'ACCOMMODATING'
 * @param {number} params.currentRound    - 0-based round index
 * @param {Object} params.currentTerms    - { price, lead_time, moq, payment_terms }
 * @param {Object} params.targetTerms     - buyer's ideal terms
 * @param {Object} params.supplierLastOffer - supplier's last offer (null for first round)
 * @returns {{ recommendedOffer, tactic, explanation, walkawayThreshold }}
 */
export function generateCounterOffer({
  strategy = 'COLLABORATIVE',
  currentRound = 0,
  currentTerms = {},
  targetTerms = {},
  supplierLastOffer = null,
} = {}) {
  const rates = STRATEGY_CONFIG.concession_rates[strategy] || STRATEGY_CONFIG.concession_rates.COLLABORATIVE;
  const roundNames = ['OPENING', 'CONCESSION', 'CLOSING'];
  const roundName = roundNames[Math.min(currentRound, roundNames.length - 1)];

  // Calculate concession amount for this round
  const concessionRate = currentRound === 0
    ? rates.initial
    : rates.per_round;

  const totalConcessionSoFar = rates.initial + (Math.max(0, currentRound - 1) * rates.per_round);
  const remainingConcession = Math.max(0, rates.max_total - totalConcessionSoFar);

  // Generate recommended terms
  const recommendedOffer = {};
  const explanation = [];

  // Price negotiation
  if (currentTerms.price && targetTerms.price) {
    const gap = currentTerms.price - targetTerms.price;
    if (currentRound === 0) {
      // Opening: anchor below target
      recommendedOffer.price = targetTerms.price - (gap * 0.1);
      explanation.push(`Open at ${formatCurrency(recommendedOffer.price)} (anchor below target)`);
    } else if (supplierLastOffer?.price) {
      // Counter based on supplier's last offer
      const supplierGap = supplierLastOffer.price - targetTerms.price;
      const concession = supplierGap * concessionRate;
      recommendedOffer.price = supplierLastOffer.price - concession;
      explanation.push(`Counter at ${formatCurrency(recommendedOffer.price)} (${(concessionRate * 100).toFixed(0)}% concession from supplier's ${formatCurrency(supplierLastOffer.price)})`);
    } else {
      recommendedOffer.price = targetTerms.price;
      explanation.push(`Hold at target price ${formatCurrency(targetTerms.price)}`);
    }
  }

  // Lead time negotiation
  if (currentTerms.lead_time && targetTerms.lead_time) {
    if (currentRound === 0) {
      recommendedOffer.lead_time = targetTerms.lead_time;
      explanation.push(`Request ${targetTerms.lead_time} day lead time`);
    } else {
      const buffer = Math.ceil((currentTerms.lead_time - targetTerms.lead_time) * concessionRate);
      recommendedOffer.lead_time = targetTerms.lead_time + buffer;
      explanation.push(`Accept ${recommendedOffer.lead_time} day lead time (concession from ${targetTerms.lead_time}d target)`);
    }
  }

  // MOQ negotiation
  if (currentTerms.moq && targetTerms.moq) {
    recommendedOffer.moq = currentRound === 0
      ? targetTerms.moq
      : Math.ceil(targetTerms.moq * (1 + concessionRate));
    explanation.push(`MOQ: ${recommendedOffer.moq} units`);
  }

  // Tactic recommendation
  let tactic = '';
  switch (roundName) {
    case 'OPENING':
      tactic = strategy === 'COMPETITIVE'
        ? 'Set aggressive anchor. Reference market data and alternative quotes.'
        : 'Present fair opening position. Emphasize partnership value.';
      break;
    case 'CONCESSION':
      tactic = strategy === 'COMPETITIVE'
        ? 'Make small, reluctant concessions. Request reciprocity on every point.'
        : 'Offer meaningful concession to build momentum. Package multiple terms.';
      break;
    case 'CLOSING':
      tactic = strategy === 'COMPETITIVE'
        ? 'Present final offer with deadline. Make clear this is BATNA threshold.'
        : 'Summarize mutual gains. Propose final package with clear value for both sides.';
      break;
  }

  // Walk-away threshold
  const walkawayThreshold = {};
  if (targetTerms.price && currentTerms.price) {
    walkawayThreshold.max_price = targetTerms.price * (1 + rates.max_total);
    walkawayThreshold.explanation = `Do not accept above ${formatCurrency(walkawayThreshold.max_price)} (${(rates.max_total * 100).toFixed(0)}% above target)`;
  }

  return {
    roundName,
    recommendedOffer,
    tactic,
    explanation,
    walkawayThreshold,
    remainingConcession: Math.round(remainingConcession * 100) / 100,
    isLastRound: currentRound >= STRATEGY_CONFIG.max_rounds - 1,
  };
}

// ── Outcome Evaluation ──────────────────────────────────────────────────────

/**
 * Evaluate a negotiation outcome and generate a scorecard.
 *
 * @param {Object} params
 * @param {Object} params.agreedTerms  - final agreed terms
 * @param {Object} params.targetTerms  - original target terms
 * @param {Object} params.initialTerms - supplier's initial terms
 * @param {Object} params.batna        - BATNA analysis
 * @returns {{ score, grade, savings, analysis }}
 */
export function evaluateOutcome({
  agreedTerms = {},
  targetTerms = {},
  initialTerms = {},
  batna = {},
} = {}) {
  const analysis = [];
  let totalScore = 0;
  let factorCount = 0;

  // Price performance
  if (agreedTerms.price && targetTerms.price && initialTerms.price) {
    const targetGap = initialTerms.price - targetTerms.price;
    const achievedGap = initialTerms.price - agreedTerms.price;
    const priceScore = targetGap > 0 ? Math.min((achievedGap / targetGap) * 100, 100) : 50;
    totalScore += priceScore;
    factorCount++;

    const savingsPerUnit = initialTerms.price - agreedTerms.price;
    analysis.push({
      factor: 'Price',
      score: Math.round(priceScore),
      detail: `Achieved ${formatCurrency(agreedTerms.price)} vs target ${formatCurrency(targetTerms.price)} (saving ${formatCurrency(savingsPerUnit)}/unit from initial ${formatCurrency(initialTerms.price)})`,
    });
  }

  // Lead time performance
  if (agreedTerms.lead_time && targetTerms.lead_time) {
    const ltScore = agreedTerms.lead_time <= targetTerms.lead_time
      ? 100
      : Math.max(0, 100 - (agreedTerms.lead_time - targetTerms.lead_time) * 10);
    totalScore += ltScore;
    factorCount++;
    analysis.push({
      factor: 'Lead Time',
      score: Math.round(ltScore),
      detail: `Agreed ${agreedTerms.lead_time}d vs target ${targetTerms.lead_time}d`,
    });
  }

  // BATNA comparison
  if (agreedTerms.price && batna.alternativeCost) {
    const bataScore = agreedTerms.price < batna.alternativeCost ? 100 : 50;
    totalScore += bataScore;
    factorCount++;
    analysis.push({
      factor: 'vs BATNA',
      score: Math.round(bataScore),
      detail: `Agreed ${formatCurrency(agreedTerms.price)} vs BATNA ${formatCurrency(batna.alternativeCost)}`,
    });
  }

  const overallScore = factorCount > 0 ? Math.round(totalScore / factorCount) : 50;
  const grade = overallScore >= 85 ? 'A' : overallScore >= 70 ? 'B' : overallScore >= 55 ? 'C' : 'D';

  return {
    score: overallScore,
    grade,
    analysis,
    better_than_batna: agreedTerms.price ? agreedTerms.price < (batna.alternativeCost ?? Infinity) : null,
  };
}

// ── BATNA Analysis ──────────────────────────────────────────────────────────

function computeBATNA({ alternativeCount, supplierKpis, urgency }) {
  const defaults = STRATEGY_CONFIG.batna_defaults;

  const hasAlternative = alternativeCount > 0;
  const alternativePremium = hasAlternative
    ? defaults.alternative_supplier_premium_pct * (1 - (alternativeCount - 1) * 0.03) // More alternatives = lower premium
    : defaults.alternative_supplier_premium_pct * 2; // No alternative = very expensive

  const switchingCost = defaults.switching_cost_usd * (urgency > 70 ? 1.5 : 1.0);
  const qualificationDays = defaults.qualification_time_days * (hasAlternative ? 0.5 : 1.0);

  return {
    hasAlternative,
    alternativePremiumPct: Math.round(alternativePremium * 100) / 100,
    switchingCostUsd: Math.round(switchingCost),
    qualificationTimeDays: Math.round(qualificationDays),
    walkawayRisk: hasAlternative ? 'low' : urgency > 70 ? 'high' : 'medium',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(value) {
  if (value == null || isNaN(value)) return '--';
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const _testExports = {
  computeBATNA,
  STRATEGY_CONFIG,
};
