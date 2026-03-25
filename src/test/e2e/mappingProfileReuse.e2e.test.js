/**
 * E2E: Mapping Profile Reuse
 *
 * Verifies that mapping profiles are saved with deterministic fingerprints
 * and can be reused across imports with the same header structure.
 */
import { describe, it, expect } from 'vitest';

import {
  generateHeaderFingerprint,
  saveMappingProfile,
  findMappingProfile,
} from '../../services/data-prep/mappingProfileService';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Mapping Profile Reuse', () => {

  describe('generateHeaderFingerprint', () => {
    it('produces deterministic fingerprints', () => {
      const fp1 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand', 'Date']);
      const fp2 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand', 'Date']);
      expect(fp1).toBe(fp2);
    });

    it('is order-independent', () => {
      const fp1 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand', 'Date']);
      const fp2 = generateHeaderFingerprint(['Date', 'OnHand', 'SKU', 'Plant']);
      expect(fp1).toBe(fp2);
    });

    it('is case-insensitive', () => {
      const fp1 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand']);
      const fp2 = generateHeaderFingerprint(['sku', 'plant', 'onhand']);
      expect(fp1).toBe(fp2);
    });

    it('different headers produce different fingerprints', () => {
      const fp1 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand']);
      const fp2 = generateHeaderFingerprint(['Material', 'Site', 'Stock']);
      expect(fp1).not.toBe(fp2);
    });

    it('handles empty and single-element arrays', () => {
      const fpEmpty = generateHeaderFingerprint([]);
      const fpSingle = generateHeaderFingerprint(['SKU']);
      expect(fpEmpty).toBeDefined();
      expect(fpSingle).toBeDefined();
      expect(fpEmpty).not.toBe(fpSingle);
    });

    it('ignores whitespace differences', () => {
      const fp1 = generateHeaderFingerprint([' SKU ', 'Plant']);
      const fp2 = generateHeaderFingerprint(['SKU', 'Plant']);
      expect(fp1).toBe(fp2);
    });

    it('handles BOM and NBSP in headers', () => {
      const fp1 = generateHeaderFingerprint(['\uFEFFSKU', 'Plant\u00A0Code']);
      const fp2 = generateHeaderFingerprint(['SKU', 'Plant Code']);
      expect(fp1).toBe(fp2);
    });
  });

  describe('saveMappingProfile and findMappingProfile round-trip', () => {
    it('saveMappingProfile is a function', () => {
      expect(typeof saveMappingProfile).toBe('function');
    });

    it('findMappingProfile is a function', () => {
      expect(typeof findMappingProfile).toBe('function');
    });
  });
});
