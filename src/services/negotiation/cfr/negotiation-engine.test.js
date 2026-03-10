/**
 * Negotiation CFR Engine — Phase 1 Integration Tests
 *
 * Tests:
 *   1. Type definitions & supplier type priors
 *   2. Position bucketing from risk_score
 *   3. Game tree structure (node counts, info sets)
 *   4. CFR convergence on negotiation game tree
 *   5. Solver runner & JSONL export/import
 *   6. Lookup service queries & fallbacks
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Module under test
import {
  ROUNDS,
  ROUND_ORDER,
  PLAYERS,
  ACTIONS,
  ACTION_LIST,
  SUPPLIER_TYPES,
  SUPPLIER_TYPE_LIST,
  computeSupplierTypePriors,
  POSITION_BUCKETS,
  NUM_POSITION_BUCKETS,
  PAYOFF_CONFIG,
  OPTION_TO_CFR_ACTION,
} from './negotiation-types.js';

import {
  riskScoreToBucket,
  bucketName,
  computePositionBucket,
} from './negotiation-position-buckets.js';

import {
  buildNegotiationTree,
  buildAllBucketTrees,
  countNodes,
  collectInfoSetKeys,
} from './negotiation-tree-builder.js';

import { InfoSetStore, solveGame, computeExploitability } from './cfr-core.js';
import { NegotiationSolverRunner } from './negotiation-solver-runner.js';
import { NegotiationLookupService } from './negotiation-lookup-service.js';

// ---------------------------------------------------------------------------
// 1. Type Definitions
// ---------------------------------------------------------------------------

describe('Negotiation Types', () => {
  it('defines 3 rounds in correct order', () => {
    expect(ROUND_ORDER).toEqual(['OPENING', 'CONCESSION', 'CLOSING']);
  });

  it('defines 3 actions', () => {
    expect(ACTION_LIST).toEqual(['accept', 'reject', 'counter']);
  });

  it('defines 3 supplier types', () => {
    expect(SUPPLIER_TYPE_LIST).toHaveLength(3);
    expect(SUPPLIER_TYPE_LIST).toContain('AGGRESSIVE');
    expect(SUPPLIER_TYPE_LIST).toContain('COOPERATIVE');
    expect(SUPPLIER_TYPE_LIST).toContain('DESPERATE');
  });

  it('maps all 6 DI options to CFR actions', () => {
    expect(Object.keys(OPTION_TO_CFR_ACTION)).toHaveLength(6);
    // First 4 are counter, last 2 are accept
    expect(OPTION_TO_CFR_ACTION.opt_001).toBe('counter');
    expect(OPTION_TO_CFR_ACTION.opt_005).toBe('accept');
    expect(OPTION_TO_CFR_ACTION.opt_006).toBe('accept');
  });
});

// ---------------------------------------------------------------------------
// 2. Supplier Type Priors
// ---------------------------------------------------------------------------

describe('Supplier Type Priors', () => {
  it('returns uniform distribution when no KPIs', () => {
    const priors = computeSupplierTypePriors({});
    expect(Math.abs(priors.AGGRESSIVE - 1 / 3)).toBeLessThan(0.01);
    expect(Math.abs(priors.COOPERATIVE - 1 / 3)).toBeLessThan(0.01);
    expect(Math.abs(priors.DESPERATE - 1 / 3)).toBeLessThan(0.01);
  });

  it('leans aggressive for low on_time_rate', () => {
    const priors = computeSupplierTypePriors({ on_time_rate: 0.65 });
    expect(priors.AGGRESSIVE).toBeGreaterThan(priors.COOPERATIVE);
    expect(priors.AGGRESSIVE).toBeGreaterThan(priors.DESPERATE);
  });

  it('leans cooperative for mid on_time_rate', () => {
    const priors = computeSupplierTypePriors({ on_time_rate: 0.88 });
    expect(priors.COOPERATIVE).toBeGreaterThan(priors.AGGRESSIVE);
    expect(priors.COOPERATIVE).toBeGreaterThan(priors.DESPERATE);
  });

  it('leans desperate for high on_time_rate + high defect', () => {
    const priors = computeSupplierTypePriors({ on_time_rate: 0.97, defect_rate: 0.08 });
    expect(priors.DESPERATE).toBeGreaterThan(priors.COOPERATIVE);
    expect(priors.DESPERATE).toBeGreaterThan(priors.AGGRESSIVE);
  });

  it('probabilities sum to 1', () => {
    const testCases = [
      {},
      { on_time_rate: 0.5 },
      { on_time_rate: 0.85, defect_rate: 0.1 },
      { on_time_rate: 0.99, defect_rate: 0.15 },
    ];
    for (const kpis of testCases) {
      const priors = computeSupplierTypePriors(kpis);
      const sum = priors.AGGRESSIVE + priors.COOPERATIVE + priors.DESPERATE;
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Position Bucketing
// ---------------------------------------------------------------------------

describe('Position Bucketing', () => {
  it('maps risk_score 0-39 to VERY_STRONG (4)', () => {
    expect(riskScoreToBucket(0)).toBe(4);
    expect(riskScoreToBucket(20)).toBe(4);
    expect(riskScoreToBucket(39)).toBe(4);
  });

  it('maps risk_score 40-79 to STRONG (3)', () => {
    expect(riskScoreToBucket(40)).toBe(3);
    expect(riskScoreToBucket(60)).toBe(3);
    expect(riskScoreToBucket(79)).toBe(3);
  });

  it('maps risk_score 80-119 to NEUTRAL (2)', () => {
    expect(riskScoreToBucket(80)).toBe(2);
    expect(riskScoreToBucket(100)).toBe(2);
    expect(riskScoreToBucket(119)).toBe(2);
  });

  it('maps risk_score 120-159 to WEAK (1)', () => {
    expect(riskScoreToBucket(120)).toBe(1);
    expect(riskScoreToBucket(140)).toBe(1);
    expect(riskScoreToBucket(159)).toBe(1);
  });

  it('maps risk_score 160+ to VERY_WEAK (0)', () => {
    expect(riskScoreToBucket(160)).toBe(0);
    expect(riskScoreToBucket(200)).toBe(0);
  });

  it('clamps out-of-range values', () => {
    expect(riskScoreToBucket(-10)).toBe(4); // clamped to 0
    expect(riskScoreToBucket(300)).toBe(0); // clamped to 200
  });

  it('defaults to NEUTRAL for non-finite input', () => {
    expect(riskScoreToBucket(NaN)).toBe(2);
    expect(riskScoreToBucket(undefined)).toBe(2);
    expect(riskScoreToBucket(null)).toBe(2);
  });

  it('bucketName returns correct labels', () => {
    expect(bucketName(0)).toBe('VERY_WEAK');
    expect(bucketName(2)).toBe('NEUTRAL');
    expect(bucketName(4)).toBe('VERY_STRONG');
  });

  it('computePositionBucket returns structured result', () => {
    const result = computePositionBucket({ risk_score: 50 });
    expect(result.bucket).toBe(3);
    expect(result.name).toBe('STRONG');
    expect(result.signals_used).toContain('risk_score');
  });
});

// ---------------------------------------------------------------------------
// 4. Game Tree Structure
// ---------------------------------------------------------------------------

describe('Negotiation Game Tree', () => {
  const uniformPriors = { AGGRESSIVE: 1 / 3, COOPERATIVE: 1 / 3, DESPERATE: 1 / 3 };
  let tree;

  beforeAll(() => {
    tree = buildNegotiationTree(2, uniformPriors); // NEUTRAL bucket
  });

  it('root is a chance node with 3 outcomes (supplier types)', () => {
    expect(tree.type).toBe('chance');
    expect(tree.outcomes).toHaveLength(3);
    // Probabilities sum to 1
    const probSum = tree.outcomes.reduce((s, o) => s + o.prob, 0);
    expect(Math.abs(probSum - 1)).toBeLessThan(1e-6);
  });

  it('first child of chance node is a buyer action node', () => {
    const firstChild = tree.outcomes[0].node;
    expect(firstChild.type).toBe('action');
    expect(firstChild.player).toBe(PLAYERS.BUYER);
    expect(firstChild.actions).toEqual(ACTION_LIST);
    expect(firstChild.infoSetKey).toContain('B|');
  });

  it('tree has reasonable node counts', () => {
    const counts = countNodes(tree);
    expect(counts.total).toBeGreaterThan(50);
    expect(counts.terminal).toBeGreaterThan(20);
    expect(counts.action).toBeGreaterThan(20);
    expect(counts.chance).toBe(1); // only root
  });

  it('info set keys separate buyer and supplier information', () => {
    const keys = collectInfoSetKeys(tree);
    const buyerKeys = [...keys].filter((k) => k.startsWith('B|'));
    const supplierKeys = [...keys].filter((k) => k.startsWith('S|'));

    expect(buyerKeys.length).toBeGreaterThan(0);
    expect(supplierKeys.length).toBeGreaterThan(0);

    // Buyer keys should NOT contain supplier type
    for (const k of buyerKeys) {
      expect(k).not.toContain('AGGRESSIVE');
      expect(k).not.toContain('COOPERATIVE');
      expect(k).not.toContain('DESPERATE');
    }

    // Supplier keys should contain supplier type
    for (const k of supplierKeys) {
      const hasType = k.includes('AGGRESSIVE') || k.includes('COOPERATIVE') || k.includes('DESPERATE');
      expect(hasType).toBe(true);
    }
  });

  it('buildAllBucketTrees produces 5 trees', () => {
    const trees = buildAllBucketTrees(uniformPriors);
    expect(trees.size).toBe(5);
    for (let b = 0; b < 5; b++) {
      expect(trees.has(b)).toBe(true);
      expect(trees.get(b).type).toBe('chance');
    }
  });

  it('accept at any point leads to terminal', () => {
    // Buyer accepts immediately
    const buyerNode = tree.outcomes[0].node;
    const acceptChild = buyerNode.children[ACTIONS.ACCEPT];
    expect(acceptChild.type).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------
// 5. CFR Convergence on Negotiation Tree
// ---------------------------------------------------------------------------

describe('Negotiation CFR Convergence', () => {
  const ITERATIONS = 10_000; // Enough for basic convergence check
  let store;
  let tree;

  beforeAll(() => {
    const priors = { AGGRESSIVE: 1 / 3, COOPERATIVE: 1 / 3, DESPERATE: 1 / 3 };
    tree = buildNegotiationTree(2, priors); // NEUTRAL bucket
    store = new InfoSetStore();
    solveGame(tree, store, ITERATIONS);
  });

  it('solver populates info sets', () => {
    expect(store.size).toBeGreaterThan(0);
  });

  it('all average strategies sum to approximately 1', () => {
    for (const { averageStrategy } of store.entries()) {
      const sum = averageStrategy.reduce((s, v) => s + v, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.01);
    }
  });

  it('exploitability decreases with more iterations', () => {
    // Solve with fewer iterations for comparison
    const storeFew = new InfoSetStore();
    solveGame(tree, storeFew, 1_000);
    const exploitFew = computeExploitability(tree, storeFew);

    const exploitMany = computeExploitability(tree, store);

    // More iterations should yield lower or equal exploitability
    expect(exploitMany).toBeLessThanOrEqual(exploitFew + 0.05);
  });

  it('buyer OPENING strategies are valid probabilities', () => {
    for (const { key, averageStrategy } of store.entries()) {
      if (key.startsWith('B|') && key.includes('OPENING') && !key.includes(':')) {
        for (const p of averageStrategy) {
          expect(p).toBeGreaterThanOrEqual(-0.01);
          expect(p).toBeLessThanOrEqual(1.01);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Solver Runner & JSONL Export/Import
// ---------------------------------------------------------------------------

describe('Negotiation Solver Runner', () => {
  it('solves a single scenario+bucket', () => {
    const runner = new NegotiationSolverRunner({ iterations: 1_000 });
    const scenario = {
      id: 'test_scenario',
      kpis: { on_time_rate: 0.85, defect_rate: 0.02 },
    };

    const result = runner.solveSingle(scenario, 2);

    expect(result.scenarioId).toBe('test_scenario');
    expect(result.buyerBucket).toBe(2);
    expect(result.store.size).toBeGreaterThan(0);
    expect(result.stats.iterations).toBe(1_000);
    expect(result.stats.infoSets).toBeGreaterThan(0);
    expect(result.stats.exploitability).toBeDefined();
  });

  it('exports and re-imports JSONL roundtrip', () => {
    const runner = new NegotiationSolverRunner({ iterations: 500 });
    const scenario = {
      id: 'roundtrip_test',
      kpis: { on_time_rate: 0.90 },
    };

    const result = runner.solveSingle(scenario, 3);
    const results = new Map();
    results.set('roundtrip_test::3', result);

    const jsonl = runner.exportAsJsonl(results);
    expect(typeof jsonl).toBe('string');
    expect(jsonl.length).toBeGreaterThan(0);

    // Parse back
    const { strategies, meta } = NegotiationSolverRunner.parseJsonl(jsonl);
    expect(meta.has('roundtrip_test::3')).toBe(true);
    expect(strategies.has('roundtrip_test::3')).toBe(true);

    // Strategy count should match
    const original = result.store.size;
    const parsed = strategies.get('roundtrip_test::3').size;
    expect(parsed).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 7. Lookup Service
// ---------------------------------------------------------------------------

describe('Negotiation Lookup Service', () => {
  let service;
  let solverResults;

  beforeAll(() => {
    const runner = new NegotiationSolverRunner({ iterations: 1_000 });
    const scenario = {
      id: 'lookup_test',
      kpis: { on_time_rate: 0.85, defect_rate: 0.02 },
    };

    // Solve just one scenario + one bucket for speed
    const result = runner.solveSingle(scenario, 2);
    solverResults = new Map();
    solverResults.set('lookup_test::2', result);

    service = new NegotiationLookupService();
    service.loadFromSolverResults(solverResults);
  });

  it('reports loaded state', () => {
    expect(service.isLoaded).toBe(true);
    expect(service.scenarioCount).toBe(1);
  });

  it('finds exact match for known info key', () => {
    // Get a real info key from the solver
    const firstEntry = solverResults.get('lookup_test::2').store.entries().next().value;
    const infoKey = firstEntry.key;

    const result = service.lookupStrategy('lookup_test', 2, infoKey);
    expect(result.found).toBe(true);
    expect(result.source).toBe('exact');
    expect(result.strategy).toHaveLength(firstEntry.numActions);

    // Strategy should sum to ~1
    const sum = result.strategy.reduce((s, v) => s + v, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
  });

  it('returns not_found for unknown info key', () => {
    const result = service.lookupStrategy('lookup_test', 2, 'NONEXISTENT_KEY');
    expect(result.found).toBe(false);
  });

  it('returns not_loaded when service is fresh', () => {
    const fresh = new NegotiationLookupService();
    const result = fresh.lookupStrategy('any', 0, 'any');
    expect(result.found).toBe(false);
    expect(result.source).toBe('not_loaded');
  });

  it('findNearestScenario matches by supplier priors', () => {
    const nearest = service.findNearestScenario({ on_time_rate: 0.85 });
    expect(nearest).toBe('lookup_test');
  });

  it('computeOptionWeights returns CFR weights for DI options', () => {
    const firstEntry = solverResults.get('lookup_test::2').store.entries().next().value;
    const infoKey = firstEntry.key;

    const options = [
      { option_id: 'opt_001' },
      { option_id: 'opt_005' },
    ];

    const result = service.computeOptionWeights({
      scenarioId: 'lookup_test',
      buyerBucket: 2,
      infoKey,
      options,
    });

    expect(result.available).toBe(true);
    expect(result.cfr_action_probs).toHaveProperty('accept');
    expect(result.cfr_action_probs).toHaveProperty('reject');
    expect(result.cfr_action_probs).toHaveProperty('counter');
    expect(result.cfr_weights).toHaveProperty('opt_001');
    expect(result.cfr_weights).toHaveProperty('opt_005');
  });

  it('JSONL roundtrip preserves lookup behavior', () => {
    const runner = new NegotiationSolverRunner({ iterations: 500 });
    const jsonl = runner.exportAsJsonl(solverResults);

    const service2 = new NegotiationLookupService();
    service2.loadFromJsonl(jsonl);

    expect(service2.isLoaded).toBe(true);

    const firstEntry = solverResults.get('lookup_test::2').store.entries().next().value;
    const result = service2.lookupStrategy('lookup_test', 2, firstEntry.key);
    expect(result.found).toBe(true);
  });
});
