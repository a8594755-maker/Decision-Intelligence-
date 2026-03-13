// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabaseClient', () => ({ supabase: null }));
vi.mock('../utils/artifactStore', () => ({
  saveJsonArtifact: vi.fn(() => ({ id: 'art-1', artifact_type: 'report_html' })),
  saveCsvArtifact: vi.fn(),
}));

import { generateReport } from './reportGeneratorService';

describe('reportGeneratorService', () => {
  const mockArtifacts = {
    forecast: [
      { artifact_type: 'forecast_series', id: 'fs-1', payload: { groups: [] } },
    ],
    plan: [
      { artifact_type: 'plan_table', id: 'pt-1', payload: { rows: [{ sku: 'A', qty: 10 }], total_rows: 1 } },
    ],
  };

  const mockMeta = { id: 'task-1', title: 'Test Report' };

  // ── HTML ──────────────────────────────────────────────────────────────────

  describe('HTML format', () => {
    it('generates valid HTML', async () => {
      const result = await generateReport({
        format: 'html',
        artifacts: mockArtifacts,
        taskMeta: mockMeta,
      });

      expect(result.format).toBe('html');
      expect(result.filename).toContain('report_task-1');
      expect(result.blob).toContain('<!DOCTYPE html>');
      expect(result.blob).toContain('Test Report');
    });

    it('includes narrative section', async () => {
      const result = await generateReport({
        format: 'html',
        artifacts: mockArtifacts,
        taskMeta: mockMeta,
        narrative: 'The forecast shows growth.',
      });

      expect(result.blob).toContain('The forecast shows growth.');
    });

    it('includes revision log section', async () => {
      const result = await generateReport({
        format: 'html',
        artifacts: mockArtifacts,
        taskMeta: mockMeta,
        revisionLog: {
          total_rounds: 2,
          final_score: 85,
          rounds: [
            { score: 55, feedback: 'Needs improvement' },
            { score: 85, feedback: 'Good' },
          ],
        },
      });

      expect(result.blob).toContain('Revision History');
      expect(result.blob).toContain('Total rounds: 2');
      expect(result.blob).toContain('Needs improvement');
    });

    it('includes artifact list', async () => {
      const result = await generateReport({
        format: 'html',
        artifacts: mockArtifacts,
        taskMeta: mockMeta,
      });

      expect(result.blob).toContain('Artifacts (2)');
      expect(result.blob).toContain('forecast_series');
    });
  });

  // ── XLSX ──────────────────────────────────────────────────────────────────

  describe('XLSX format', () => {
    it('returns xlsx data structure', async () => {
      const result = await generateReport({
        format: 'xlsx',
        artifacts: mockArtifacts,
        taskMeta: mockMeta,
      });

      expect(result.format).toBe('xlsx');
      expect(result.filename).toContain('.xlsx');
      expect(result.blob).toHaveProperty('artifacts');
      expect(result.blob.generated_at).toBeTruthy();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty artifacts', async () => {
      const result = await generateReport({
        format: 'html',
        artifacts: {},
        taskMeta: mockMeta,
      });

      expect(result.format).toBe('html');
      expect(result.blob).toContain('<!DOCTYPE html>');
    });

    it('handles null artifacts', async () => {
      const result = await generateReport({
        format: 'html',
        artifacts: null,
        taskMeta: mockMeta,
      });

      expect(result.format).toBe('html');
    });

    it('defaults to html format', async () => {
      const result = await generateReport({
        artifacts: mockArtifacts,
        taskMeta: mockMeta,
      });

      expect(result.format).toBe('html');
    });

    it('throws on unsupported format', async () => {
      await expect(generateReport({
        format: 'pdf',
        artifacts: mockArtifacts,
      })).rejects.toThrow('Unsupported report format');
    });
  });
});
