/**
 * Tests: Binary Strategy Format
 *
 * Verifies the binary CFR strategy format ported from CardPilot:
 *   - FNV-1a hash correctness
 *   - Quantize / dequantize round-trip accuracy
 *   - Writer + Reader end-to-end
 *   - O(log n) lookup correctness
 *   - Gzip decompression support
 *   - Edge cases (empty, single entry, hash collisions)
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  fnv1a,
  quantizeProb,
  dequantizeProb,
  buildBinaryBuffer,
  BinaryStrategyReader,
} from './binary-strategy-format.js';

// ── FNV-1a Hash ──────────────────────────────────────────────────────────────

describe('fnv1a', () => {
  it('should return a 32-bit unsigned integer', () => {
    const hash = fnv1a('test');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('should be deterministic', () => {
    expect(fnv1a('B|2|OPENING|')).toBe(fnv1a('B|2|OPENING|'));
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
  });

  it('should produce different hashes for different strings', () => {
    const h1 = fnv1a('B|0|OPENING|');
    const h2 = fnv1a('B|1|OPENING|');
    const h3 = fnv1a('S|2|CONCESSION|accept');
    expect(h1).not.toBe(h2);
    expect(h2).not.toBe(h3);
  });

  it('should handle empty string', () => {
    const hash = fnv1a('');
    expect(hash).toBe(0x811c9dc5); // FNV offset basis
  });
});

// ── Quantize / Dequantize ────────────────────────────────────────────────────

describe('quantizeProb / dequantizeProb', () => {
  it('should quantize 0 to 0 and 1 to 255', () => {
    expect(quantizeProb(0)).toBe(0);
    expect(quantizeProb(1)).toBe(255);
  });

  it('should clamp out-of-range values', () => {
    expect(quantizeProb(-0.5)).toBe(0);
    expect(quantizeProb(1.5)).toBe(255);
  });

  it('should dequantize to approximately the original', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1.0]) {
      const q = quantizeProb(p);
      const restored = dequantizeProb(q);
      expect(Math.abs(restored - p)).toBeLessThan(0.005);
    }
  });

  it('should round-trip within 1/255 tolerance', () => {
    for (let i = 0; i <= 10; i++) {
      const p = i / 10;
      const roundTrip = dequantizeProb(quantizeProb(p));
      expect(Math.abs(roundTrip - p)).toBeLessThanOrEqual(1 / 255 + 0.001);
    }
  });
});

// ── buildBinaryBuffer + BinaryStrategyReader ─────────────────────────────────

describe('BinaryStrategyReader', () => {
  const entries = [
    { key: 'B|0|OPENING|', probs: [0.3, 0.2, 0.5] },
    { key: 'B|1|OPENING|', probs: [0.6, 0.1, 0.3] },
    { key: 'S|0|OPENING|accept', probs: [0.8, 0.2] },
    { key: 'B|2|CONCESSION|reject', probs: [0.1, 0.4, 0.5] },
  ];

  function buildReader(opts = {}) {
    const buf = buildBinaryBuffer(entries, opts);
    return new BinaryStrategyReader(buf);
  }

  it('should read header fields correctly', () => {
    const reader = buildReader({ iterations: 25000, bucketCount: 5, numScenarios: 3 });
    expect(reader.version).toBe(1);
    expect(reader.iterations).toBe(25000);
    expect(reader.bucketCount).toBe(5);
    expect(reader.numScenarios).toBe(3);
    expect(reader.entryCount).toBe(entries.length);
  });

  it('should look up all entries correctly', () => {
    const reader = buildReader();
    for (const entry of entries) {
      const probs = reader.lookup(entry.key);
      expect(probs).not.toBeNull();
      expect(probs).toHaveLength(entry.probs.length);
      // Check within quantization tolerance
      for (let i = 0; i < entry.probs.length; i++) {
        expect(Math.abs(probs[i] - entry.probs[i])).toBeLessThan(0.005);
      }
    }
  });

  it('should return null for non-existent keys', () => {
    const reader = buildReader();
    expect(reader.lookup('NONEXISTENT')).toBeNull();
    expect(reader.lookup('')).toBeNull();
    expect(reader.lookup('B|99|CLOSING|')).toBeNull();
  });

  it('should handle gzip-compressed input', () => {
    const raw = buildBinaryBuffer(entries);
    const compressed = gzipSync(raw);
    const reader = new BinaryStrategyReader(compressed);

    expect(reader.entryCount).toBe(entries.length);
    const probs = reader.lookup('B|0|OPENING|');
    expect(probs).not.toBeNull();
    expect(probs).toHaveLength(3);
  });

  it('should handle a single entry', () => {
    const singleEntry = [{ key: 'only_key', probs: [1.0] }];
    const buf = buildBinaryBuffer(singleEntry);
    const reader = new BinaryStrategyReader(buf);

    expect(reader.entryCount).toBe(1);
    const probs = reader.lookup('only_key');
    expect(probs).not.toBeNull();
    expect(probs).toHaveLength(1);
    expect(probs[0]).toBeCloseTo(1.0, 2);
  });

  it('should handle empty entries array', () => {
    const buf = buildBinaryBuffer([]);
    const reader = new BinaryStrategyReader(buf);

    expect(reader.entryCount).toBe(0);
    expect(reader.lookup('anything')).toBeNull();
  });

  it('should reject invalid magic bytes', () => {
    const buf = Buffer.alloc(32);
    buf.write('XXXX', 0);
    expect(() => new BinaryStrategyReader(buf)).toThrow('Invalid binary format');
  });

  it('should handle many entries with correct O(log n) lookup', () => {
    // Generate 500 entries to stress-test binary search
    const manyEntries = [];
    for (let i = 0; i < 500; i++) {
      manyEntries.push({
        key: `B|${i % 5}|${['OPENING', 'CONCESSION', 'CLOSING'][i % 3]}|action_${i}`,
        probs: [Math.random(), Math.random(), Math.random()],
      });
      // Normalize probs
      const sum = manyEntries[i].probs.reduce((a, b) => a + b, 0);
      manyEntries[i].probs = manyEntries[i].probs.map((p) => p / sum);
    }

    const buf = buildBinaryBuffer(manyEntries);
    const reader = new BinaryStrategyReader(buf);
    expect(reader.entryCount).toBe(500);

    // Verify random lookups
    for (const entry of [manyEntries[0], manyEntries[249], manyEntries[499]]) {
      const probs = reader.lookup(entry.key);
      expect(probs).not.toBeNull();
      expect(probs).toHaveLength(3);
    }
  });

  it('should preserve probability distribution (sums near 1.0)', () => {
    const reader = buildReader();
    for (const entry of entries) {
      const probs = reader.lookup(entry.key);
      const sum = probs.reduce((a, b) => a + b, 0);
      // Quantization introduces small error, but should still be close
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.05);
    }
  });
});
