/**
 * Kuhn Negotiation Game — CFR+ Convergence Test
 *
 * Validates that our generic CFR+ engine converges to Nash equilibrium
 * on a simplified procurement negotiation game.
 *
 * Game Structure (isomorphic to Kuhn Poker, known Nash equilibrium):
 * ─────────────────────────────────────────────────────────────────
 *
 * Players:
 *   P0 = Buyer (procurement agent)
 *   P1 = Supplier
 *
 * Private information ("position cards"):
 *   Weak (1), Medium (2), Strong (3) — dealt one per player
 *   Strong > Medium > Weak
 *   Player with the stronger position wins at "showdown" (final evaluation).
 *
 * Game flow:
 *   - Both players put 1 unit "on the table" (the base deal value)
 *   - P0 (buyer) acts first:
 *       "standard_offer"   → standard terms (check)
 *       "aggressive_offer"  → push for better terms (bet 1 unit)
 *
 *   - If P0 plays standard_offer:
 *       P1 acts: "accept_standard" (check → showdown)
 *              or "counter_aggressive" (bet 1 unit)
 *         - If P1 counters: P0 acts: "walk_away" (fold) or "accept_counter" (call)
 *
 *   - If P0 plays aggressive_offer:
 *       P1 acts: "walk_away" (fold → P0 wins base deal)
 *              or "accept_aggressive" (call → showdown)
 *
 * Terminal payoffs (for P0; P1 gets negative):
 *   Walk-away by loser:    winner gets +1 (the ante)
 *   Showdown (standard):   winner gets +1, loser gets -1
 *   Showdown (aggressive): winner gets +2, loser gets -2
 *
 * Known Nash Equilibrium (family parameterized by α ∈ [0, 1/3]):
 * ────────────────────────────────────────────────────────────────
 *
 * P0 (Buyer):
 *   Strong: aggressive_offer with prob α ∈ [0, 1/3]
 *   Medium: always standard_offer (never aggressive)
 *   Weak:   aggressive_offer with prob α/3 (bluff)
 *
 * P1 (Supplier) when facing aggressive_offer:
 *   Strong: always accept (call)
 *   Medium: accept with prob (1/3 + α)
 *   Weak:   always walk_away (fold)
 *
 * P1 when facing standard_offer (then deciding to counter):
 *   Strong: always counter_aggressive
 *   Medium: never counter (accept_standard)
 *   Weak:   counter_aggressive with prob 1/3
 *
 * P0 when facing counter after standard_offer:
 *   Strong: always accept_counter (call)
 *   Medium: never accept_counter (walk_away)
 *   Weak:   never accept_counter (walk_away)
 *
 * Game value: -1/18 ≈ -0.0556 for P0 (P1 has slight positional advantage)
 *
 * Key invariants to verify (regardless of α):
 *   1. P0 with Medium never plays aggressive_offer  (prob ≈ 0)
 *   2. P1 with Strong always accepts aggressive       (prob ≈ 1)
 *   3. P1 with Weak always walks away from aggressive (prob ≈ 0 for accept)
 *   4. P0 with Strong always accepts counter          (prob ≈ 1)
 *   5. P0 with Medium/Weak never accepts counter      (prob ≈ 0)
 *   6. P1 with Medium never counters after standard   (prob ≈ 0)
 */

import { describe, it, expect } from 'vitest';
import { InfoSetStore, solveGame, computeGameValue, computeExploitability } from './cfr-core.js';

// ---------------------------------------------------------------------------
// Build Kuhn Negotiation Game Tree
// ---------------------------------------------------------------------------

const CARDS = [1, 2, 3]; // Weak, Medium, Strong
const CARD_NAMES = { 1: 'Weak', 2: 'Medium', 3: 'Strong' };

/**
 * Build the full Kuhn Negotiation game tree with chance nodes at the root.
 *
 * The root is a chance node that deals 2 cards (one per player)
 * from the 3-card deck. There are 6 possible deals, each with prob 1/6.
 */
function buildKuhnNegotiationTree() {
  const outcomes = [];

  for (const c0 of CARDS) {
    for (const c1 of CARDS) {
      if (c0 === c1) continue; // each card dealt once
      outcomes.push({
        prob: 1 / 6,
        node: buildP0Node(c0, c1),
      });
    }
  }

  return { type: 'chance', outcomes };
}

/**
 * P0's first decision: standard_offer or aggressive_offer.
 * Info set key: P0 sees only their own card.
 */
function buildP0Node(c0, c1) {
  return {
    type: 'action',
    player: 0,
    actions: ['standard_offer', 'aggressive_offer'],
    infoSetKey: `0:${c0}`,
    children: {
      standard_offer: buildP1AfterStandard(c0, c1),
      aggressive_offer: buildP1AfterAggressive(c0, c1),
    },
  };
}

/**
 * P1's decision after P0 standard_offer: accept_standard or counter_aggressive.
 * Info set key: P1 sees own card + P0 played standard.
 */
function buildP1AfterStandard(c0, c1) {
  return {
    type: 'action',
    player: 1,
    actions: ['accept_standard', 'counter_aggressive'],
    infoSetKey: `1:${c1}:s`,
    children: {
      accept_standard: terminalShowdown(c0, c1, 1), // pot = 2 (1+1), each wagered 1
      counter_aggressive: buildP0AfterCounter(c0, c1),
    },
  };
}

/**
 * P0's decision after P1 counters: walk_away or accept_counter.
 * Info set key: P0 sees own card + action history (standard, then counter).
 */
function buildP0AfterCounter(c0, c1) {
  return {
    type: 'action',
    player: 0,
    actions: ['walk_away', 'accept_counter'],
    infoSetKey: `0:${c0}:sc`,
    children: {
      walk_away: terminalFold(1, 1), // P1 wins — P0 loses ante of 1
      accept_counter: terminalShowdown(c0, c1, 2), // pot = 4 (2+2), each wagered 2
    },
  };
}

/**
 * P1's decision after P0 aggressive_offer: walk_away or accept_aggressive.
 * Info set key: P1 sees own card + P0 played aggressive.
 */
function buildP1AfterAggressive(c0, c1) {
  return {
    type: 'action',
    player: 1,
    actions: ['walk_away', 'accept_aggressive'],
    infoSetKey: `1:${c1}:a`,
    children: {
      walk_away: terminalFold(0, 1), // P0 wins — P1 folds, P0 wins ante of 1
      accept_aggressive: terminalShowdown(c0, c1, 2), // pot = 4 (2+2)
    },
  };
}

/**
 * Terminal node: fold. Winner takes the pot.
 * @param {number} winner - 0 or 1
 * @param {number} winAmount - amount won by winner
 */
function terminalFold(winner, winAmount) {
  return {
    type: 'terminal',
    payoffs: winner === 0 ? [winAmount, -winAmount] : [-winAmount, winAmount],
  };
}

/**
 * Terminal node: showdown. Higher position card wins.
 * @param {number} c0 - P0's card
 * @param {number} c1 - P1's card
 * @param {number} stake - amount at stake per player
 */
function terminalShowdown(c0, c1, stake) {
  if (c0 > c1) return { type: 'terminal', payoffs: [stake, -stake] };
  return { type: 'terminal', payoffs: [-stake, stake] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Kuhn Negotiation CFR+ Convergence', () => {
  const ITERATIONS = 100_000;
  let store;
  let root;

  // Solve once, verify multiple properties
  beforeAll(() => {
    root = buildKuhnNegotiationTree();
    store = new InfoSetStore();
    solveGame(root, store, ITERATIONS);
  });

  // Helper: get average strategy for an info set
  const avgStrat = (key, numActions = 2) =>
    Array.from(store.getAverageStrategy(key, numActions));

  // -------------------------------------------------------------------------
  // P0 (Buyer) strategy checks
  // -------------------------------------------------------------------------

  it('P0 with Medium never plays aggressive_offer (prob ≈ 0)', () => {
    // Info set "0:2" → actions: [standard_offer, aggressive_offer]
    const strat = avgStrat('0:2');
    // aggressive_offer prob should be near 0
    expect(strat[1]).toBeLessThan(0.02);
  });

  it('P0 with Strong: aggressive_offer prob ∈ [0, 1] (free parameter α_K)', () => {
    const strat = avgStrat('0:3');
    // α_K is the free parameter of the Nash equilibrium family.
    // CFR may converge to any α_K ∈ [0, 1]. The entire equilibrium is
    // determined once α_K is fixed: α_J = α_K/3, β_Q = 1/3, δ_Q = (α_K+1)/3.
    expect(strat[1]).toBeGreaterThanOrEqual(-0.02);
    expect(strat[1]).toBeLessThanOrEqual(1.02);
  });

  it('P0 with Weak: aggressive_offer ≤ Strong aggressive_offer / 3', () => {
    const stratWeak = avgStrat('0:1');
    const stratStrong = avgStrat('0:3');
    // Bluff frequency = α/3 where α = Strong's aggressive frequency
    // Allow tolerance for convergence noise
    const expectedBluff = stratStrong[1] / 3;
    expect(stratWeak[1]).toBeLessThan(expectedBluff + 0.05);
  });

  // -------------------------------------------------------------------------
  // P1 (Supplier) strategy checks — facing aggressive offer
  // -------------------------------------------------------------------------

  it('P1 with Strong always accepts aggressive (prob ≈ 1)', () => {
    // Info set "1:3:a" → actions: [walk_away, accept_aggressive]
    const strat = avgStrat('1:3:a');
    expect(strat[1]).toBeGreaterThan(0.95);
  });

  it('P1 with Weak always walks away from aggressive (prob ≈ 0 for accept)', () => {
    const strat = avgStrat('1:1:a');
    expect(strat[1]).toBeLessThan(0.05);
  });

  it('P1 with Medium: accept_aggressive prob ≈ 1/3', () => {
    // β_Q = 1/3 in all Nash equilibria of Kuhn Poker.
    // This is set by P0-J's indifference condition: P0's bluff with Weak
    // must make P1's Medium exactly indifferent about calling.
    const stratP1Med = avgStrat('1:2:a');
    expect(Math.abs(stratP1Med[1] - 1 / 3)).toBeLessThan(0.05);
  });

  // -------------------------------------------------------------------------
  // P1 (Supplier) strategy checks — facing standard offer
  // -------------------------------------------------------------------------

  it('P1 with Strong always counters after standard (prob ≈ 1)', () => {
    // Info set "1:3:s" → actions: [accept_standard, counter_aggressive]
    const strat = avgStrat('1:3:s');
    expect(strat[1]).toBeGreaterThan(0.95);
  });

  it('P1 with Medium never counters after standard (prob ≈ 0)', () => {
    const strat = avgStrat('1:2:s');
    expect(strat[1]).toBeLessThan(0.05);
  });

  it('P1 with Weak: counter_aggressive after standard prob ≈ 1/3', () => {
    const strat = avgStrat('1:1:s');
    expect(Math.abs(strat[1] - 1 / 3)).toBeLessThan(0.05);
  });

  // -------------------------------------------------------------------------
  // P0 (Buyer) response to counter
  // -------------------------------------------------------------------------

  it('P0 with Strong always accepts counter (prob ≈ 1)', () => {
    // Info set "0:3:sc" → actions: [walk_away, accept_counter]
    const strat = avgStrat('0:3:sc');
    expect(strat[1]).toBeGreaterThan(0.95);
  });

  it('P0 with Medium accepts counter with prob ≈ (α_K + 1)/3', () => {
    // δ_Q = (α_K + 1) / 3 — determined by P1-J's indifference about bluffing
    // after P0's check. At the converged α_K, this is a specific value.
    const strat = avgStrat('0:2:sc');
    const alphaK = avgStrat('0:3')[1]; // P0 Strong aggressive rate
    const expectedDeltaQ = (alphaK + 1) / 3;
    expect(Math.abs(strat[1] - expectedDeltaQ)).toBeLessThan(0.05);
  });

  it('P0 with Weak never accepts counter (prob ≈ 0)', () => {
    const strat = avgStrat('0:1:sc');
    expect(strat[1]).toBeLessThan(0.05);
  });

  // -------------------------------------------------------------------------
  // Game-level properties
  // -------------------------------------------------------------------------

  it('game value ≈ -1/18 for P0 (Buyer has slight disadvantage)', () => {
    // The known game value of Kuhn Poker is -1/18 ≈ -0.0556 for the first player.
    // P1 (supplier, acting second) has a slight positional advantage.
    const gameValue = computeGameValue(root, store, 0);
    expect(Math.abs(gameValue - (-1 / 18))).toBeLessThan(0.01);
  });

  it('exploitability converges to near 0', () => {
    const exploit = computeExploitability(root, store);
    // After 100K iterations, exploitability should be very small.
    // In a perfect Nash equilibrium, exploitability = 0.
    expect(exploit).toBeLessThan(0.02);
  });

  it('store contains exactly 12 info sets (6 per player)', () => {
    // P0: 0:1, 0:2, 0:3 (first decision) + 0:1:sc, 0:2:sc, 0:3:sc (after counter)
    // P1: 1:1:s, 1:2:s, 1:3:s (after standard) + 1:1:a, 1:2:a, 1:3:a (after aggressive)
    expect(store.size).toBe(12);
  });

  it('logs converged strategy table for inspection', () => {
    const table = {};
    for (const { key, averageStrategy } of store.entries()) {
      table[key] = Array.from(averageStrategy).map((p) => p.toFixed(4));
    }
    console.log('\n=== Kuhn Negotiation — Converged Nash Equilibrium ===');
    console.log(JSON.stringify(table, null, 2));

    // Log the specific procurement interpretation
    console.log('\n--- Procurement Interpretation ---');
    for (const [key, probs] of Object.entries(table)) {
      const [playerStr, cardStr, ...histParts] = key.split(':');
      const player = playerStr === '0' ? 'Buyer' : 'Supplier';
      const position = CARD_NAMES[Number(cardStr)];
      const history = histParts.join(':');

      let actions;
      if (playerStr === '0' && !history) {
        actions = ['standard_offer', 'aggressive_offer'];
      } else if (playerStr === '1' && history === 's') {
        actions = ['accept_standard', 'counter_aggressive'];
      } else if (playerStr === '0' && history === 'sc') {
        actions = ['walk_away', 'accept_counter'];
      } else if (playerStr === '1' && history === 'a') {
        actions = ['walk_away', 'accept_aggressive'];
      }

      const desc = actions
        .map((a, i) => `${a}=${probs[i]}`)
        .join(', ');
      console.log(`  ${player} [${position}] after "${history || 'root'}": ${desc}`);
    }
  });
});
