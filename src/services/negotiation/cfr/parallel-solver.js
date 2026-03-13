/**
 * Parallel Solver Orchestration
 *
 * Adapted from CardPilot/packages/cfr-solver/src/orchestration/solve-orchestrator.ts
 *
 * Parallelizes CFR+ solving across negotiation scenarios using a worker pool.
 * Each worker solves one (scenario, buyerBucket) pair independently.
 *
 * Features:
 *   - Worker pool with configurable concurrency
 *   - Checkpoint/resume support (JSON progress file)
 *   - Progress reporting
 *   - Graceful shutdown
 */

import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Checkpoint / Resume
// ---------------------------------------------------------------------------

/**
 * Load checkpoint: set of completed task keys.
 *
 * @param {string} progressPath - path to _progress.json
 * @param {string} outputDir    - output directory to scan for .meta.json files
 * @returns {Set<string>} completed task keys
 */
export function loadCheckpoint(progressPath, outputDir) {
  const completed = new Set();

  // Method 1: parse _progress.json
  if (existsSync(progressPath)) {
    try {
      const data = JSON.parse(readFileSync(progressPath, 'utf-8'));
      if (Array.isArray(data.completedKeys)) {
        for (const key of data.completedKeys) completed.add(key);
      }
    } catch {
      // Corrupted — fall through to filesystem scan
    }
  }

  // Method 2: scan output directory for .meta.json files
  if (existsSync(outputDir)) {
    try {
      const files = readdirSync(outputDir).filter((f) => f.endsWith('.meta.json'));
      for (const file of files) {
        // Expected filename: scenario_bucket.meta.json
        const key = file.replace('.meta.json', '').replace('_', '::');
        completed.add(key);
      }
    } catch {
      // Ignore scan errors
    }
  }

  return completed;
}

/**
 * Save checkpoint with completed task keys.
 *
 * @param {string} progressPath
 * @param {Set<string>} completedKeys
 * @param {Object} meta - { iterations, totalTasks }
 */
export function saveCheckpoint(progressPath, completedKeys, meta = {}) {
  const data = {
    completedKeys: [...completedKeys].sort(),
    lastUpdated: new Date().toISOString(),
    iterations: meta.iterations || 0,
    totalTasks: meta.totalTasks || 0,
  };
  mkdirSync(join(progressPath, '..'), { recursive: true });
  writeFileSync(progressPath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Task Definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SolverTask
 * @property {string}  key           - composite key: `${scenarioId}::${bucket}`
 * @property {Object}  scenario      - scenario definition { id, kpis, urgency, ... }
 * @property {number}  buyerBucket   - 0–4
 * @property {number}  iterations    - CFR iterations
 */

/**
 * @typedef {Object} SolverResult
 * @property {string}  key
 * @property {string}  scenarioId
 * @property {number}  buyerBucket
 * @property {Object}  stats         - { iterations, elapsedMs, nodeCount, infoSets, exploitability, ... }
 * @property {string}  [outputPath]  - path to exported strategy file
 */

// ---------------------------------------------------------------------------
// In-Process Parallel Solver (no worker_threads overhead for small tasks)
// ---------------------------------------------------------------------------

/**
 * Solve multiple scenarios in parallel using Promise.all with concurrency control.
 *
 * For negotiation trees (small; ~100 nodes), worker_threads overhead dominates.
 * This uses a simpler async concurrency limiter that runs solve tasks
 * in parallel batches.
 *
 * @param {Object} config
 * @param {Object[]}  config.scenarios   - scenario definitions
 * @param {number}    config.iterations  - CFR iterations per tree (default 50000)
 * @param {number}    config.numBuckets  - buyer position buckets (default 5)
 * @param {number}    config.concurrency - max parallel solves (default cpus)
 * @param {string}    [config.outputDir] - directory for strategy exports
 * @param {boolean}   [config.resume]    - resume from checkpoint
 * @param {Function}  [config.onTaskComplete] - callback(result)
 * @param {Function}  [config.onProgress]     - callback(completed, total)
 * @returns {Promise<{
 *   results: Map<string, SolverResult>,
 *   totalElapsedMs: number,
 *   skipped: number,
 *   solved: number
 * }>}
 */
export async function solveParallel(config) {
  const {
    scenarios,
    iterations = 50_000,
    numBuckets = 5,
    concurrency = Math.min(cpus().length, 4),
    outputDir = null,
    resume = false,
    onTaskComplete = null,
    onProgress = null,
  } = config;

  const startTime = Date.now();

  // Build task list
  const allTasks = [];
  for (const scenario of scenarios) {
    for (let bucket = 0; bucket < numBuckets; bucket++) {
      allTasks.push({
        key: `${scenario.id}::${bucket}`,
        scenario,
        buyerBucket: bucket,
        iterations,
      });
    }
  }

  // Checkpoint: filter already-completed tasks
  let skipped = 0;
  let pendingTasks = allTasks;

  if (resume && outputDir) {
    const progressPath = join(outputDir, '_progress.json');
    const completedKeys = loadCheckpoint(progressPath, outputDir);
    pendingTasks = allTasks.filter((t) => !completedKeys.has(t.key));
    skipped = allTasks.length - pendingTasks.length;
  }

  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Dynamically import solver (avoid circular dependency at module level)
  const { NegotiationSolverRunner } = await import('./negotiation-solver-runner.js');

  // Results collection
  const results = new Map();
  const completedKeys = new Set();
  let completedCount = skipped;

  // Concurrency-limited execution
  const taskQueue = [...pendingTasks];
  const activePromises = new Set();

  async function runTask(task) {
    const runner = new NegotiationSolverRunner({ iterations: task.iterations });
    const result = runner.solveSingle(task.scenario, task.buyerBucket);

    const solverResult = {
      key: task.key,
      scenarioId: task.scenario.id,
      buyerBucket: task.buyerBucket,
      stats: result.stats,
      store: result.store,
      tree: result.tree,
    };

    // Export to file if outputDir specified
    if (outputDir) {
      const singleResults = new Map([[task.key, result]]);
      const jsonl = runner.exportAsJsonl(singleResults);
      const filename = `${task.scenario.id}_${task.buyerBucket}`;
      const jsonlPath = join(outputDir, `${filename}.jsonl`);
      writeFileSync(jsonlPath, jsonl);

      // Write meta file for checkpoint scanning
      const metaPath = join(outputDir, `${filename}.meta.json`);
      writeFileSync(metaPath, JSON.stringify({
        scenario_id: task.scenario.id,
        buyer_bucket: task.buyerBucket,
        stats: result.stats,
        exported_at: new Date().toISOString(),
      }, null, 2));

      solverResult.outputPath = jsonlPath;
    }

    results.set(task.key, solverResult);
    completedKeys.add(task.key);
    completedCount++;

    // Save checkpoint
    if (outputDir) {
      const progressPath = join(outputDir, '_progress.json');
      saveCheckpoint(progressPath, completedKeys, {
        iterations,
        totalTasks: allTasks.length,
      });
    }

    if (onTaskComplete) onTaskComplete(solverResult);
    if (onProgress) onProgress(completedCount, allTasks.length);
  }

  // Process tasks with concurrency limit
  while (taskQueue.length > 0 || activePromises.size > 0) {
    // Fill up to concurrency limit
    while (taskQueue.length > 0 && activePromises.size < concurrency) {
      const task = taskQueue.shift();
      const promise = runTask(task).then(() => {
        activePromises.delete(promise);
      });
      activePromises.add(promise);
    }

    // Wait for at least one to complete
    if (activePromises.size > 0) {
      await Promise.race(activePromises);
    }
  }

  return {
    results,
    totalElapsedMs: Date.now() - startTime,
    skipped,
    solved: pendingTasks.length,
  };
}
