/**
 * Negotiation Solver Runner — Offline CFR+ solve + strategy export
 *
 * Solves representative negotiation scenarios and exports converged
 * strategies as JSONL for runtime lookup.
 *
 * Usage:
 *   const runner = new NegotiationSolverRunner();
 *   const results = runner.solveAllScenarios({ iterations: 50000 });
 *   const jsonl = runner.exportAsJsonl(results);
 */

import { InfoSetStore, solveGame, computeExploitability } from './cfr-core.js';
import { buildNegotiationTree, countNodes, collectInfoSetKeys } from './negotiation-tree-builder.js';
import {
  SUPPLIER_TYPE_LIST,
  NUM_POSITION_BUCKETS,
  computeSupplierTypePriors,
} from './negotiation-types.js';

// ---------------------------------------------------------------------------
// Default Scenarios
// ---------------------------------------------------------------------------

/**
 * Representative scenarios to solve offline.
 * Each scenario = (supplier KPI profile, urgency level).
 *
 * We solve for all 5 buyer buckets per scenario, so total = 5 scenarios × 5 buckets = 25 trees.
 */
export const DEFAULT_SCENARIOS = [
  {
    id: 'aggressive_high_urgency',
    label: 'Aggressive supplier, high urgency',
    kpis: { on_time_rate: 0.65, defect_rate: 0.02 },
    urgency: 'high',
  },
  {
    id: 'aggressive_normal',
    label: 'Aggressive supplier, normal urgency',
    kpis: { on_time_rate: 0.72, defect_rate: 0.01 },
    urgency: 'normal',
  },
  {
    id: 'cooperative_normal',
    label: 'Cooperative supplier, normal urgency',
    kpis: { on_time_rate: 0.88, defect_rate: 0.02 },
    urgency: 'normal',
  },
  {
    id: 'cooperative_low_urgency',
    label: 'Cooperative supplier, low urgency',
    kpis: { on_time_rate: 0.92, defect_rate: 0.01 },
    urgency: 'low',
  },
  {
    id: 'desperate_quality_issues',
    label: 'Desperate supplier with quality issues',
    kpis: { on_time_rate: 0.97, defect_rate: 0.08 },
    urgency: 'normal',
  },
];

// ---------------------------------------------------------------------------
// Solver Runner
// ---------------------------------------------------------------------------

export class NegotiationSolverRunner {
  /**
   * @param {Object} [options]
   * @param {number} [options.iterations=50000] - CFR iterations per tree
   * @param {number} [options.progressInterval=10000] - iterations between progress callbacks
   */
  constructor(options = {}) {
    this.iterations = options.iterations || 50_000;
    this.progressInterval = options.progressInterval || 10_000;
  }

  /**
   * Solve a single scenario for a specific buyer bucket.
   *
   * @param {Object}  scenario - scenario definition
   * @param {number}  buyerBucket - 0–4
   * @param {Object}  [options]
   * @param {function} [options.onProgress] - callback(iter, elapsedMs)
   * @returns {{ scenarioId, buyerBucket, store, tree, stats }}
   */
  solveSingle(scenario, buyerBucket, options = {}) {
    const priors = computeSupplierTypePriors(scenario.kpis);
    const tree = buildNegotiationTree(buyerBucket, priors);
    const store = new InfoSetStore();

    const { elapsedMs } = solveGame(tree, store, this.iterations, {
      onProgress: options.onProgress,
      progressInterval: this.progressInterval,
    });

    const nodeCounts = countNodes(tree);
    const infoSetKeys = collectInfoSetKeys(tree);
    const exploitability = computeExploitability(tree, store);

    return {
      scenarioId: scenario.id,
      buyerBucket,
      store,
      tree,
      stats: {
        iterations: this.iterations,
        elapsedMs,
        nodeCount: nodeCounts.total,
        actionNodes: nodeCounts.action,
        terminalNodes: nodeCounts.terminal,
        infoSets: infoSetKeys.size,
        exploitability,
        supplierPriors: priors,
      },
    };
  }

  /**
   * Solve all scenarios across all buyer buckets.
   *
   * @param {Object}   [options]
   * @param {Object[]} [options.scenarios] - override default scenarios
   * @param {function} [options.onScenarioComplete] - callback(scenarioId, buyerBucket, stats)
   * @returns {Map<string, Object>} key = `${scenarioId}::${buyerBucket}` → result
   */
  solveAllScenarios(options = {}) {
    const scenarios = options.scenarios || DEFAULT_SCENARIOS;
    const results = new Map();

    for (const scenario of scenarios) {
      for (let bucket = 0; bucket < NUM_POSITION_BUCKETS; bucket++) {
        const result = this.solveSingle(scenario, bucket);
        const key = `${scenario.id}::${bucket}`;
        results.set(key, result);

        if (options.onScenarioComplete) {
          options.onScenarioComplete(scenario.id, bucket, result.stats);
        }
      }
    }

    return results;
  }

  /**
   * Export solved strategies as JSONL string.
   * Each line is a JSON object with:
   *   { scenario_id, buyer_bucket, info_key, num_actions, average_strategy }
   *
   * @param {Map<string, Object>} results - from solveAllScenarios
   * @returns {string} JSONL content
   */
  exportAsJsonl(results) {
    const lines = [];

    for (const [compositeKey, result] of results) {
      const { scenarioId, buyerBucket, store, stats } = result;

      // Metadata line for this scenario+bucket
      lines.push(JSON.stringify({
        _type: 'scenario_meta',
        scenario_id: scenarioId,
        buyer_bucket: buyerBucket,
        stats,
      }));

      // Strategy lines
      for (const entry of store.entries()) {
        lines.push(JSON.stringify({
          _type: 'strategy',
          scenario_id: scenarioId,
          buyer_bucket: buyerBucket,
          info_key: entry.key,
          num_actions: entry.numActions,
          average_strategy: Array.from(entry.averageStrategy),
        }));
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Parse JSONL back into a strategy map.
   *
   * @param {string} jsonl - JSONL content
   * @returns {{ strategies: Map<string, Object>, meta: Map<string, Object> }}
   */
  static parseJsonl(jsonl) {
    const strategies = new Map(); // compositeKey → Map<infoKey, strategy>
    const meta = new Map();

    const lines = jsonl.trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      const compositeKey = `${obj.scenario_id}::${obj.buyer_bucket}`;

      if (obj._type === 'scenario_meta') {
        meta.set(compositeKey, obj);
      } else if (obj._type === 'strategy') {
        if (!strategies.has(compositeKey)) {
          strategies.set(compositeKey, new Map());
        }
        strategies.get(compositeKey).set(obj.info_key, {
          numActions: obj.num_actions,
          averageStrategy: new Float32Array(obj.average_strategy),
        });
      }
    }

    return { strategies, meta };
  }
}

// ---------------------------------------------------------------------------
// Batch Solver (parallel + auto-register in policy registry)
// ---------------------------------------------------------------------------

/**
 * Solve multiple scenarios in parallel and optionally register results
 * as CANDIDATE artifacts in the negotiation policy registry.
 *
 * @param {Object} config
 * @param {Object[]}  [config.scenarios]   - scenario definitions (default DEFAULT_SCENARIOS)
 * @param {number}    [config.iterations]  - CFR iterations per tree (default 50000)
 * @param {string}    [config.outputDir]   - directory for strategy exports
 * @param {boolean}   [config.resume]      - resume from checkpoint
 * @param {boolean}   [config.register]    - auto-register in policy registry (default false)
 * @param {number}    [config.concurrency] - max parallel solves
 * @param {Function}  [config.onProgress]  - callback(completed, total)
 * @returns {Promise<{
 *   results: Map,
 *   totalElapsedMs: number,
 *   skipped: number,
 *   solved: number,
 *   registeredArtifacts: string[]
 * }>}
 */
export async function batchSolve(config = {}) {
  const {
    scenarios = DEFAULT_SCENARIOS,
    iterations = 50_000,
    outputDir = null,
    resume = false,
    register = false,
    concurrency,
    onProgress = null,
  } = config;

  // Use parallel solver
  const { solveParallel } = await import('./parallel-solver.js');

  const parallelResult = await solveParallel({
    scenarios,
    iterations,
    outputDir,
    resume,
    concurrency,
    onProgress,
  });

  // Auto-register results as CANDIDATE in policy registry
  const registeredArtifacts = [];
  if (register && outputDir) {
    try {
      // Write a registration manifest for consumption by the Python registry API
      const manifest = [];
      for (const [key, result] of parallelResult.results) {
        manifest.push({
          key,
          scenario_id: result.scenarioId,
          buyer_bucket: result.buyerBucket,
          output_path: result.outputPath,
          stats: result.stats,
          status: 'pending_registration',
        });
      }

      if (manifest.length > 0) {
        const { writeFileSync: wfs } = await import('node:fs');
        const { join: pjoin } = await import('node:path');
        const manifestPath = pjoin(outputDir, '_registration_manifest.json');
        wfs(manifestPath, JSON.stringify(manifest, null, 2));
      }
    } catch (err) {
      console.warn('[batchSolve] Registration manifest write failed:', err?.message);
    }
  }

  return {
    ...parallelResult,
    registeredArtifacts,
  };
}

export default NegotiationSolverRunner;
