/**
 * Unit Tests: scenarioKey.js
 *
 * Tests:
 * 1. stableStringify: key-order independence, null handling
 * 2. canonicalizeOverrides: null stripping, known keys only
 * 3. computeScenarioKeySync: same overrides different order → same key
 * 4. computeScenarioKeySync: different overrides → different keys
 * 5. computeScenarioKeySync: null overrides == missing overrides
 */

import { describe, it, expect } from 'vitest';
import {
  stableStringify,
  canonicalizeOverrides,
  computeScenarioKeySync
} from './scenarioKey';

// ── stableStringify ──────────────────────────────────────────────────────────

describe('stableStringify', () => {
  it('serializes primitive values', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
  });

  it('sorts object keys alphabetically', () => {
    const obj1 = { b: 2, a: 1 };
    const obj2 = { a: 1, b: 2 };
    expect(stableStringify(obj1)).toBe(stableStringify(obj2));
  });

  it('is deterministic for nested objects', () => {
    const obj1 = { z: { y: 3, x: 2 }, a: 1 };
    const obj2 = { a: 1, z: { x: 2, y: 3 } };
    expect(stableStringify(obj1)).toBe(stableStringify(obj2));
  });

  it('preserves array order', () => {
    const arr1 = [1, 2, 3];
    const arr2 = [3, 2, 1];
    expect(stableStringify(arr1)).not.toBe(stableStringify(arr2));
  });

  it('produces null for Infinity and NaN', () => {
    expect(stableStringify(Infinity)).toBe('null');
    expect(stableStringify(NaN)).toBe('null');
  });

  it('omits undefined values from objects', () => {
    const obj = { a: 1, b: undefined };
    const serialized = stableStringify(obj);
    expect(serialized).not.toContain('"b"');
    expect(serialized).toContain('"a"');
  });
});

// ── canonicalizeOverrides ─────────────────────────────────────────────────────

describe('canonicalizeOverrides', () => {
  it('drops null values', () => {
    const overrides = {
      budget_cap: 10000,
      service_target: null,
      stockout_penalty_multiplier: null,
      safety_stock_alpha: 0.5
    };
    const result = canonicalizeOverrides(overrides);
    expect(result).not.toHaveProperty('service_target');
    expect(result).not.toHaveProperty('stockout_penalty_multiplier');
    expect(result.budget_cap).toBe(10000);
    expect(result.safety_stock_alpha).toBe(0.5);
  });

  it('drops unknown keys', () => {
    const overrides = {
      budget_cap: 5000,
      some_unknown_field: 'xyz'
    };
    const result = canonicalizeOverrides(overrides);
    expect(result).not.toHaveProperty('some_unknown_field');
    expect(result.budget_cap).toBe(5000);
  });

  it('returns empty object for empty/null input', () => {
    expect(canonicalizeOverrides({})).toEqual({});
    expect(canonicalizeOverrides(null)).toEqual({});
    expect(canonicalizeOverrides(undefined)).toEqual({});
  });

  it('preserves valid toggle values (on/off)', () => {
    const overrides = { risk_mode: 'on', expedite_mode: 'off' };
    const result = canonicalizeOverrides(overrides);
    expect(result.risk_mode).toBe('on');
    expect(result.expedite_mode).toBe('off');
  });
});

// ── computeScenarioKeySync ───────────────────────────────────────────────────

describe('computeScenarioKeySync: key-order independence', () => {
  it('produces the same key regardless of override key order', () => {
    const overrides1 = { budget_cap: 5000, safety_stock_alpha: 0.5 };
    const overrides2 = { safety_stock_alpha: 0.5, budget_cap: 5000 };

    const key1 = computeScenarioKeySync(42, overrides1, {});
    const key2 = computeScenarioKeySync(42, overrides2, {});

    expect(key1).toBe(key2);
  });

  it('is stable for same inputs (repeated calls)', () => {
    const overrides = { stockout_penalty_multiplier: 2.5, risk_mode: 'on' };
    const key1 = computeScenarioKeySync(99, overrides, {});
    const key2 = computeScenarioKeySync(99, overrides, {});
    expect(key1).toBe(key2);
  });
});

describe('computeScenarioKeySync: different inputs → different keys', () => {
  it('produces different keys for different base_run_ids', () => {
    const overrides = { budget_cap: 1000 };
    const key1 = computeScenarioKeySync(1, overrides, {});
    const key2 = computeScenarioKeySync(2, overrides, {});
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different overrides', () => {
    const key1 = computeScenarioKeySync(10, { budget_cap: 1000 }, {});
    const key2 = computeScenarioKeySync(10, { budget_cap: 2000 }, {});
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different engine_flags', () => {
    const overrides = { safety_stock_alpha: 0.5 };
    const key1 = computeScenarioKeySync(10, overrides, { risk_mode: 'on' });
    const key2 = computeScenarioKeySync(10, overrides, { risk_mode: 'off' });
    expect(key1).not.toBe(key2);
  });
});

describe('computeScenarioKeySync: null == missing override', () => {
  it('treats { budget_cap: null } the same as {}', () => {
    const key1 = computeScenarioKeySync(5, { budget_cap: null }, {});
    const key2 = computeScenarioKeySync(5, {}, {});
    expect(key1).toBe(key2);
  });

  it('treats partially null overrides consistently', () => {
    const key1 = computeScenarioKeySync(5, { budget_cap: 1000, service_target: null }, {});
    const key2 = computeScenarioKeySync(5, { budget_cap: 1000 }, {});
    expect(key1).toBe(key2);
  });
});
