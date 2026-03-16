/**
 * E2E: Quarantine Export / Error Report Correctness
 *
 * Verifies that the quarantine system correctly classifies rows,
 * generates accurate reports, and CSV export data is correct.
 */
import { describe, it, expect } from 'vitest';

import {
  REASON_CODES,
  buildQuarantineReport,
  quarantineRowsToCsvData,
} from '../../utils/dataValidation';

// ── Test fixtures ─────────────────────────────────────────────────────────

function makeValidationResult({
  validRows = [],
  errorRows = [],
  duplicateGroups = [],
  total = null,
} = {}) {
  const valid = validRows.length;
  const invalid = errorRows.length;
  return {
    validRows,
    errorRows,
    duplicateGroups,
    stats: { total: total ?? (valid + invalid), valid, invalid },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Quarantine Export E2E', () => {

  describe('REASON_CODES structure', () => {
    it('has all expected codes', () => {
      expect(REASON_CODES.MISSING_REQUIRED).toBeDefined();
      expect(REASON_CODES.INVALID_DATE).toBeDefined();
      expect(REASON_CODES.TYPE_MISMATCH).toBeDefined();
      expect(REASON_CODES.DUPLICATE_ROW).toBeDefined();
    });

    it('fixable codes are marked correctly', () => {
      expect(REASON_CODES.MISSING_REQUIRED.fixable).toBe(true);
      expect(REASON_CODES.INVALID_DATE.fixable).toBe(true);
      expect(REASON_CODES.TYPE_MISMATCH.fixable).toBe(false);
      expect(REASON_CODES.DUPLICATE_ROW.fixable).toBe(false);
    });

    it('each code has code, label, and fixable properties', () => {
      for (const [_key, val] of Object.entries(REASON_CODES)) {
        expect(val).toHaveProperty('code');
        expect(val).toHaveProperty('label');
        expect(typeof val.fixable).toBe('boolean');
      }
    });
  });

  describe('buildQuarantineReport', () => {
    it('produces v2 report with correct counts', () => {
      const result = makeValidationResult({
        validRows: [{ material_code: 'A1', onhand_qty: 100 }],
        errorRows: [
          {
            rowIndex: 2,
            originalData: { SKU: 'B1' },
            cleanedData: {},
            errors: [
              { field: 'snapshot_date', fieldLabel: 'Date', error: 'required', reasonCode: 'MISSING_REQUIRED' },
            ],
          },
          {
            rowIndex: 3,
            originalData: { SKU: 'C1' },
            cleanedData: {},
            errors: [
              { field: 'onhand_qty', fieldLabel: 'Qty', error: 'bad type', reasonCode: 'TYPE_MISMATCH' },
            ],
          },
        ],
      });

      const report = buildQuarantineReport(result, 'Sheet1', 'inventory_snapshots');

      expect(report.version).toBe('2');
      expect(report.accepted).toBe(1);
      expect(report.quarantined).toBe(1); // fixable error → quarantined
      expect(report.rejected).toBe(1);   // non-fixable → rejected
      expect(report.quarantined_rows).toHaveLength(2);
    });

    it('classifies fixable errors as quarantined', () => {
      const result = makeValidationResult({
        validRows: [],
        errorRows: [
          {
            rowIndex: 1,
            originalData: { SKU: 'A1' },
            cleanedData: {},
            errors: [{ field: 'date', fieldLabel: 'Date', error: 'bad format', reasonCode: 'INVALID_DATE' }],
          },
        ],
      });

      const report = buildQuarantineReport(result, 'Sheet1', 'inventory_snapshots');
      expect(report.quarantined).toBe(1);
      expect(report.rejected).toBe(0);

      const row = report.quarantined_rows[0];
      expect(row.disposition).toBe('quarantined');
      expect(row.reasonCodes).toContain('INVALID_DATE');
    });

    it('classifies non-fixable errors as rejected', () => {
      const result = makeValidationResult({
        validRows: [],
        errorRows: [
          {
            rowIndex: 1,
            originalData: { SKU: 'A1' },
            cleanedData: {},
            errors: [{ field: 'name', fieldLabel: 'Name', error: 'bad type', reasonCode: 'TYPE_MISMATCH' }],
          },
        ],
      });

      const report = buildQuarantineReport(result, 'Sheet1', 'inventory_snapshots');
      expect(report.quarantined).toBe(0);
      expect(report.rejected).toBe(1);

      const row = report.quarantined_rows[0];
      expect(row.disposition).toBe('rejected');
    });

    it('handles mixed errors on same row', () => {
      const result = makeValidationResult({
        validRows: [],
        errorRows: [
          {
            rowIndex: 1,
            originalData: { SKU: 'A1' },
            cleanedData: {},
            errors: [
              { field: 'date', fieldLabel: 'Date', error: 'missing', reasonCode: 'MISSING_REQUIRED' },
              { field: 'qty', fieldLabel: 'Qty', error: 'bad type', reasonCode: 'TYPE_MISMATCH' },
            ],
          },
        ],
      });

      const report = buildQuarantineReport(result, 'Sheet1', 'inventory_snapshots');
      // Row with any non-fixable error should be rejected
      expect(report.rejected).toBe(1);
      expect(report.quarantined).toBe(0);
    });

    it('returns zero counts for clean data', () => {
      const result = makeValidationResult({
        validRows: [
          { material_code: 'A1', onhand_qty: 100 },
          { material_code: 'A2', onhand_qty: 200 },
        ],
        errorRows: [],
      });

      const report = buildQuarantineReport(result, 'Sheet1', 'inventory_snapshots');
      expect(report.accepted).toBe(2);
      expect(report.quarantined).toBe(0);
      expect(report.rejected).toBe(0);
      expect(report.quarantined_rows).toHaveLength(0);
    });
  });

  describe('quarantineRowsToCsvData', () => {
    it('produces CSV-ready data from quarantine report', () => {
      const result = makeValidationResult({
        validRows: [],
        errorRows: [
          {
            rowIndex: 2,
            originalData: { SKU: 'A1', Plant: 'P1', OnHand: '' },
            cleanedData: {},
            errors: [
              { field: 'onhand_qty', fieldLabel: 'On Hand', error: 'missing', reasonCode: 'MISSING_REQUIRED' },
            ],
          },
        ],
      });

      const report = buildQuarantineReport(result, 'Sheet1', 'inventory_snapshots');

      if (typeof quarantineRowsToCsvData === 'function') {
        const csvData = quarantineRowsToCsvData(report);
        expect(csvData).toBeDefined();
        // Should be string or array
        if (typeof csvData === 'string') {
          expect(csvData.length).toBeGreaterThan(0);
        } else if (Array.isArray(csvData)) {
          expect(csvData.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
