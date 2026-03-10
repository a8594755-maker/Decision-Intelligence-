/**
 * Negotiation Game Tree Builder — 3-round extensive-form game
 *
 * Builds a CFR-compatible game tree for procurement negotiation.
 * Tree structure:
 *
 *   Root (chance) → sample supplier type (AGGRESSIVE/COOPERATIVE/DESPERATE)
 *     → OPENING round: Buyer acts → Supplier responds
 *       → CONCESSION round: Buyer acts → Supplier responds
 *         → CLOSING round: Buyer acts → Supplier responds → Terminal
 *
 * Node format follows cfr-core.js GameNode interface:
 *   Action:   { type: 'action', player, actions, children, infoSetKey }
 *   Terminal: { type: 'terminal', payoffs: [buyerPayoff, supplierPayoff] }
 *   Chance:   { type: 'chance', outcomes: [{ prob, node }] }
 *
 * Reuses patterns from CardPilot tree builder (BuildState + recursive construction).
 */

import {
  ROUNDS,
  ROUND_ORDER,
  PLAYERS,
  ACTIONS,
  ACTION_LIST,
  SUPPLIER_TYPES,
  SUPPLIER_TYPE_LIST,
  PAYOFF_CONFIG,
  NUM_POSITION_BUCKETS,
} from './negotiation-types.js';

// ---------------------------------------------------------------------------
// Build State — tracks game progression through the tree
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BuildState
 * @property {string}  supplierType  - AGGRESSIVE/COOPERATIVE/DESPERATE
 * @property {number}  buyerBucket   - 0–4 position strength
 * @property {number}  roundIndex    - 0=OPENING, 1=CONCESSION, 2=CLOSING
 * @property {string}  history       - action history string (e.g., 'c:a' = counter then accept)
 * @property {number}  buyerConcessions  - count of counter actions by buyer
 * @property {number}  supplierConcessions - count of counter actions by supplier
 */

// ---------------------------------------------------------------------------
// Info Set Key Construction
// ---------------------------------------------------------------------------

/**
 * Build info set key for a player at a given game state.
 *
 * Buyer sees:  own bucket + round + action history (NOT supplier type)
 * Supplier sees: supplier type + round + action history (NOT buyer bucket)
 *
 * Format: `{player}|{private_info}|{round}|{history}`
 *
 * @param {number}  player       - BUYER(0) or SUPPLIER(1)
 * @param {Object}  state        - BuildState
 * @returns {string}
 */
function buildInfoKey(player, state) {
  const round = ROUND_ORDER[state.roundIndex];
  if (player === PLAYERS.BUYER) {
    return `B|${state.buyerBucket}|${round}|${state.history}`;
  }
  return `S|${state.supplierType}|${round}|${state.history}`;
}

// ---------------------------------------------------------------------------
// Terminal Payoff Computation
// ---------------------------------------------------------------------------

/**
 * Compute terminal payoffs for the buyer given the outcome.
 *
 * @param {string}  outcome  - 'agreement'|'walkaway_buyer'|'walkaway_supplier'
 * @param {Object}  state    - BuildState
 * @returns {number[]} [buyerPayoff, supplierPayoff]
 */
function computePayoffs(outcome, state) {
  const cfg = PAYOFF_CONFIG;
  const typeAdv = cfg.TYPE_ADVANTAGE[state.supplierType] || 0;
  const posAdv = (state.buyerBucket - 2) * cfg.POSITION_ADVANTAGE_PER_LEVEL;

  let buyerPayoff;

  if (outcome === 'agreement') {
    // Base agreement value + concession bonus + positional/type advantages
    buyerPayoff =
      cfg.AGREEMENT_BASE +
      state.buyerConcessions * cfg.CONCESSION_BONUS +
      typeAdv +
      posAdv;
  } else if (outcome === 'walkaway_buyer') {
    // Buyer walks away — heavy penalty for supply chain disruption
    buyerPayoff = cfg.WALKAWAY_PENALTY_BUYER + posAdv * 0.5;
  } else {
    // Supplier walks away — moderate loss (buyer keeps alternatives)
    buyerPayoff = cfg.WALKAWAY_PENALTY_SUPPLIER + posAdv * 0.3 + typeAdv * 0.5;
  }

  // Clamp to [-1, 1] for CFR stability
  buyerPayoff = Math.max(-1, Math.min(1, buyerPayoff));

  // Zero-sum
  return [buyerPayoff, -buyerPayoff];
}

// ---------------------------------------------------------------------------
// Recursive Tree Construction
// ---------------------------------------------------------------------------

/**
 * Build the game subtree starting from a buyer action node at the given round.
 *
 * Each round: Buyer acts → Supplier responds → next round or terminal.
 *
 * @param {Object} state - BuildState
 * @returns {Object} GameNode
 */
function buildBuyerNode(state) {
  // Terminal: all rounds exhausted → agreement by default
  if (state.roundIndex >= ROUND_ORDER.length) {
    return {
      type: 'terminal',
      payoffs: computePayoffs('agreement', state),
    };
  }

  const infoKey = buildInfoKey(PLAYERS.BUYER, state);

  return {
    type: 'action',
    player: PLAYERS.BUYER,
    actions: [...ACTION_LIST],
    infoSetKey: infoKey,
    children: {
      [ACTIONS.ACCEPT]: buildAfterBuyerAction(state, ACTIONS.ACCEPT),
      [ACTIONS.REJECT]: buildAfterBuyerAction(state, ACTIONS.REJECT),
      [ACTIONS.COUNTER]: buildAfterBuyerAction(state, ACTIONS.COUNTER),
    },
  };
}

/**
 * Handle the result of a buyer action.
 */
function buildAfterBuyerAction(state, buyerAction) {
  const newHistory = state.history
    ? `${state.history}:${buyerAction[0]}`
    : buyerAction[0];

  // Buyer accepts → agreement terminal
  if (buyerAction === ACTIONS.ACCEPT) {
    return {
      type: 'terminal',
      payoffs: computePayoffs('agreement', state),
    };
  }

  // Buyer rejects → if CLOSING round, walk away; otherwise supplier responds
  if (buyerAction === ACTIONS.REJECT) {
    if (state.roundIndex >= ROUND_ORDER.length - 1) {
      return {
        type: 'terminal',
        payoffs: computePayoffs('walkaway_buyer', state),
      };
    }
  }

  // Supplier responds
  return buildSupplierNode({
    ...state,
    history: newHistory,
    buyerConcessions:
      state.buyerConcessions + (buyerAction === ACTIONS.COUNTER ? 1 : 0),
  });
}

/**
 * Build supplier action node.
 */
function buildSupplierNode(state) {
  const infoKey = buildInfoKey(PLAYERS.SUPPLIER, state);

  return {
    type: 'action',
    player: PLAYERS.SUPPLIER,
    actions: [...ACTION_LIST],
    infoSetKey: infoKey,
    children: {
      [ACTIONS.ACCEPT]: buildAfterSupplierAction(state, ACTIONS.ACCEPT),
      [ACTIONS.REJECT]: buildAfterSupplierAction(state, ACTIONS.REJECT),
      [ACTIONS.COUNTER]: buildAfterSupplierAction(state, ACTIONS.COUNTER),
    },
  };
}

/**
 * Handle the result of a supplier action.
 */
function buildAfterSupplierAction(state, supplierAction) {
  const newHistory = `${state.history}:${supplierAction[0]}`;

  // Supplier accepts → agreement terminal
  if (supplierAction === ACTIONS.ACCEPT) {
    return {
      type: 'terminal',
      payoffs: computePayoffs('agreement', {
        ...state,
        supplierConcessions: state.supplierConcessions,
      }),
    };
  }

  // Supplier rejects → if CLOSING round, walk away; otherwise advance round
  if (supplierAction === ACTIONS.REJECT) {
    if (state.roundIndex >= ROUND_ORDER.length - 1) {
      return {
        type: 'terminal',
        payoffs: computePayoffs('walkaway_supplier', state),
      };
    }
  }

  // Advance to next round (both counter or reject in non-final round)
  return buildBuyerNode({
    ...state,
    history: newHistory,
    roundIndex: state.roundIndex + 1,
    supplierConcessions:
      state.supplierConcessions + (supplierAction === ACTIONS.COUNTER ? 1 : 0),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a complete negotiation game tree for a specific buyer bucket.
 *
 * Root is a chance node that samples supplier type.
 *
 * @param {number} buyerBucket - Position strength (0–4)
 * @param {{ AGGRESSIVE: number, COOPERATIVE: number, DESPERATE: number }} supplierPriors
 *   Probability distribution over supplier types.
 * @returns {Object} Root GameNode (chance node)
 */
export function buildNegotiationTree(buyerBucket, supplierPriors) {
  const bucket = Math.max(0, Math.min(NUM_POSITION_BUCKETS - 1, Math.floor(buyerBucket)));

  const outcomes = [];
  for (const sType of SUPPLIER_TYPE_LIST) {
    const prob = supplierPriors[sType];
    if (!prob || prob <= 0) continue;

    outcomes.push({
      prob,
      node: buildBuyerNode({
        supplierType: sType,
        buyerBucket: bucket,
        roundIndex: 0,
        history: '',
        buyerConcessions: 0,
        supplierConcessions: 0,
      }),
    });
  }

  // Normalize probabilities (in case they don't sum to exactly 1)
  const totalProb = outcomes.reduce((s, o) => s + o.prob, 0);
  if (totalProb > 0 && Math.abs(totalProb - 1) > 1e-6) {
    for (const o of outcomes) o.prob /= totalProb;
  }

  return { type: 'chance', outcomes };
}

/**
 * Build trees for all 5 buyer buckets × a given supplier prior.
 *
 * @param {{ AGGRESSIVE: number, COOPERATIVE: number, DESPERATE: number }} supplierPriors
 * @returns {Map<number, Object>} bucket → root GameNode
 */
export function buildAllBucketTrees(supplierPriors) {
  const trees = new Map();
  for (let bucket = 0; bucket < NUM_POSITION_BUCKETS; bucket++) {
    trees.set(bucket, buildNegotiationTree(bucket, supplierPriors));
  }
  return trees;
}

/**
 * Count nodes in a game tree (for diagnostics).
 *
 * @param {Object} node - GameNode
 * @returns {{ total: number, action: number, terminal: number, chance: number }}
 */
export function countNodes(node) {
  const counts = { total: 0, action: 0, terminal: 0, chance: 0 };

  function traverse(n) {
    counts.total++;
    counts[n.type]++;

    if (n.type === 'action') {
      for (const action of n.actions) {
        traverse(n.children[action]);
      }
    } else if (n.type === 'chance') {
      for (const outcome of n.outcomes) {
        traverse(outcome.node);
      }
    }
  }

  traverse(node);
  return counts;
}

/**
 * Collect all unique info set keys in a game tree.
 *
 * @param {Object} node - GameNode
 * @returns {Set<string>}
 */
export function collectInfoSetKeys(node) {
  const keys = new Set();

  function traverse(n) {
    if (n.type === 'action') {
      keys.add(n.infoSetKey);
      for (const action of n.actions) {
        traverse(n.children[action]);
      }
    } else if (n.type === 'chance') {
      for (const outcome of n.outcomes) {
        traverse(outcome.node);
      }
    }
  }

  traverse(node);
  return keys;
}

export default {
  buildNegotiationTree,
  buildAllBucketTrees,
  countNodes,
  collectInfoSetKeys,
};
