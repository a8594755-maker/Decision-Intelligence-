// @product: ai-employee
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabaseClient', () => ({ supabase: null }));
vi.mock('../utils/artifactStore', () => ({
  saveJsonArtifact: vi.fn(() => ({ id: 'art-1', artifact_type: 'powerbi_dataset' })),
}));

import { toPowerBIDataset, toExcelWithRefresh } from './externalToolBridgeService';

const mockArtifacts = {
  plan: [
    {
      artifact_type: 'plan_table',
      payload: {
        rows: [
          { sku: 'A', plant_id: 'P1', order_qty: 100, order_date: '2026-04-01' },
          { sku: 'B', plant_id: 'P2', order_qty: 200, order_date: '2026-04-02' },
        ],
      },
    },
  ],
  forecast: [
    {
      artifact_type: 'forecast_series',
      payload: {
        rows: [
          { sku: 'A', forecast: 150, date: '2026-04-01' },
        ],
      },
    },
  ],
};

// ── toPowerBIDataset ────────────────────────────────────────────────────────

describe('toPowerBIDataset', () => {
  it('converts artifacts to Power BI dataset structure', () => {
    const result = toPowerBIDataset(mockArtifacts);

    expect(result.dataset).toBeTruthy();
    expect(result.dataset.version).toBe('1.0');
    expect(result.dataset.tables).toBeInstanceOf(Array);
    expect(result.dataset.tables.length).toBe(2);
    expect(result.filename).toContain('powerbi_dataset');
  });

  it('creates correct table structure', () => {
    const result = toPowerBIDataset(mockArtifacts);
    const planTable = result.dataset.tables.find(t => t.name === 'plan_table');

    expect(planTable).toBeTruthy();
    expect(planTable.columns).toBeInstanceOf(Array);
    expect(planTable.rows).toHaveLength(2);
    expect(planTable.columns.some(c => c.name === 'sku')).toBe(true);
  });

  it('infers data types correctly', () => {
    const result = toPowerBIDataset(mockArtifacts);
    const planTable = result.dataset.tables.find(t => t.name === 'plan_table');
    const columns = Object.fromEntries(planTable.columns.map(c => [c.name, c.dataType]));

    expect(columns.sku).toBe('string');
    expect(columns.order_qty).toBe('int64');
    expect(columns.order_date).toBe('dateTime');
  });

  it('handles empty artifacts', () => {
    const result = toPowerBIDataset({});

    expect(result.dataset.tables).toEqual([]);
  });

  it('handles null artifacts', () => {
    const result = toPowerBIDataset(null);

    expect(result.dataset.tables).toEqual([]);
  });
});

// ── toExcelWithRefresh ──────────────────────────────────────────────────────

describe('toExcelWithRefresh', () => {
  it('creates sheets from artifacts', () => {
    const result = toExcelWithRefresh(mockArtifacts);

    expect(result.sheets).toBeInstanceOf(Array);
    expect(result.sheets.length).toBe(2);
    expect(result.metadata.total_sheets).toBe(2);
  });

  it('includes refresh metadata', () => {
    const result = toExcelWithRefresh(mockArtifacts);

    expect(result.metadata.source).toBe('di_ai_employee');
    expect(result.metadata.generated_at).toBeTruthy();
    expect(result.metadata.refresh_hint).toBeTruthy();
  });

  it('caps sheet name to 31 chars', () => {
    const longNameArtifacts = {
      very_long_artifact_type_name_that_exceeds_limit: [
        { artifact_type: 'very_long_artifact_type_name_that_exceeds_limit', payload: { rows: [{ a: 1 }] } },
      ],
    };

    const result = toExcelWithRefresh(longNameArtifacts);
    expect(result.sheets[0].name.length).toBeLessThanOrEqual(31);
  });

  it('handles empty artifacts', () => {
    const result = toExcelWithRefresh({});

    expect(result.sheets).toEqual([]);
    expect(result.metadata.total_rows).toBe(0);
  });
});
