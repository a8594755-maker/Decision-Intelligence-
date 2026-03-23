/**
 * chartSpecInference.test.js
 *
 * Tests for the universal chart type inference engine.
 * All tests use generic data — no hardcoded column names.
 */

import { describe, it, expect } from 'vitest';
import { inferChartSpec, getCompatibleTypes } from './chartSpecInference.js';

describe('inferChartSpec', () => {
  // ── Empty / invalid input ──────────────────────────────────────────────────

  it('returns null for empty array', () => {
    expect(inferChartSpec([])).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(inferChartSpec(null)).toBeNull();
    expect(inferChartSpec(undefined)).toBeNull();
  });

  it('returns null for single-column data', () => {
    const rows = [{ name: 'A' }, { name: 'B' }];
    expect(inferChartSpec(rows)).toBeNull();
  });

  // ── Categorical + 1 Numeric → horizontal_bar ──────────────────────────────

  it('infers horizontal_bar for 1 string + 1 number (few categories)', () => {
    const rows = [
      { region: 'North', sales: 100 },
      { region: 'South', sales: 200 },
      { region: 'East', sales: 150 },
      { region: 'West', sales: 180 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('horizontal_bar');
    expect(spec.xKey).toBe('region');
    expect(spec.yKey).toBe('sales');
    expect(spec.compatibleTypes).toContain('horizontal_bar');
    expect(spec.compatibleTypes).toContain('bar');
    expect(spec.compatibleTypes).toContain('pie');
  });

  it('works with non-English column names (Chinese)', () => {
    const rows = [
      { '州別': 'SP', '客戶數': 41746 },
      { '州別': 'RJ', '客戶數': 12852 },
      { '州別': 'MG', '客戶數': 11635 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('horizontal_bar');
    expect(spec.xKey).toBe('州別');
    expect(spec.yKey).toBe('客戶數');
  });

  it('works with non-English column names (Japanese)', () => {
    const rows = [
      { '都市': 'Tokyo', '人口': 14000000 },
      { '都市': 'Osaka', '人口': 8800000 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.xKey).toBe('都市');
    expect(spec.yKey).toBe('人口');
  });

  // ── Proportion detection → pie ─────────────────────────────────────────────

  it('infers pie for small cardinality + values summing to ~100', () => {
    const rows = [
      { method: 'Credit', share: 45.2 },
      { method: 'Debit', share: 30.1 },
      { method: 'Cash', share: 15.5 },
      { method: 'Other', share: 9.2 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('pie');
    expect(spec.compatibleTypes).toContain('donut');
  });

  it('infers pie for values summing to ~1.0 (proportions)', () => {
    const rows = [
      { segment: 'A', ratio: 0.45 },
      { segment: 'B', ratio: 0.30 },
      { segment: 'C', ratio: 0.25 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('pie');
  });

  it('does NOT infer pie when values do not sum to 100 or 1', () => {
    const rows = [
      { category: 'A', count: 500 },
      { category: 'B', count: 300 },
      { category: 'C', count: 200 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('horizontal_bar'); // not pie
  });

  // ── Date + Numeric → line ─────────────────────────────────────────────────

  it('infers line for date + numeric columns', () => {
    const rows = [
      { month: '2024-01', revenue: 10000 },
      { month: '2024-02', revenue: 12000 },
      { month: '2024-03', revenue: 11000 },
      { month: '2024-04', revenue: 15000 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('line');
    expect(spec.xKey).toBe('month');
    expect(spec.yKey).toBe('revenue');
    expect(spec.compatibleTypes).toContain('line');
    expect(spec.compatibleTypes).toContain('area');
  });

  it('infers line for ISO date format', () => {
    const rows = [
      { date: '2024-01-15', value: 100 },
      { date: '2024-02-15', value: 200 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('line');
  });

  it('infers multi-series line for date + multiple numeric', () => {
    const rows = [
      { date: '2024-01', orders: 100, revenue: 5000 },
      { date: '2024-02', orders: 120, revenue: 6000 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('line');
    expect(spec.series).toContain('orders');
    expect(spec.series).toContain('revenue');
  });

  // ── 2 Numeric only → scatter ──────────────────────────────────────────────

  it('infers scatter for 2 numeric columns only', () => {
    const rows = [
      { price: 10, rating: 4.5 },
      { price: 20, rating: 3.8 },
      { price: 15, rating: 4.2 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('scatter');
    expect(spec.compatibleTypes).toContain('scatter');
    expect(spec.compatibleTypes).toContain('line');
  });

  // ── Categorical + 2+ Numeric → grouped_bar ────────────────────────────────

  it('infers grouped_bar for 1 string + 2 numeric', () => {
    const rows = [
      { department: 'Sales', q1: 100, q2: 150 },
      { department: 'Engineering', q1: 200, q2: 180 },
      { department: 'Marketing', q1: 80, q2: 120 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('grouped_bar');
    expect(spec.series).toContain('q1');
    expect(spec.series).toContain('q2');
    expect(spec.compatibleTypes).toContain('stacked_bar');
  });

  // ── Large cardinality → bar (not horizontal) ──────────────────────────────

  it('infers bar for many unique categorical values (>30)', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      sku: `SKU-${i}`,
      qty: Math.floor(Math.random() * 100),
    }));
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    expect(spec.type).toBe('bar');
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns null when all columns are strings', () => {
    const rows = [
      { name: 'Alice', city: 'NY' },
      { name: 'Bob', city: 'LA' },
    ];
    expect(inferChartSpec(rows)).toBeNull();
  });

  it('handles mixed numeric strings correctly', () => {
    const rows = [
      { item: 'A', amount: '100' },
      { item: 'B', amount: '200' },
      { item: 'C', amount: '300' },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
    // amount is string but 80%+ parseable as number → treated as numeric
    expect(spec.yKey).toBe('amount');
  });

  it('handles null values gracefully', () => {
    const rows = [
      { cat: 'X', val: 10 },
      { cat: 'Y', val: null },
      { cat: 'Z', val: 30 },
    ];
    const spec = inferChartSpec(rows);
    expect(spec).not.toBeNull();
  });
});

describe('getCompatibleTypes', () => {
  it('includes the requested type in results', () => {
    const rows = [{ a: 'x', b: 10 }];
    const types = getCompatibleTypes('line', rows);
    expect(types).toContain('line');
  });

  it('returns fallback pairings when inference fails', () => {
    const types = getCompatibleTypes('bar', []);
    expect(types).toContain('bar');
  });
});
