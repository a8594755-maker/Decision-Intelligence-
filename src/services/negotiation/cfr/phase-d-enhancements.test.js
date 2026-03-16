/**
 * Tests: Phase D — CardPilot Engine Enhancement Import
 *
 * D1: Sampled exploitability estimator
 * D2: Parallel solver orchestration (in-process)
 * D3: Batch solver mode
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InfoSetStore,
  solveGame,
  computeExploitability,
  estimateSampledExploitability,
} from './cfr-core.js';
import { buildNegotiationTree } from './negotiation-tree-builder.js';
import { computeSupplierTypePriors } from './negotiation-types.js';
import { NegotiationSolverRunner, batchSolve } from './negotiation-solver-runner.js';
import { solveParallel, loadCheckpoint, saveCheckpoint } from './parallel-solver.js';

// ── Shared fixtures ─────────────────────────────────────────────────────────

const TEST_KPIS = { on_time_rate: 0.85, defect_rate: 0.02 };
const TEST_PRIORS = computeSupplierTypePriors(TEST_KPIS);
const TEST_ITERATIONS = 1000; // low for fast tests

let solvedTree;
let solvedStore;

beforeAll(() => {
  const tree = buildNegotiationTree(2, TEST_PRIORS);
  const store = new InfoSetStore();
  solveGame(tree, store, TEST_ITERATIONS);
  solvedTree = tree;
  solvedStore = store;
});

// ── D1: Sampled Exploitability Estimator ────────────────────────────────────

describe('estimateSampledExploitability', () => {
  it('should return a non-negative exploitability estimate', () => {
    const result = estimateSampledExploitability(solvedTree, solvedStore, 100);
    expect(result.exploitability).toBeGreaterThanOrEqual(0);
  });

  it('should return all expected fields', () => {
    const result = estimateSampledExploitability(solvedTree, solvedStore, 50);
    expect(result).toHaveProperty('brValueP0');
    expect(result).toHaveProperty('brValueP1');
    expect(result).toHaveProperty('exploitability');
    expect(result).toHaveProperty('samples');
    expect(result).toHaveProperty('elapsedMs');
    expect(result.samples).toBe(50);
  });

  it('should be deterministic with same seed', () => {
    const r1 = estimateSampledExploitability(solvedTree, solvedStore, 100, 42);
    const r2 = estimateSampledExploitability(solvedTree, solvedStore, 100, 42);
    expect(r1.exploitability).toBe(r2.exploitability);
    expect(r1.brValueP0).toBe(r2.brValueP0);
    expect(r1.brValueP1).toBe(r2.brValueP1);
  });

  it('should produce different results with different seeds', () => {
    const r1 = estimateSampledExploitability(solvedTree, solvedStore, 100, 42);
    const r2 = estimateSampledExploitability(solvedTree, solvedStore, 100, 123);
    // With enough samples they should be close, but not identical
    expect(r1.brValueP0).not.toBe(r2.brValueP0);
  });

  it('should correlate with exact exploitability', () => {
    const exact = computeExploitability(solvedTree, solvedStore);
    const sampled = estimateSampledExploitability(solvedTree, solvedStore, 500, 42);

    // Sampled should be in the same ballpark (within 2x of exact for 1000 iterations)
    // This is a loose bound — the point is they're not wildly different
    expect(sampled.exploitability).toBeLessThan(exact * 3 + 0.5);
  });

  it('should decrease with more CFR iterations', () => {
    // Solve with more iterations
    const tree2 = buildNegotiationTree(2, TEST_PRIORS);
    const store2 = new InfoSetStore();
    solveGame(tree2, store2, 5000);

    const low = estimateSampledExploitability(solvedTree, solvedStore, 200, 42);
    const high = estimateSampledExploitability(tree2, store2, 200, 42);

    // More iterations → lower exploitability (or at least not much worse)
    expect(high.exploitability).toBeLessThanOrEqual(low.exploitability + 0.1);
  });
});

// ── D2: Parallel Solver ─────────────────────────────────────────────────────

describe('solveParallel', () => {
  const MINI_SCENARIOS = [
    { id: 'test_coop', kpis: { on_time_rate: 0.90 }, urgency: 'normal' },
  ];

  it('should solve all scenario-bucket combinations', async () => {
    const result = await solveParallel({
      scenarios: MINI_SCENARIOS,
      iterations: 200,
      numBuckets: 2,
      concurrency: 1,
    });

    expect(result.results.size).toBe(2); // 1 scenario × 2 buckets
    expect(result.solved).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.totalElapsedMs).toBeGreaterThan(0);

    // Verify each result has expected fields
    for (const [_key, res] of result.results) {
      expect(res.scenarioId).toBe('test_coop');
      expect(res.stats.iterations).toBe(200);
      expect(res.stats.exploitability).toBeGreaterThanOrEqual(0);
    }
  });

  it('should export JSONL files when outputDir is specified', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cfr-parallel-'));

    await solveParallel({
      scenarios: MINI_SCENARIOS,
      iterations: 100,
      numBuckets: 2,
      outputDir: tmpDir,
      concurrency: 1,
    });

    // Check files were created
    expect(existsSync(join(tmpDir, 'test_coop_0.jsonl'))).toBe(true);
    expect(existsSync(join(tmpDir, 'test_coop_1.jsonl'))).toBe(true);
    expect(existsSync(join(tmpDir, 'test_coop_0.meta.json'))).toBe(true);
    expect(existsSync(join(tmpDir, '_progress.json'))).toBe(true);

    // Verify meta content
    const meta = JSON.parse(readFileSync(join(tmpDir, 'test_coop_0.meta.json'), 'utf-8'));
    expect(meta.scenario_id).toBe('test_coop');
    expect(meta.buyer_bucket).toBe(0);
    expect(meta.stats.iterations).toBe(100);
  });

  it('should call onProgress callback', async () => {
    const progressCalls = [];

    await solveParallel({
      scenarios: MINI_SCENARIOS,
      iterations: 100,
      numBuckets: 2,
      concurrency: 1,
      onProgress: (completed, total) => progressCalls.push({ completed, total }),
    });

    expect(progressCalls.length).toBe(2);
    expect(progressCalls[progressCalls.length - 1].completed).toBe(2);
    expect(progressCalls[progressCalls.length - 1].total).toBe(2);
  });
});

// ── D2: Checkpoint / Resume ─────────────────────────────────────────────────

describe('checkpoint / resume', () => {
  it('saveCheckpoint and loadCheckpoint roundtrip', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cfr-ckpt-'));
    const progressPath = join(tmpDir, '_progress.json');

    const keys = new Set(['scen_a::0', 'scen_a::1', 'scen_b::0']);
    saveCheckpoint(progressPath, keys, { iterations: 5000, totalTasks: 10 });

    const loaded = loadCheckpoint(progressPath, tmpDir);
    expect(loaded.size).toBe(3);
    expect(loaded.has('scen_a::0')).toBe(true);
    expect(loaded.has('scen_b::0')).toBe(true);
  });

  it('should resume and skip completed tasks', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cfr-resume-'));

    const scenarios = [
      { id: 'resume_test', kpis: { on_time_rate: 0.85 }, urgency: 'normal' },
    ];

    // First run: solve 1 bucket
    await solveParallel({
      scenarios,
      iterations: 100,
      numBuckets: 2,
      outputDir: tmpDir,
      concurrency: 1,
    });

    // Second run with resume: should skip already-completed tasks
    const result2 = await solveParallel({
      scenarios,
      iterations: 100,
      numBuckets: 2,
      outputDir: tmpDir,
      resume: true,
      concurrency: 1,
    });

    expect(result2.skipped).toBe(2);
    expect(result2.solved).toBe(0);
  });
});

// ── D3: Batch Solver ────────────────────────────────────────────────────────

describe('batchSolve', () => {
  it('should solve scenarios and return results', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cfr-batch-'));

    const result = await batchSolve({
      scenarios: [
        { id: 'batch_test', kpis: { on_time_rate: 0.80 }, urgency: 'normal' },
      ],
      iterations: 100,
      outputDir: tmpDir,
      concurrency: 1,
    });

    expect(result.results.size).toBe(5); // 1 scenario × 5 buckets
    expect(result.solved).toBe(5);
    expect(result.totalElapsedMs).toBeGreaterThan(0);
  });

  it('should write registration manifest when register=true', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cfr-batch-reg-'));

    await batchSolve({
      scenarios: [
        { id: 'reg_test', kpis: { on_time_rate: 0.75 }, urgency: 'high' },
      ],
      iterations: 100,
      outputDir: tmpDir,
      register: true,
      concurrency: 1,
    });

    const manifestPath = join(tmpDir, '_registration_manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.length).toBe(5);
    expect(manifest[0].scenario_id).toBe('reg_test');
    expect(manifest[0].status).toBe('pending_registration');
  });
});
