/**
 * Negotiation Lookup Service — Query solved CFR strategies at runtime
 *
 * Loads pre-solved strategies from JSONL export and provides a query interface:
 *   given (scenario_id, buyer_bucket, info_key) → action probabilities
 *
 * Features:
 *   - Exact match lookup
 *   - Nearest-scenario fallback using weighted feature distance
 *   - Graceful degradation when no strategies available
 */

import { NegotiationSolverRunner } from './negotiation-solver-runner.js';
import { computeSupplierTypePriors } from './negotiation-types.js';
import { ACTION_LIST, DEFAULT_CFR_INFLUENCE, OPTION_TO_CFR_ACTION } from './negotiation-types.js';

// ---------------------------------------------------------------------------
// Lookup Service
// ---------------------------------------------------------------------------

export class NegotiationLookupService {
  constructor() {
    /** @type {Map<string, Map<string, Object>>} compositeKey → (infoKey → strategy) */
    this._strategies = new Map();
    /** @type {Map<string, Object>} compositeKey → meta */
    this._meta = new Map();
    /** @type {boolean} */
    this._loaded = false;
  }

  get isLoaded() {
    return this._loaded;
  }

  get scenarioCount() {
    return this._meta.size;
  }

  /**
   * Load strategies from JSONL content.
   *
   * @param {string} jsonl - JSONL string from NegotiationSolverRunner.exportAsJsonl
   */
  loadFromJsonl(jsonl) {
    const { strategies, meta } = NegotiationSolverRunner.parseJsonl(jsonl);
    this._strategies = strategies;
    this._meta = meta;
    this._loaded = true;
  }

  /**
   * Load strategies from pre-parsed data (avoids re-parsing).
   *
   * @param {Map<string, Map<string, Object>>} strategies
   * @param {Map<string, Object>} meta
   */
  loadFromMaps(strategies, meta) {
    this._strategies = strategies;
    this._meta = meta;
    this._loaded = true;
  }

  /**
   * Load strategies directly from solver results.
   *
   * @param {Map<string, Object>} solverResults - from NegotiationSolverRunner.solveAllScenarios
   */
  loadFromSolverResults(solverResults) {
    this._strategies = new Map();
    this._meta = new Map();

    for (const [compositeKey, result] of solverResults) {
      const infoMap = new Map();
      for (const entry of result.store.entries()) {
        infoMap.set(entry.key, {
          numActions: entry.numActions,
          averageStrategy: entry.averageStrategy,
        });
      }
      this._strategies.set(compositeKey, infoMap);
      this._meta.set(compositeKey, {
        scenario_id: result.scenarioId,
        buyer_bucket: result.buyerBucket,
        stats: result.stats,
      });
    }

    this._loaded = true;
  }

  /**
   * Query the CFR strategy for a specific game state.
   *
   * @param {string}  scenarioId  - scenario ID
   * @param {number}  buyerBucket - 0–4
   * @param {string}  infoKey     - info set key from the game tree
   * @returns {{ found: boolean, strategy: number[]|null, source: string }}
   */
  lookupStrategy(scenarioId, buyerBucket, infoKey) {
    if (!this._loaded) {
      return { found: false, strategy: null, source: 'not_loaded' };
    }

    // Exact match
    const compositeKey = `${scenarioId}::${buyerBucket}`;
    const infoMap = this._strategies.get(compositeKey);
    if (infoMap) {
      const entry = infoMap.get(infoKey);
      if (entry) {
        return {
          found: true,
          strategy: Array.from(entry.averageStrategy),
          source: 'exact',
        };
      }
    }

    // Try same scenario, nearest bucket
    const nearestBucket = this._findNearestBucket(scenarioId, buyerBucket);
    if (nearestBucket !== null) {
      const nearKey = `${scenarioId}::${nearestBucket}`;
      const nearMap = this._strategies.get(nearKey);
      const nearEntry = nearMap?.get(infoKey);
      if (nearEntry) {
        return {
          found: true,
          strategy: Array.from(nearEntry.averageStrategy),
          source: `nearest_bucket:${nearestBucket}`,
        };
      }
    }

    // Fallback: try any scenario with same bucket
    for (const [key, infoMap2] of this._strategies) {
      if (key.endsWith(`::${buyerBucket}`)) {
        const entry = infoMap2.get(infoKey);
        if (entry) {
          return {
            found: true,
            strategy: Array.from(entry.averageStrategy),
            source: `fallback_scenario:${key}`,
          };
        }
      }
    }

    return { found: false, strategy: null, source: 'not_found' };
  }

  /**
   * Find the nearest available bucket for a given scenario.
   */
  _findNearestBucket(scenarioId, targetBucket) {
    let bestDist = Infinity;
    let bestBucket = null;

    for (const key of this._strategies.keys()) {
      const [sid, bucketStr] = key.split('::');
      if (sid !== scenarioId) continue;
      const bucket = Number(bucketStr);
      const dist = Math.abs(bucket - targetBucket);
      if (dist > 0 && dist < bestDist) {
        bestDist = dist;
        bestBucket = bucket;
      }
    }

    return bestBucket;
  }

  /**
   * Find the best matching scenario ID for given supplier KPIs.
   * Uses weighted feature distance against scenario meta.
   *
   * @param {{ on_time_rate?: number, defect_rate?: number }} kpis
   * @returns {string|null} best matching scenario ID
   */
  findNearestScenario(kpis) {
    if (!this._loaded || this._meta.size === 0) return null;

    const targetPriors = computeSupplierTypePriors(kpis);
    let bestDist = Infinity;
    let bestScenarioId = null;
    const seen = new Set();

    for (const [, meta] of this._meta) {
      const sid = meta.scenario_id;
      if (seen.has(sid)) continue;
      seen.add(sid);

      const priors = meta.stats?.supplierPriors;
      if (!priors) continue;

      // L2 distance on supplier type probability distributions
      const dist = Math.sqrt(
        (targetPriors.AGGRESSIVE - (priors.AGGRESSIVE || 0)) ** 2 +
        (targetPriors.COOPERATIVE - (priors.COOPERATIVE || 0)) ** 2 +
        (targetPriors.DESPERATE - (priors.DESPERATE || 0)) ** 2
      );

      if (dist < bestDist) {
        bestDist = dist;
        bestScenarioId = sid;
      }
    }

    return bestScenarioId;
  }

  /**
   * Compute CFR-weighted recommendation for DI negotiation options.
   *
   * Given the current game state, looks up the CFR strategy and maps it
   * to DI option weights for use in Step 3.5.
   *
   * @param {Object}  params
   * @param {string}  params.scenarioId   - scenario ID (or auto-detect via kpis)
   * @param {number}  params.buyerBucket  - 0–4
   * @param {string}  params.infoKey      - info set key
   * @param {Object[]} params.options     - DI negotiation options
   * @param {Object}  [params.kpis]       - supplier KPIs for scenario auto-detection
   * @param {number}  [params.cfrInfluence] - blend weight (default 0.30)
   * @returns {{ cfr_weights: Object, cfr_action_probs: Object, source: string, available: boolean }}
   */
  computeOptionWeights({
    scenarioId,
    buyerBucket,
    infoKey,
    options,
    kpis,
    cfrInfluence = DEFAULT_CFR_INFLUENCE,
  }) {
    // Auto-detect scenario if not specified
    let sid = scenarioId;
    if (!sid && kpis) {
      sid = this.findNearestScenario(kpis);
    }

    if (!sid) {
      return { cfr_weights: {}, cfr_action_probs: {}, source: 'no_scenario', available: false };
    }

    const lookup = this.lookupStrategy(sid, buyerBucket, infoKey);
    if (!lookup.found || !lookup.strategy) {
      return { cfr_weights: {}, cfr_action_probs: {}, source: lookup.source, available: false };
    }

    // Map CFR strategy (accept/reject/counter probs) to option weights
    const actionProbs = {};
    ACTION_LIST.forEach((action, idx) => {
      actionProbs[action] = lookup.strategy[idx] || 0;
    });

    const cfr_weights = {};
    for (const option of options) {
      const mappedAction = OPTION_TO_CFR_ACTION[option.option_id];
      if (mappedAction) {
        cfr_weights[option.option_id] = actionProbs[mappedAction] || 0;
      }
    }

    return {
      cfr_weights,
      cfr_action_probs: actionProbs,
      source: lookup.source,
      available: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton for app-wide use
// ---------------------------------------------------------------------------

let _instance = null;

/**
 * Get the singleton lookup service instance.
 * @returns {NegotiationLookupService}
 */
export function getLookupService() {
  if (!_instance) {
    _instance = new NegotiationLookupService();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function _resetLookupService() {
  _instance = null;
}

export default {
  NegotiationLookupService,
  getLookupService,
  _resetLookupService,
};
