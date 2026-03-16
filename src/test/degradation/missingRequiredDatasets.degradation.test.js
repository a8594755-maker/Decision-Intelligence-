/**
 * Degradation Test: Missing Required Datasets
 *
 * Verifies that when required datasets are completely absent,
 * the pipeline handles it gracefully — either errors clearly
 * or produces a minimal/empty plan with appropriate messaging.
 */
import { describe, it, expect } from 'vitest';

// ── Imports for pure function tests ───────────────────────────────────────

import { evaluateCapabilities, summarizeCapabilities } from '../../config/capabilityMatrix';
import { buildDataQualityReport } from '../../utils/dataQualityReport';
import { validateArtifactOrThrow } from '../../contracts/diArtifactContractV1';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Missing Required Datasets Degradation', () => {

  describe('evaluateCapabilities with no data', () => {
    it('all capabilities are unavailable with empty datasets', () => {
      const caps = evaluateCapabilities([]);

      expect(caps.forecast.available).toBe(false);
      expect(caps.forecast.level).toBe('unavailable');
      expect(caps.basic_plan.available).toBe(false);
      expect(caps.basic_plan.level).toBe('unavailable');
      expect(caps.inbound_aware_plan.available).toBe(false);
      expect(caps.shortage_risk.available).toBe(false);
      expect(caps.supplier_risk.available).toBe(false);
      expect(caps.profit_at_risk.available).toBe(false);
      expect(caps.multi_echelon.available).toBe(false);
    });

    it('degradation notes are provided for capabilities with them', () => {
      const caps = evaluateCapabilities([]);

      if (caps.inbound_aware_plan.degradationNote) {
        expect(typeof caps.inbound_aware_plan.degradationNote).toBe('string');
        expect(caps.inbound_aware_plan.degradationNote.length).toBeGreaterThan(0);
      }
      if (caps.profit_at_risk.degradationNote) {
        expect(typeof caps.profit_at_risk.degradationNote).toBe('string');
      }
      if (caps.multi_echelon.degradationNote) {
        expect(typeof caps.multi_echelon.degradationNote).toBe('string');
      }
    });

    it('missing datasets list is complete for each capability', () => {
      const caps = evaluateCapabilities([]);

      expect(caps.forecast.missingDatasets).toContain('demand_fg');
      expect(caps.basic_plan.missingDatasets).toContain('demand_fg');
      expect(caps.basic_plan.missingDatasets).toContain('inventory_snapshots');
      expect(caps.inbound_aware_plan.missingDatasets).toContain('po_open_lines');
      expect(caps.supplier_risk.missingDatasets).toContain('goods_receipt');
    });
  });

  describe('evaluateCapabilities with only demand', () => {
    it('forecast is available but basic_plan is unavailable', () => {
      const caps = evaluateCapabilities([
        { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
      ]);

      expect(caps.forecast.available).toBe(true);
      expect(caps.basic_plan.available).toBe(false);
      expect(caps.basic_plan.missingDatasets).toContain('inventory_snapshots');
    });
  });

  describe('summarizeCapabilities', () => {
    it('returns empty available when nothing is present', () => {
      const caps = evaluateCapabilities([]);
      const summary = summarizeCapabilities(caps);

      expect(summary.available).toHaveLength(0);
      expect(summary.partial).toHaveLength(0);
      expect(summary.unavailable.length).toBeGreaterThan(0);
    });

    it('returns correct buckets with partial data', () => {
      const caps = evaluateCapabilities([
        { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
        { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
      ]);
      const summary = summarizeCapabilities(caps);

      // basic_plan should be partial (available but missing optional datasets)
      expect(summary.partial.length).toBeGreaterThan(0);
      // profit_at_risk, multi_echelon, supplier_risk should be unavailable
      expect(summary.unavailable.length).toBeGreaterThan(0);
    });
  });

  describe('buildDataQualityReport with all missing', () => {
    it('produces minimal coverage_level', () => {
      const report = buildDataQualityReport({
        availableDatasets: [],
        missingDatasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'fg_financials', 'bom_edge'],
      });

      expect(report.coverage_level).toBe('minimal');
      expect(report.available_datasets).toHaveLength(0);
      expect(report.missing_datasets.length).toBe(5);
    });

    it('report with all missing still passes artifact contract validation', () => {
      const report = buildDataQualityReport({
        availableDatasets: [],
        missingDatasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'fg_financials', 'bom_edge'],
      });

      expect(() => {
        validateArtifactOrThrow({ artifact_type: 'data_quality_report', payload: report });
      }).not.toThrow();
    });

    it('partial coverage when 1-2 datasets missing', () => {
      const report = buildDataQualityReport({
        availableDatasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines'],
        missingDatasets: ['fg_financials', 'bom_edge'],
      });
      expect(report.coverage_level).toBe('partial');
    });

    it('full coverage when nothing missing', () => {
      const report = buildDataQualityReport({
        availableDatasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'fg_financials', 'bom_edge'],
        missingDatasets: [],
      });
      expect(report.coverage_level).toBe('full');
    });
  });
});
