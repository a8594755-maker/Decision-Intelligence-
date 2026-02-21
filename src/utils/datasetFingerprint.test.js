import { buildDatasetFingerprint, buildSheetsPayload } from './datasetFingerprint';

describe('datasetFingerprint', () => {
  test('buildSheetsPayload limits sample rows to 25', () => {
    const rows = Array.from({ length: 40 }, (_, idx) => ({
      Material: `M-${idx + 1}`,
      Qty: idx + 1
    }));

    const payload = buildSheetsPayload([
      { sheet_name: 'Demand', columns: ['Material', 'Qty'], rows }
    ]);

    expect(payload).toHaveLength(1);
    expect(payload[0].sample_rows).toHaveLength(25);
    expect(payload[0].row_count_estimate).toBe(40);
  });

  test('fingerprint is deterministic for same sheet shape', () => {
    const baseInput = {
      sheets: [
        {
          sheet_name: 'Demand FG',
          columns: ['Material Code', 'Time Bucket', 'Demand Qty'],
          inferred_type: 'demand_fg',
          time_column_guess: 'Time Bucket',
          time_granularity_guess: 'week'
        }
      ]
    };

    const fp1 = buildDatasetFingerprint(baseInput);
    const fp2 = buildDatasetFingerprint(baseInput);

    expect(fp1).toBe(fp2);
  });

  test('fingerprint changes when schema shape changes', () => {
    const fp1 = buildDatasetFingerprint({
      sheets: [
        {
          sheet_name: 'Inventory',
          columns: ['Material Code', 'Plant', 'Onhand Qty'],
          inferred_type: 'inventory_snapshots',
          time_column_guess: '',
          time_granularity_guess: 'unknown'
        }
      ]
    });

    const fp2 = buildDatasetFingerprint({
      sheets: [
        {
          sheet_name: 'Inventory',
          columns: ['Material Code', 'Plant', 'Onhand Qty', 'Safety Stock'],
          inferred_type: 'inventory_snapshots',
          time_column_guess: '',
          time_granularity_guess: 'unknown'
        }
      ]
    });

    expect(fp1).not.toBe(fp2);
  });
});

