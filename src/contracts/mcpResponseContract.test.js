/**
 * mcpResponseContract.test.js — Tests for MCP response formatting
 */

import { describe, it, expect } from 'vitest';
import {
  formatArtifactForMCP,
  formatAllArtifactsForMCP,
  MCP_CONTENT_TYPES,
} from './mcpResponseContract.js';

describe('mcpResponseContract', () => {
  describe('formatArtifactForMCP', () => {
    it('formats forecast_series as text content', () => {
      const result = formatArtifactForMCP('forecast_series', [
        { material_code: 'MAT-001', time_bucket: '2026-04', p50: 100, p10: 80, p90: 120 },
      ]);

      expect(result.type).toBe(MCP_CONTENT_TYPES.TEXT);
      expect(result.text).toContain('Demand Forecast');
      expect(result.text).toContain('MAT-001');
    });

    it('formats plan_table with order summary', () => {
      const result = formatArtifactForMCP('plan_table', [
        { material_code: 'M1', supplier_id: 'S1', order_qty: 100, time_bucket: '2026-04' },
        { material_code: 'M2', supplier_id: 'S2', order_qty: 200, time_bucket: '2026-04' },
      ]);

      expect(result.type).toBe('text');
      expect(result.text).toContain('300'); // total qty
      expect(result.text).toContain('order lines');
    });

    it('formats risk_scores with high-risk count', () => {
      const result = formatArtifactForMCP('risk_scores', [
        { material_code: 'M1', risk_score: 0.9 },
        { material_code: 'M2', risk_score: 0.3 },
        { material_code: 'M3', risk_score: 0.8 },
      ]);

      expect(result.text).toContain('2 high-risk');
    });

    it('formats solver_meta with status and cost', () => {
      const result = formatArtifactForMCP('solver_meta', {
        status: 'optimal',
        total_cost: 125000,
        service_level: 0.97,
        solve_time_ms: 450,
      });

      expect(result.text).toContain('optimal');
      expect(result.text).toContain('125,000');
      expect(result.text).toContain('97.0%');
    });

    it('formats CSV artifacts as resource references', () => {
      const result = formatArtifactForMCP('forecast_csv', { id: 'csv-123' });

      expect(result.type).toBe(MCP_CONTENT_TYPES.RESOURCE);
      expect(result.resource.uri).toBe('di://artifacts/csv-123');
      expect(result.resource.mimeType).toBe('text/csv');
    });

    it('formats excel_workbook as resource reference', () => {
      const result = formatArtifactForMCP('excel_workbook', { id: 'xl-456' });

      expect(result.type).toBe('resource');
      expect(result.resource.mimeType).toContain('spreadsheet');
    });

    it('handles unknown artifact types with JSON fallback', () => {
      const result = formatArtifactForMCP('custom_artifact', { foo: 'bar' });

      expect(result.type).toBe('text');
      expect(result.text).toContain('Custom Artifact');
      expect(result.text).toContain('json');
    });

    it('handles null data gracefully', () => {
      const result = formatArtifactForMCP('forecast_series', null);
      expect(result.text).toContain('no data');
    });

    it('handles empty array data', () => {
      const result = formatArtifactForMCP('plan_table', []);
      expect(result.text).toContain('no data');
    });
  });

  describe('formatAllArtifactsForMCP', () => {
    it('formats multiple artifacts into content blocks', () => {
      const blocks = formatAllArtifactsForMCP({
        forecast_series: [{ material_code: 'M1', p50: 100 }],
        solver_meta: { status: 'optimal' },
      });

      expect(blocks).toHaveLength(2);
      expect(blocks.every(b => b.type)).toBe(true);
    });

    it('handles empty artifacts map', () => {
      const blocks = formatAllArtifactsForMCP({});
      expect(blocks).toHaveLength(0);
    });

    it('handles null/undefined', () => {
      expect(formatAllArtifactsForMCP(null)).toHaveLength(0);
      expect(formatAllArtifactsForMCP(undefined)).toHaveLength(0);
    });
  });
});
