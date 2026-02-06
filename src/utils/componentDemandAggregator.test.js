/**
 * componentDemandAggregator 單元測試
 * 驗證：依 (material_code, plant_id) 彙總 demand_qty，並轉為日均需求；
 * 支援從 run 參數 timeBuckets 或 horizonBuckets 推導 horizon，fallback 從 rows 推導。
 */

import { aggregateComponentDemandToDaily, normalizeKey, DAYS_PER_BUCKET } from './componentDemandAggregator.js';

describe('normalizeKey', () => {
  it('trim + upper', () => {
    expect(normalizeKey('  ab  ', '  xy  ')).toBe('AB|XY');
  });
});

describe('aggregateComponentDemandToDaily', () => {
  it('空陣列回傳空物件', () => {
    expect(aggregateComponentDemandToDaily([], 3)).toEqual({});
  });

  it('單一 (material, plant) 多 bucket 加總後除以 horizon 天數', () => {
    const rows = [
      { material_code: 'COMP-A', plant_id: 'P1', time_bucket: '2026-W06', demand_qty: 70 },
      { material_code: 'COMP-A', plant_id: 'P1', time_bucket: '2026-W07', demand_qty: 70 },
      { material_code: 'COMP-A', plant_id: 'P1', time_bucket: '2026-W08', demand_qty: 70 }
    ];
    const result = aggregateComponentDemandToDaily(rows, 3);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['COMP-A|P1'].totalQty).toBe(210);
    expect(result['COMP-A|P1'].bucketCount).toBe(3);
    expect(result['COMP-A|P1'].horizonDays).toBe(21);
    expect(result['COMP-A|P1'].dailyDemand).toBe(10);
  });

  it('多個 (material, plant) 分別彙總', () => {
    const rows = [
      { material_code: 'A', plant_id: 'P1', time_bucket: '2026-W06', demand_qty: 21 },
      { material_code: 'B', plant_id: 'P1', time_bucket: '2026-W06', demand_qty: 14 }
    ];
    const result = aggregateComponentDemandToDaily(rows, 3);
    expect(result['A|P1'].totalQty).toBe(21);
    expect(result['A|P1'].dailyDemand).toBe(1);
    expect(result['B|P1'].totalQty).toBe(14);
    expect(result['B|P1'].dailyDemand).toBeCloseTo(14 / 21, 5);
  });

  it('料號/工廠會正規化為大寫', () => {
    const rows = [
      { material_code: '  comp-x  ', plant_id: '  p2  ', time_bucket: '2026-W06', demand_qty: 42 }
    ];
    const result = aggregateComponentDemandToDaily(rows, 3);
    expect(result['COMP-X|P2']).toBeDefined();
    expect(result['COMP-X|P2'].totalQty).toBe(42);
  });

  // A1: 從 run 參數 timeBuckets 推導 horizon，dailyDemand 等比變化
  it('options.timeBuckets 決定 horizon 長度（run 參數推導）', () => {
    const rows = [
      { material_code: 'X', plant_id: 'P1', time_bucket: '2026-W06', demand_qty: 70 },
      { material_code: 'X', plant_id: 'P1', time_bucket: '2026-W07', demand_qty: 70 }
    ];
    const result = aggregateComponentDemandToDaily(rows, undefined, {
      timeBuckets: ['2026-W06', '2026-W07']
    });
    expect(result['X|P1'].totalQty).toBe(140);
    expect(result['X|P1'].horizonDays).toBe(14); // 2 * 7
    expect(result['X|P1'].dailyDemand).toBe(10); // 140/14
  });

  it('不同 horizonBuckets 導致 dailyDemand 等比變化', () => {
    const rows = [
      { material_code: 'Y', plant_id: 'P1', time_bucket: '2026-W06', demand_qty: 210 }
    ];
    const r3 = aggregateComponentDemandToDaily(rows, 3);
    const r6 = aggregateComponentDemandToDaily(rows, 6);
    expect(r3['Y|P1'].dailyDemand).toBe(10); // 210/21
    expect(r6['Y|P1'].dailyDemand).toBe(5);  // 210/42
  });

  it('缺 timeBuckets 時從 rows 的 unique time_bucket 數 fallback', () => {
    const rows = [
      { material_code: 'Z', plant_id: 'P1', time_bucket: '2026-W10', demand_qty: 28 }
    ];
    const result = aggregateComponentDemandToDaily(rows, 0, {});
    expect(result['Z|P1'].bucketCount).toBe(1);
    expect(result['Z|P1'].horizonDays).toBe(7); // 1 * 7
    expect(result['Z|P1'].dailyDemand).toBe(4); // 28/7
  });
});
