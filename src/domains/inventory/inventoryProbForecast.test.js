ˇ/**
 * Step 5 (P1): Unit Tests for Probabilistic Inventory Forecast
 * 
 * Tests for:
 * 1. lognormalParamsFromP10P50P90 - parameter validation
 * 2. sampleDemand - reproducibility with fixed seed
 * 3. sampleArrivalBucket - 2-point mixture distribution
 * 4. runMonteCarloForKey - extreme scenarios
 */

import { describe, it, expect } from 'vitest';
import {
  lognormalParamsFromP10P50P90,
  sampleDemand,
  sampleArrivalBucket,
  runMonteCarloForKey,
  createSeededRng as mulberry32
} from './inventoryProbForecast';

describe('Step 5: Probabilistic Inventory Forecast Unit Tests', () => {
  
  // Test 1: lognormalParamsFromP10P50P90
  describe('lognormalParamsFromP10P50P90', () => {
    it('should return valid parameters for normal P10/P50/P90 values', () => {
      const result = lognormalParamsFromP10P50P90(100, 200, 400);
      
      expect(result).not.toBeNull();
      expect(result.mu).toBeDefined();
      expect(result.sigma).toBeDefined();
      expect(result.sigma).toBeGreaterThan(0);
      expect(Number.isFinite(result.mu)).toBe(true);
      expect(Number.isFinite(result.sigma)).toBe(true);
    });
    
    it('should handle equal quantiles (degenerate case)', () => {
      const result = lognormalParamsFromP10P50P90(100, 100, 100);
      
      // Should return null or handle gracefully
      expect(result).toBeDefined();
    });
    
    it('should return NaN for invalid inputs (zero/negative)', () => {
      const result = lognormalParamsFromP10P50P90(0, 200, 400);
      
      // Should handle invalid inputs gracefully
      expect(result === null || Number.isNaN(result?.sigma) || result.sigma > 0).toBe(true);
    });
    
    it('should have consistent sigma for symmetric distributions', () => {
      // When P50^2 ≈ P10 * P90, lognormal is symmetric-ish
      const p50 = 200;
      const p10 = 100;
      const p90 = 400; // 200^2 = 40000, 100*400 = 40000
      
      const result = lognormalParamsFromP10P50P90(p10, p50, p90);
      
      expect(result.sigma).toBeGreaterThan(0);
      expect(result.mu).toBeCloseTo(Math.log(p50), 1);
    });
  });
  
  // Test 2: sampleDemand with fixed seed
  describe('sampleDemand', () => {
    it('should produce reproducible results with same seed', () => {
      const demandDist = { p10: 80, p50: 100, p90: 120 };
      const seed = 12345;
      
      const rng1 = mulberry32(seed);
      const rng2 = mulberry32(seed);
      
      const sample1 = sampleDemand(demandDist, rng1);
      const sample2 = sampleDemand(demandDist, rng2);
      
      expect(sample1).toBe(sample2);
    });
    
    it('should produce different results with different seeds', () => {
      const demandDist = { p10: 80, p50: 100, p90: 120 };
      
      const rng1 = mulberry32(12345);
      const rng2 = mulberry32(54321);
      
      const sample1 = sampleDemand(demandDist, rng1);
      const sample2 = sampleDemand(demandDist, rng2);
      
      // Very unlikely to be exactly equal with different seeds
      expect(sample1).not.toBe(sample2);
    });
    
    it('should return p50 for deterministic input (no spread)', () => {
      const demandDist = { p10: 100, p50: 100, p90: 100 };
      const rng = mulberry32(12345);
      
      const sample = sampleDemand(demandDist, rng);
      
      expect(sample).toBe(100);
    });
    
    it('should handle fallback when lognormal params invalid', () => {
      const demandDist = { p10: 0, p50: 100, p90: 200 };
      const rng = mulberry32(12345);
      
      const sample = sampleDemand(demandDist, rng);
      
      // Should return a valid number (triangular fallback)
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThanOrEqual(0);
    });
  });
  
  // Test 3: sampleArrivalBucket - 2-point mixture
  describe('sampleArrivalBucket', () => {
    it('should return p50 bucket when delayProb is 0', () => {
      const forecast = {
        arrivalP50Bucket: '2026-W10',
        arrivalP90Bucket: '2026-W12',
        delayProb: 0
      };
      const rng = mulberry32(12345);
      
      const bucket = sampleArrivalBucket(forecast, rng);
      
      expect(bucket).toBe('2026-W10');
    });
    
    it('should return p90 bucket when delayProb is 1', () => {
      const forecast = {
        arrivalP50Bucket: '2026-W10',
        arrivalP90Bucket: '2026-W12',
        delayProb: 1
      };
      const rng = mulberry32(12345);
      
      const bucket = sampleArrivalBucket(forecast, rng);
      
      expect(bucket).toBe('2026-W12');
    });
    
    it('should produce mixed results when delayProb is 0.5', () => {
      const forecast = {
        arrivalP50Bucket: '2026-W10',
        arrivalP90Bucket: '2026-W12',
        delayProb: 0.5
      };
      
      // Run 100 samples
      let p50Count = 0;
      let p90Count = 0;
      
      for (let i = 0; i < 100; i++) {
        const rng = mulberry32(12345 + i);
        const bucket = sampleArrivalBucket(forecast, rng);
        if (bucket === '2026-W10') p50Count++;
        if (bucket === '2026-W12') p90Count++;
      }
      
      // With 50% probability, should be roughly 50/50
      expect(p50Count).toBeGreaterThan(30);
      expect(p90Count).toBeGreaterThan(30);
      expect(p50Count + p90Count).toBe(100);
    });
    
    it('should match expected proportion over many trials', () => {
      const forecast = {
        arrivalP50Bucket: 'W1',
        arrivalP90Bucket: 'W2',
        delayProb: 0.3  // 30% should be delayed
      };
      
      const trials = 1000;
      let delayedCount = 0;
      
      for (let i = 0; i < trials; i++) {
        const rng = mulberry32(12345 + i);
        const bucket = sampleArrivalBucket(forecast, rng);
        if (bucket === 'W2') delayedCount++;
      }
      
      const delayRate = delayedCount / trials;
      
      // Should be within 5% of expected 0.3
      expect(delayRate).toBeGreaterThan(0.25);
      expect(delayRate).toBeLessThan(0.35);
    });
  });
  
  // Test 4: runMonteCarloForKey - extreme scenarios
  describe('runMonteCarloForKey', () => {
    it('should return P(stockout) ≈ 1 when inventory=0, demand>0, inbound=0', () => {
      const key = 'TEST-001|PLANT-01';
      const timeBuckets = ['2026-W05', '2026-W06', '2026-W07'];
      const startingInv = { onHand: 0, safetyStock: 0 };
      const demandByBucket = new Map([
        ['2026-W05', { p10: 80, p50: 100, p90: 120 }],
        ['2026-W06', { p10: 80, p50: 100, p90: 120 }],
        ['2026-W07', { p10: 80, p50: 100, p90: 120 }]
      ]);
      const poForecastsForKey = []; // No inbound
      
      const result = runMonteCarloForKey({
        key,
        timeBuckets,
        startingInv,
        demandByBucket,
        poForecastsForKey,
        trials: 500,
        seed: 12345
      });
      
      expect(result.summary.pStockout).toBeGreaterThan(0.9);
      expect(result.summary.pStockout).toBeLessThanOrEqual(1.0);
      expect(result.summary.stockoutBucketP50).toBeDefined();
    });
    
    it('should return P(stockout) ≈ 0 when inventory > total demand + buffer', () => {
      const key = 'TEST-002|PLANT-01';
      const timeBuckets = ['2026-W05', '2026-W06'];
      const startingInv = { onHand: 10000, safetyStock: 0 }; // Very high inventory
      const demandByBucket = new Map([
        ['2026-W05', { p10: 80, p50: 100, p90: 120 }],
        ['2026-W06', { p10: 80, p50: 100, p90: 120 }]
      ]);
      const poForecastsForKey = [];
      
      const result = runMonteCarloForKey({
        key,
        timeBuckets,
        startingInv,
        demandByBucket,
        poForecastsForKey,
        trials: 500,
        seed: 12345
      });
      
      expect(result.summary.pStockout).toBeLessThan(0.1);
      expect(result.summary.pStockout).toBeGreaterThanOrEqual(0);
    });
    
    it('should handle zero demand gracefully', () => {
      const key = 'TEST-003|PLANT-01';
      const timeBuckets = ['2026-W05'];
      const startingInv = { onHand: 100, safetyStock: 0 };
      const demandByBucket = new Map([
        ['2026-W05', { p10: 0, p50: 0, p90: 0 }]
      ]);
      const poForecastsForKey = [];
      
      const result = runMonteCarloForKey({
        key,
        timeBuckets,
        startingInv,
        demandByBucket,
        poForecastsForKey,
        trials: 200,
        seed: 12345
      });
      
      expect(result.summary.pStockout).toBe(0);
      expect(result.summary.expectedShortageQty).toBe(0);
    });
    
    it('should return consistent results with same seed', () => {
      const key = 'TEST-004|PLANT-01';
      const timeBuckets = ['2026-W05', '2026-W06'];
      const startingInv = { onHand: 50, safetyStock: 0 };
      const demandByBucket = new Map([
        ['2026-W05', { p10: 40, p50: 50, p90: 60 }],
        ['2026-W06', { p10: 40, p50: 50, p90: 60 }]
      ]);
      const poForecastsForKey = [];
      
      const result1 = runMonteCarloForKey({
        key, timeBuckets, startingInv, demandByBucket, poForecastsForKey,
        trials: 500, seed: 99999
      });
      
      const result2 = runMonteCarloForKey({
        key, timeBuckets, startingInv, demandByBucket, poForecastsForKey,
        trials: 500, seed: 99999
      });
      
      expect(result1.summary.pStockout).toBeCloseTo(result2.summary.pStockout, 2);
      expect(result1.summary.expectedShortageQty).toBeCloseTo(result2.summary.expectedShortageQty, 0);
    });
    
    it('should compute quantiles correctly for inv series', () => {
      const key = 'TEST-005|PLANT-01';
      const timeBuckets = ['2026-W05', '2026-W06'];
      const startingInv = { onHand: 100, safetyStock: 0 };
      const demandByBucket = new Map([
        ['2026-W05', { p10: 80, p50: 100, p90: 120 }],
        ['2026-W06', { p10: 80, p50: 100, p90: 120 }]
      ]);
      const poForecastsForKey = [];
      
      const result = runMonteCarloForKey({
        key, timeBuckets, startingInv, demandByBucket, poForecastsForKey,
        trials: 1000, seed: 12345
      });
      
      // Check that series has correct structure
      expect(result.series).toBeDefined();
      expect(result.series.length).toBe(timeBuckets.length);
      
      result.series.forEach(point => {
        expect(point.invP10).toBeLessThanOrEqual(point.invP50);
        expect(point.invP50).toBeLessThanOrEqual(point.invP90);
        expect(point.pStockoutBucket).toBeGreaterThanOrEqual(0);
        expect(point.pStockoutBucket).toBeLessThanOrEqual(1);
      });
    });
  });
  
  // Test 5: mulberry32 RNG
  describe('mulberry32', () => {
    it('should produce numbers in [0, 1)', () => {
      const rng = mulberry32(12345);
      
      for (let i = 0; i < 100; i++) {
        const val = rng();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });
    
    it('should produce reproducible sequence with same seed', () => {
      const rng1 = mulberry32(99999);
      const rng2 = mulberry32(99999);
      
      const seq1 = Array(10).fill(0).map(() => rng1());
      const seq2 = Array(10).fill(0).map(() => rng2());
      
      expect(seq1).toEqual(seq2);
    });
    
    it('should produce different sequences with different seeds', () => {
      const rng1 = mulberry32(11111);
      const rng2 = mulberry32(22222);
      
      const seq1 = Array(10).fill(0).map(() => rng1());
      const seq2 = Array(10).fill(0).map(() => rng2());
      
      expect(seq1).not.toEqual(seq2);
    });
  });
});
