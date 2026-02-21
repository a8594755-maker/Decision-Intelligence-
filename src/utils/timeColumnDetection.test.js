import { describe, expect, it } from 'vitest';
import { detectTimeColumn } from './timeColumnDetection';

describe('timeColumnDetection', () => {
  it('picks valid date column and returns 2025-2026 range for clean demand-like rows', () => {
    const columns = ['material_code', 'plant_id', 'demand_qty', 'date'];
    const rows = [
      { material_code: 'FG-1', plant_id: 'P1', demand_qty: 36526, date: '2025-12-29' },
      { material_code: 'FG-1', plant_id: 'P1', demand_qty: 36535, date: '2026-01-05' },
      { material_code: 'FG-1', plant_id: 'P1', demand_qty: 36542, date: '2026-01-12' }
    ];

    const result = detectTimeColumn({ columns, rows });

    expect(result.name).toBe('date');
    expect(result.start?.toISOString().slice(0, 10)).toBe('2025-12-29');
    expect(result.end?.toISOString().slice(0, 10)).toBe('2026-01-12');
  });

  it('does not infer unrealistic time column from non-date numeric fields', () => {
    const columns = ['material_code', 'demand_qty', 'onhand_qty'];
    const rows = [
      { material_code: 'FG-1', demand_qty: 36526, onhand_qty: 120 },
      { material_code: 'FG-2', demand_qty: 36535, onhand_qty: 140 },
      { material_code: 'FG-3', demand_qty: 36542, onhand_qty: 130 }
    ];

    const result = detectTimeColumn({ columns, rows });

    expect(result.name).toBe(null);
    expect(result.start).toBe(null);
    expect(result.end).toBe(null);
  });
});
