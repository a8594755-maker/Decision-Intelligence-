/**
 * Degradation Tests: headerNormalize
 *
 * Validates that the header normalization pipeline handles BOM markers,
 * invisible characters, fullwidth glyphs, NBSP, and other "dirty" header
 * encodings that commonly appear in real-world Excel / CSV exports.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeHeader,
  buildHeaderIndex,
  alignAiMappings,
} from '../../utils/headerNormalize';

describe('headerNormalize – degradation scenarios', () => {
  // ── 1. BOM stripping ────────────────────────────────────────────────────
  it('strips BOM from header and normalizes correctly', () => {
    const result = normalizeHeader('\uFEFFmaterial_code');
    expect(result).toContain('material');
    expect(result).toContain('code');
    // BOM character must be absent in the result
    expect(result).not.toContain('\uFEFF');
  });

  // ── 2. Zero-width space ─────────────────────────────────────────────────
  it('strips zero-width space from header', () => {
    const result = normalizeHeader('plant\u200Bid');
    // The invisible ZWSP must be removed
    expect(result).not.toContain('\u200B');
    // Since there is no real separator between "plant" and "id", the result
    // is the concatenated "plantid" (the ZWSP was simply stripped).
    expect(result).toBe('plantid');
  });

  // ── 3. Fullwidth ASCII ──────────────────────────────────────────────────
  it('converts fullwidth ASCII to halfwidth lowercase', () => {
    // \uFF30 = P, \uFF4C = l, \uFF41 = a, \uFF4E = n, \uFF54 = t
    const result = normalizeHeader('\uFF30\uFF4C\uFF41\uFF4E\uFF54');
    expect(result).toBe('plant');
  });

  // ── 4. NBSP to space ───────────────────────────────────────────────────
  it('replaces NBSP with regular space and collapses whitespace', () => {
    const result = normalizeHeader('Plant\u00A0ID');
    // NBSP should be replaced, result trimmed and lowercased
    expect(result).not.toContain('\u00A0');
    expect(result).toBe('plant id');
  });

  // ── 5. buildHeaderIndex deduplication ───────────────────────────────────
  it('detects duplicate headers that normalize to the same key', () => {
    const headers = [
      'Material_Code',    // normalizes to "material code"
      'material code',    // same
      'MATERIAL CODE',    // same
    ];
    const { index, duplicates, stats } = buildHeaderIndex(headers);

    // All three normalize identically, so 2 are duplicates of the first
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
    expect(duplicates).toContain('material code');
    // Only the first occurrence is kept in the index
    expect(index.get('material code')).toBe('Material_Code');
    expect(stats.unique).toBe(1);
  });

  // ── 6. alignAiMappings ─────────────────────────────────────────────────
  it('aligns AI-returned clean source names to actual dirty headers', () => {
    // Simulate dirty headers from a real file
    const dirtyHeaders = [
      '\uFEFFMaterial_Code',   // BOM-prefixed
      'Plant\u00A0ID',         // NBSP
      'Demand Qty',
    ];
    const { index } = buildHeaderIndex(dirtyHeaders);

    // AI returns clean source names
    const aiMappings = [
      { source: 'material_code', target: 'material_code', confidence: 0.95 },
      { source: 'Plant ID', target: 'plant_id', confidence: 0.90 },
      { source: 'demand_qty', target: 'demand_qty', confidence: 0.88 },
    ];

    const { alignedMappings, unmatchedSources, stats } = alignAiMappings(aiMappings, index);

    expect(stats.aligned).toBe(3);
    expect(stats.unmatched).toBe(0);
    expect(unmatchedSources).toHaveLength(0);

    // The aligned source should point back to the *original* dirty header
    expect(alignedMappings[0].source).toBe('\uFEFFMaterial_Code');
    expect(alignedMappings[1].source).toBe('Plant\u00A0ID');
    expect(alignedMappings[2].source).toBe('Demand Qty');
  });

  // ── 7. Determinism ─────────────────────────────────────────────────────
  it('produces identical normalized index for the same headers across runs', () => {
    const headers = ['Plant_ID', '\uFEFFDemand Qty', 'Material\u200BCode'];

    const result1 = buildHeaderIndex(headers);
    const result2 = buildHeaderIndex(headers);

    // Both runs should have the exact same index entries
    expect([...result1.index.entries()]).toEqual([...result2.index.entries()]);
    expect(result1.duplicates).toEqual(result2.duplicates);
    expect(result1.stats).toEqual(result2.stats);
  });
});
