/**
 * Negotiation Game Type Definitions — CFR+ Game Theory Engine
 *
 * Defines the domain-specific types, constants, and action spaces
 * for modeling procurement negotiation as an extensive-form game.
 *
 * Key mapping:  Poker concept → Procurement concept
 *   Card ranks  → Position strength buckets (buyer's leverage)
 *   Streets     → Negotiation rounds (OPENING, CONCESSION, CLOSING)
 *   Hole cards  → Supplier type (private info: aggressive/cooperative/desperate)
 *   Actions     → accept / reject / counter
 */

// ---------------------------------------------------------------------------
// Negotiation Rounds (mapped to poker streets)
// ---------------------------------------------------------------------------

export const ROUNDS = Object.freeze({
  OPENING: 'OPENING',       // Initial offer exchange (≈ flop)
  CONCESSION: 'CONCESSION', // Concession & trade-offs (≈ turn)
  CLOSING: 'CLOSING',       // Final decision (≈ river)
});

export const ROUND_ORDER = [ROUNDS.OPENING, ROUNDS.CONCESSION, ROUNDS.CLOSING];

// ---------------------------------------------------------------------------
// Player Identifiers
// ---------------------------------------------------------------------------

export const PLAYERS = Object.freeze({
  BUYER: 0,
  SUPPLIER: 1,
});

// ---------------------------------------------------------------------------
// Actions — 3 per player per round (MVP)
// ---------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  ACCEPT: 'accept',
  REJECT: 'reject',
  COUNTER: 'counter',
});

/** Ordered action list (index matters for CFR arrays). */
export const ACTION_LIST = [ACTIONS.ACCEPT, ACTIONS.REJECT, ACTIONS.COUNTER];

export const ACTION_INDEX = Object.freeze({
  [ACTIONS.ACCEPT]: 0,
  [ACTIONS.REJECT]: 1,
  [ACTIONS.COUNTER]: 2,
});

// ---------------------------------------------------------------------------
// Supplier Types (chance node — replaces card dealing)
// ---------------------------------------------------------------------------

export const SUPPLIER_TYPES = Object.freeze({
  AGGRESSIVE: 'AGGRESSIVE',     // Hardball negotiator, tight on price
  COOPERATIVE: 'COOPERATIVE',   // Reasonable, willing to deal
  DESPERATE: 'DESPERATE',       // Needs the order, will concede
});

export const SUPPLIER_TYPE_LIST = [
  SUPPLIER_TYPES.AGGRESSIVE,
  SUPPLIER_TYPES.COOPERATIVE,
  SUPPLIER_TYPES.DESPERATE,
];

/**
 * Derive supplier type probability distribution from KPI metrics.
 *
 * @param {{ on_time_rate?: number, defect_rate?: number }} kpis
 * @returns {{ AGGRESSIVE: number, COOPERATIVE: number, DESPERATE: number }}
 */
export function computeSupplierTypePriors(kpis = {}) {
  const onTime = Number(kpis.on_time_rate);
  const defect = Number(kpis.defect_rate);

  // Default: uniform distribution when data unavailable
  if (!Number.isFinite(onTime)) {
    return { AGGRESSIVE: 1 / 3, COOPERATIVE: 1 / 3, DESPERATE: 1 / 3 };
  }

  // Classification based on supplier performance signals:
  // - on_time < 80%: likely aggressive (stalling, leverage plays)
  // - on_time 80-95%: cooperative baseline
  // - on_time > 95% + high defect: desperate (overcapacity, quality issues)
  let aggressive = 0;
  let cooperative = 0;
  let desperate = 0;

  if (onTime < 0.80) {
    aggressive = 0.60;
    cooperative = 0.30;
    desperate = 0.10;
  } else if (onTime <= 0.95) {
    aggressive = 0.20;
    cooperative = 0.60;
    desperate = 0.20;
  } else {
    // on_time > 95%
    aggressive = 0.10;
    cooperative = 0.40;
    desperate = 0.50;
  }

  // Defect rate adjusts toward desperate (quality issues signal overcapacity)
  if (Number.isFinite(defect) && defect > 0.05) {
    const shift = Math.min(0.20, defect);
    desperate += shift;
    cooperative -= shift / 2;
    aggressive -= shift / 2;
  }

  // Normalize to ensure probabilities sum to 1
  const total = aggressive + cooperative + desperate;
  return {
    AGGRESSIVE: aggressive / total,
    COOPERATIVE: cooperative / total,
    DESPERATE: desperate / total,
  };
}

// ---------------------------------------------------------------------------
// Position Strength Buckets (buyer's leverage from risk signals)
// ---------------------------------------------------------------------------

export const POSITION_BUCKETS = Object.freeze({
  VERY_WEAK: 0,
  WEAK: 1,
  NEUTRAL: 2,
  STRONG: 3,
  VERY_STRONG: 4,
});

export const POSITION_BUCKET_NAMES = Object.freeze({
  0: 'VERY_WEAK',
  1: 'WEAK',
  2: 'NEUTRAL',
  3: 'STRONG',
  4: 'VERY_STRONG',
});

export const NUM_POSITION_BUCKETS = 5;

// ---------------------------------------------------------------------------
// Terminal Payoff Configuration
// ---------------------------------------------------------------------------

/**
 * Payoff parameters for terminal node evaluation.
 * All values normalized to [-1, 1] range for CFR convergence stability.
 */
export const PAYOFF_CONFIG = Object.freeze({
  /** Buyer payoff when both agree on standard terms */
  AGREEMENT_BASE: 0.3,
  /** Extra payoff per counter concession achieved */
  CONCESSION_BONUS: 0.15,
  /** Penalty for buyer walk-away (supply chain disruption cost) */
  WALKAWAY_PENALTY_BUYER: -0.4,
  /** Supplier payoff on buyer walk-away (lose the order) */
  WALKAWAY_PENALTY_SUPPLIER: -0.2,
  /** Reject in early rounds: small cost (time/relationship) */
  REJECT_COST: -0.05,
  /** Supplier type advantage multiplier (desperate concedes more) */
  TYPE_ADVANTAGE: {
    AGGRESSIVE: -0.10,   // harder to extract value from
    COOPERATIVE: 0.00,   // neutral
    DESPERATE: 0.15,     // easier to extract value
  },
  /** Position strength advantage (per bucket level above NEUTRAL) */
  POSITION_ADVANTAGE_PER_LEVEL: 0.08,
});

// ---------------------------------------------------------------------------
// Option-to-CFR-Action Mapping
// ---------------------------------------------------------------------------

/**
 * Maps existing negotiation options (from negotiationOptionsGenerator) to CFR actions.
 * Used in Step 3.5 orchestrator integration.
 */
export const OPTION_TO_CFR_ACTION = Object.freeze({
  opt_001: ACTIONS.COUNTER,  // Budget +10% → price concession
  opt_002: ACTIONS.COUNTER,  // MOQ relax → quantity flexibility
  opt_003: ACTIONS.COUNTER,  // Pack rounding → further flexibility
  opt_004: ACTIONS.COUNTER,  // Expedite → premium action
  opt_005: ACTIONS.ACCEPT,   // Safety stock → accept higher cost
  opt_006: ACTIONS.ACCEPT,   // Target -5% → accept weaker terms
});

/**
 * CFR influence weight for blending with lexicographic ranking.
 * final_rank = original_rank_score × (1 - cfr_influence) + cfr_ev × cfr_influence
 */
export const DEFAULT_CFR_INFLUENCE = 0.30;

export default {
  ROUNDS,
  ROUND_ORDER,
  PLAYERS,
  ACTIONS,
  ACTION_LIST,
  ACTION_INDEX,
  SUPPLIER_TYPES,
  SUPPLIER_TYPE_LIST,
  computeSupplierTypePriors,
  POSITION_BUCKETS,
  POSITION_BUCKET_NAMES,
  NUM_POSITION_BUCKETS,
  PAYOFF_CONFIG,
  OPTION_TO_CFR_ACTION,
  DEFAULT_CFR_INFLUENCE,
};
