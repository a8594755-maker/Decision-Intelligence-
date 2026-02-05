/**
 * Forecast Domain - BOM Calculator Tests
 * BOM 計算器單元測試
 * 
 * 測試所有核心計算函數的正確性
 */

import {
  roundTo,
  getAggregationKey,
  parseAggregationKey,
  timeBucketToDate,
  calculateComponentRequirement,
  aggregateByComponent,
  buildBomIndex,
  explodeBOM,
  DEFAULTS,
  ERROR_MESSAGES
} from './bomCalculator.js';

// ============================================
// 工具函數測試
// ============================================

describe('Utility Functions', () => {
  describe('roundTo', () => {
    test('應該正確四捨五入到指定小數位數', () => {
      expect(roundTo(123.456789, 2)).toBe(123.46);
      expect(roundTo(123.456789, 4)).toBe(123.4568);
      expect(roundTo(123.456789, 0)).toBe(123);
    });
    
    test('預設應該四捨五入到 4 位小數', () => {
      expect(roundTo(123.456789)).toBe(123.4568);
    });
    
    test('應該拋出錯誤：非數字輸入', () => {
      expect(() => roundTo('abc')).toThrow();
      expect(() => roundTo(NaN)).toThrow();
      expect(() => roundTo(undefined)).toThrow();
    });
    
    test('應該正確處理零和負數', () => {
      expect(roundTo(0)).toBe(0);
      expect(roundTo(-123.456789, 2)).toBe(-123.46);
    });
  });
  
  describe('getAggregationKey & parseAggregationKey', () => {
    test('應該正確生成和解析聚合 key', () => {
      const key = getAggregationKey('P001', '2026-W01', 'COMP-A');
      expect(key).toBe('P001|2026-W01|COMP-A');
      
      const parsed = parseAggregationKey(key);
      expect(parsed).toEqual({
        plantId: 'P001',
        timeBucket: '2026-W01',
        materialCode: 'COMP-A'
      });
    });
    
    test('應該拋出錯誤：缺少必要欄位', () => {
      expect(() => getAggregationKey('', '2026-W01', 'COMP-A')).toThrow();
      expect(() => getAggregationKey('P001', '', 'COMP-A')).toThrow();
      expect(() => getAggregationKey('P001', '2026-W01', '')).toThrow();
      expect(() => getAggregationKey(null, '2026-W01', 'COMP-A')).toThrow();
    });
  });
  
  describe('timeBucketToDate', () => {
    test('應該正確解析 YYYY-MM-DD 格式', () => {
      const date = timeBucketToDate('2026-02-15');
      expect(date).toBeInstanceOf(Date);
      expect(date.getFullYear()).toBe(2026);
      expect(date.getMonth()).toBe(1); // 0-indexed, 1 = February
      // 由於時區問題，只檢查日期是否在合理範圍內
      expect(date.getDate()).toBeGreaterThanOrEqual(14);
      expect(date.getDate()).toBeLessThanOrEqual(15);
    });
    
    test('應該正確解析 YYYY-W## 格式', () => {
      const date = timeBucketToDate('2026-W01');
      expect(date).toBeInstanceOf(Date);
      expect(date.getFullYear()).toBe(2025); // W01 可能在前一年
    });
    
    test('無法解析的格式應該返回 null', () => {
      expect(timeBucketToDate('invalid')).toBeNull();
      expect(timeBucketToDate(null)).toBeNull();
      expect(timeBucketToDate('')).toBeNull();
    });
  });
});

// ============================================
// 核心計算函數測試
// ============================================

describe('Core Calculation Functions', () => {
  describe('calculateComponentRequirement', () => {
    test('基本計算：無報廢無良率損失', () => {
      // 100 個父件，每個需要 2 個子件
      const result = calculateComponentRequirement(100, 2, 0, 1);
      expect(result).toBe(200);
    });
    
    test('考慮報廢率：5% 報廢', () => {
      // 100 個父件，每個需要 2 個子件，5% 報廢
      // = 100 × 2 × (1 + 0.05) / 1 = 210
      const result = calculateComponentRequirement(100, 2, 0.05, 1);
      expect(result).toBe(210);
    });
    
    test('考慮良率：95% 良率', () => {
      // 100 個父件，每個需要 2 個子件，95% 良率
      // = 100 × 2 × 1 / 0.95 = 210.5263
      const result = calculateComponentRequirement(100, 2, 0, 0.95);
      expect(result).toBe(210.5263);
    });
    
    test('同時考慮報廢率和良率', () => {
      // 100 個父件，每個需要 2 個子件，5% 報廢，95% 良率
      // = 100 × 2 × (1 + 0.05) / 0.95 = 221.0526
      const result = calculateComponentRequirement(100, 2, 0.05, 0.95);
      expect(result).toBe(221.0526);
    });
    
    // ========== 邊界案例測試 ==========
    
    test('Edge Case: qtyPer 為 0 應該返回 0', () => {
      const result = calculateComponentRequirement(100, 0, 0, 1);
      expect(result).toBe(0);
    });
    
    test('Edge Case: parentQty 為 0 應該返回 0', () => {
      const result = calculateComponentRequirement(0, 2, 0.05, 0.95);
      expect(result).toBe(0);
    });
    
    test('Edge Case: parentQty 為 null/undefined 應該返回 0', () => {
      expect(calculateComponentRequirement(null, 2)).toBe(0);
      expect(calculateComponentRequirement(undefined, 2)).toBe(0);
    });
    
    test('Edge Case: 報廢率為 0（預設值）', () => {
      const result = calculateComponentRequirement(100, 2);
      expect(result).toBe(200);
    });
    
    test('Edge Case: 接近極限報廢率 0.98 應該正常計算', () => {
      const result = calculateComponentRequirement(100, 2, 0.98, 1);
      expect(result).toBe(396); // 100 * 2 * 1.98
    });
    
    test('Edge Case: 極小良率 0.01 應該正常計算', () => {
      const result = calculateComponentRequirement(100, 2, 0, 0.01);
      expect(result).toBe(20000); // 100 * 2 / 0.01
    });
    
    // ========== 錯誤案例測試 ==========
    
    test('應該拋出錯誤：負數父件數量', () => {
      expect(() => calculateComponentRequirement(-100, 2)).toThrow();
    });
    
    test('應該拋出錯誤：負數 qtyPer', () => {
      expect(() => calculateComponentRequirement(100, -2)).toThrow();
    });
    
    test('應該拋出錯誤：報廢率 >= 1（防止除以零）', () => {
      expect(() => calculateComponentRequirement(100, 2, 1)).toThrow();
      expect(() => calculateComponentRequirement(100, 2, 1.5)).toThrow();
    });
    
    test('應該拋出錯誤：負數報廢率', () => {
      expect(() => calculateComponentRequirement(100, 2, -0.1)).toThrow();
    });
    
    test('應該拋出錯誤：良率 <= 0（防止除以零）', () => {
      expect(() => calculateComponentRequirement(100, 2, 0, 0)).toThrow();
      expect(() => calculateComponentRequirement(100, 2, 0, -0.5)).toThrow();
    });
    
    test('應該拋出錯誤：良率 > 1', () => {
      expect(() => calculateComponentRequirement(100, 2, 0, 1.5)).toThrow();
    });
    
    test('應該拋出錯誤：非數字輸入', () => {
      expect(() => calculateComponentRequirement('100', 2)).toThrow();
      expect(() => calculateComponentRequirement(100, '2')).toThrow();
      expect(() => calculateComponentRequirement(NaN, 2)).toThrow();
    });
  });
  
  describe('aggregateByComponent', () => {
    test('應該正確彙總相同零件的需求', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 50 },
        { material_code: 'COMP-B', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 200 }
      ];
      
      const result = aggregateByComponent(components);
      
      expect(result.get('P001|2026-W01|COMP-A')).toBe(150);
      expect(result.get('P001|2026-W01|COMP-B')).toBe(200);
      expect(result.size).toBe(2);
    });
    
    test('應該區分不同工廠的相同零件', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
        { material_code: 'COMP-A', plant_id: 'P002', time_bucket: '2026-W01', demand_qty: 50 }
      ];
      
      const result = aggregateByComponent(components);
      
      expect(result.get('P001|2026-W01|COMP-A')).toBe(100);
      expect(result.get('P002|2026-W01|COMP-A')).toBe(50);
      expect(result.size).toBe(2);
    });
    
    test('空陣列應該返回空 Map', () => {
      const result = aggregateByComponent([]);
      expect(result.size).toBe(0);
    });
    
    // ========== 邊界案例測試 ==========
    
    test('Edge Case: demand_qty 為 0 應該正常處理', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 0 }
      ];
      
      const result = aggregateByComponent(components);
      expect(result.get('P001|2026-W01|COMP-A')).toBe(0);
    });
    
    test('Edge Case: 缺少必要欄位應該跳過', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
        { material_code: 'COMP-B', plant_id: null, time_bucket: '2026-W01', demand_qty: 50 }, // 缺少 plant_id
        { material_code: 'COMP-C', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 200 }
      ];
      
      const result = aggregateByComponent(components);
      
      expect(result.size).toBe(2); // 只有 COMP-A 和 COMP-C
      expect(result.get('P001|2026-W01|COMP-A')).toBe(100);
      expect(result.get('P001|2026-W01|COMP-C')).toBe(200);
    });
    
    test('Edge Case: 缺少必要欄位應該記錄到 errors 陣列', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
        { material_code: 'COMP-B', plant_id: null, time_bucket: '2026-W01', demand_qty: 50 }, // 缺少 plant_id
        { material_code: null, plant_id: 'P001', time_bucket: null, demand_qty: 30 } // 缺少多個欄位
      ];
      
      const errors = [];
      const result = aggregateByComponent(components, errors);
      
      // 結果應該只有 1 筆有效資料
      expect(result.size).toBe(1);
      expect(result.get('P001|2026-W01|COMP-A')).toBe(100);
      
      // 應該有 2 筆錯誤記錄
      expect(errors.length).toBe(2);
      
      // 驗證第一筆錯誤（缺少 plant_id）
      expect(errors[0].type).toBe('VALIDATION_WARNING');
      expect(errors[0].severity).toBe('low');
      expect(errors[0].message).toContain('plant_id');
      expect(errors[0].material).toBe('COMP-B');
      expect(errors[0].missing_fields).toEqual(['plant_id']);
      
      // 驗證第二筆錯誤（缺少多個欄位）
      expect(errors[1].type).toBe('VALIDATION_WARNING');
      expect(errors[1].severity).toBe('low');
      expect(errors[1].missing_fields).toContain('material_code');
      expect(errors[1].missing_fields).toContain('time_bucket');
    });
    
    test('Edge Case: 非法數量應該跳過', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
        { material_code: 'COMP-B', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 'invalid' },
        { material_code: 'COMP-C', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: NaN }
      ];
      
      const result = aggregateByComponent(components);
      
      expect(result.size).toBe(1); // 只有 COMP-A
      expect(result.get('P001|2026-W01|COMP-A')).toBe(100);
    });
    
    test('Edge Case: 非法數量應該記錄到 errors 陣列', () => {
      const components = [
        { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
        { material_code: 'COMP-B', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 'invalid' },
        { material_code: 'COMP-C', plant_id: 'P001', time_bucket: '2026-W02', demand_qty: -50 }, // 負數
        { material_code: 'COMP-D', plant_id: 'P001', time_bucket: '2026-W03', demand_qty: NaN }
      ];
      
      const errors = [];
      const result = aggregateByComponent(components, errors);
      
      // 結果應該只有 1 筆有效資料
      expect(result.size).toBe(1);
      expect(result.get('P001|2026-W01|COMP-A')).toBe(100);
      
      // 應該有 3 筆錯誤記錄
      expect(errors.length).toBe(3);
      
      // 驗證所有錯誤都是 VALIDATION_WARNING
      errors.forEach(error => {
        expect(error.type).toBe('VALIDATION_WARNING');
        expect(error.severity).toBe('medium');
        expect(error.message).toContain('Invalid demand_qty');
      });
      
      // 驗證具體錯誤資訊
      expect(errors[0].material).toBe('COMP-B');
      expect(errors[0].provided_value).toBe('invalid');
      
      expect(errors[1].material).toBe('COMP-C');
      expect(errors[1].provided_value).toBe(-50);
      
      expect(errors[2].material).toBe('COMP-D');
      expect(isNaN(errors[2].provided_value)).toBe(true);
    });
    
    // ========== 錯誤案例測試 ==========
    
    test('應該拋出錯誤：輸入不是陣列', () => {
      expect(() => aggregateByComponent('not an array')).toThrow();
      expect(() => aggregateByComponent(null)).toThrow();
      expect(() => aggregateByComponent({})).toThrow();
    });
  });
  
  describe('buildBomIndex', () => {
    test('應該正確建立 BOM 索引', () => {
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 },
        { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1 },
        { parent_material: 'COMP-A', child_material: 'RAW-X', qty_per: 3 }
      ];
      
      const index = buildBomIndex(bomEdges, 'P001', new Date('2026-02-01'), []);
      
      expect(index.has('FG-001')).toBe(true);
      expect(index.get('FG-001').length).toBe(2);
      expect(index.has('COMP-A')).toBe(true);
      expect(index.get('COMP-A').length).toBe(1);
    });
    
    test('應該過濾不匹配的工廠', () => {
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2, plant_id: 'P001' },
        { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1, plant_id: 'P002' }
      ];
      
      const index = buildBomIndex(bomEdges, 'P001', new Date('2026-02-01'), []);
      
      expect(index.get('FG-001').length).toBe(1);
      expect(index.get('FG-001')[0].child_material).toBe('COMP-A');
    });
    
    test('應該保留通用 BOM（plant_id = null）', () => {
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2, plant_id: null },
        { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1, plant_id: 'P002' }
      ];
      
      const index = buildBomIndex(bomEdges, 'P001', new Date('2026-02-01'), []);
      
      expect(index.get('FG-001').length).toBe(1);
      expect(index.get('FG-001')[0].child_material).toBe('COMP-A');
    });
    
    test('應該過濾尚未生效的 BOM', () => {
      const bomEdges = [
        { 
          parent_material: 'FG-001', 
          child_material: 'COMP-A', 
          qty_per: 2, 
          valid_from: '2026-03-01' // 3 月才生效
        }
      ];
      
      const index = buildBomIndex(bomEdges, 'P001', new Date('2026-02-01'), []);
      
      expect(index.has('FG-001')).toBe(false);
    });
    
    test('應該過濾已失效的 BOM', () => {
      const bomEdges = [
        { 
          parent_material: 'FG-001', 
          child_material: 'COMP-A', 
          qty_per: 2, 
          valid_to: '2026-01-31' // 1 月底失效
        }
      ];
      
      const index = buildBomIndex(bomEdges, 'P001', new Date('2026-02-01'), []);
      
      expect(index.has('FG-001')).toBe(false);
    });
  });
  
  describe('buildBomIndex', () => {
    // ========== 錯誤案例測試 ==========
    
    test('應該拋出錯誤：bomEdges 不是陣列', () => {
      expect(() => buildBomIndex('not an array', 'P001', new Date(), [])).toThrow();
      expect(() => buildBomIndex(null, 'P001', new Date(), [])).toThrow();
    });
    
    test('應該拋出錯誤：缺少 plantId', () => {
      expect(() => buildBomIndex([], '', new Date(), [])).toThrow();
      expect(() => buildBomIndex([], null, new Date(), [])).toThrow();
    });
    
    test('Edge Case: 空 BOM 陣列應該返回空 Map', () => {
      const result = buildBomIndex([], 'P001', new Date(), []);
      expect(result.size).toBe(0);
    });
  });
  
  describe('explodeBOM', () => {
    test('單層 BOM 展開', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 },
        { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1 }
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      expect(result.errors.length).toBe(0);
      expect(result.componentDemandRows.length).toBe(2);
      
      const compA = result.componentDemandRows.find(r => r.material_code === 'COMP-A');
      const compB = result.componentDemandRows.find(r => r.material_code === 'COMP-B');
      
      expect(compA.demand_qty).toBe(200); // 100 × 2
      expect(compB.demand_qty).toBe(100); // 100 × 1
      
      // 檢查追溯記錄
      expect(result.traceRows.length).toBe(2);
      expect(result.traceRows[0].bom_level).toBe(1);
      expect(result.traceRows[0].path).toEqual(['FG-001', 'COMP-A']);
    });
    
    test('多層 BOM 展開', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'SA-01', qty_per: 1 },
        { parent_material: 'SA-01', child_material: 'COMP-A', qty_per: 2 },
        { parent_material: 'SA-01', child_material: 'COMP-B', qty_per: 3 }
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      expect(result.errors.length).toBe(0);
      expect(result.componentDemandRows.length).toBe(3); // SA-01, COMP-A, COMP-B
      
      const sa01 = result.componentDemandRows.find(r => r.material_code === 'SA-01');
      const compA = result.componentDemandRows.find(r => r.material_code === 'COMP-A');
      const compB = result.componentDemandRows.find(r => r.material_code === 'COMP-B');
      
      expect(sa01.demand_qty).toBe(100); // 100 × 1
      expect(compA.demand_qty).toBe(200); // 100 × 1 × 2
      expect(compB.demand_qty).toBe(300); // 100 × 1 × 3
      
      // 檢查追溯記錄的層級
      const traceCompA = result.traceRows.find(t => t.component_material_code === 'COMP-A');
      expect(traceCompA.bom_level).toBe(2);
      expect(traceCompA.path).toEqual(['FG-001', 'SA-01', 'COMP-A']);
    });
    
    test('彙總重複零件需求', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'SA-01', qty_per: 1 },
        { parent_material: 'FG-001', child_material: 'SA-02', qty_per: 1 },
        { parent_material: 'SA-01', child_material: 'COMP-A', qty_per: 2 },
        { parent_material: 'SA-02', child_material: 'COMP-A', qty_per: 3 } // 同樣的 COMP-A
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      const compA = result.componentDemandRows.find(r => r.material_code === 'COMP-A');
      expect(compA.demand_qty).toBe(500); // (100 × 2) + (100 × 3) = 500
      
      // 應該有兩筆追溯記錄（兩條不同路徑）
      const tracesCompA = result.traceRows.filter(t => t.component_material_code === 'COMP-A');
      expect(tracesCompA.length).toBe(2);
    });
    
    test('檢測循環引用', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 1 },
        { parent_material: 'COMP-A', child_material: 'COMP-B', qty_per: 1 },
        { parent_material: 'COMP-B', child_material: 'COMP-A', qty_per: 1 } // 循環！
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      const cycleError = result.errors.find(e => e.type === 'BOM_CYCLE');
      expect(cycleError).toBeDefined();
      expect(cycleError.message).toContain('Circular BOM');
    });
    
    test('檢測最大深度', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      // 建立深度 = 6 的 BOM（會超過 maxDepth=5）
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'L1', qty_per: 1 },
        { parent_material: 'L1', child_material: 'L2', qty_per: 1 },
        { parent_material: 'L2', child_material: 'L3', qty_per: 1 },
        { parent_material: 'L3', child_material: 'L4', qty_per: 1 },
        { parent_material: 'L4', child_material: 'L5', qty_per: 1 },
        { parent_material: 'L5', child_material: 'L6', qty_per: 1 }
      ];
      
      const result = explodeBOM(fgDemands, bomEdges, { maxDepth: 5 });
      
      const depthError = result.errors.find(e => e.type === 'MAX_DEPTH_EXCEEDED');
      expect(depthError).toBeDefined();
    });
    
    test('考慮報廢率和良率', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { 
          parent_material: 'FG-001', 
          child_material: 'COMP-A', 
          qty_per: 2,
          scrap_rate: 0.05, // 5% 報廢
          yield_rate: 0.95  // 95% 良率
        }
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      const compA = result.componentDemandRows.find(r => r.material_code === 'COMP-A');
      // 100 × 2 × (1 + 0.05) / 0.95 = 221.0526
      expect(compA.demand_qty).toBe(221.0526);
    });
    
    test('無 FG 需求應該返回錯誤', () => {
      const result = explodeBOM([], []);
      
      expect(result.componentDemandRows.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('NO_INPUT');
    });
    
    test('無 BOM 資料應該返回錯誤', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const result = explodeBOM(fgDemands, []);
      
      expect(result.componentDemandRows.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('NO_BOM');
    });
    
    test('找不到 BOM 定義應該記錄錯誤', () => {
      const fgDemands = [
        { 
          material_code: 'FG-999', // 不存在的 FG
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 }
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      expect(result.componentDemandRows.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('MISSING_BOM');
    });
    
    // ========== 新增邊界案例測試 ==========
    
    test('Edge Case: 單層 BOM（無子件）應該正確處理', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 100 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 }
        // COMP-A 無子件（葉節點）
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      expect(result.componentDemandRows.length).toBe(1);
      expect(result.componentDemandRows[0].material_code).toBe('COMP-A');
      expect(result.errors.length).toBe(0);
    });
    
    test('Edge Case: 需求量為 0 應該正確處理', () => {
      const fgDemands = [
        { 
          material_code: 'FG-001', 
          plant_id: 'P001', 
          time_bucket: '2026-02-01', 
          demand_qty: 0 
        }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 }
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      expect(result.componentDemandRows.length).toBe(1);
      expect(result.componentDemandRows[0].demand_qty).toBe(0);
    });
    
    test('Edge Case: 多個 FG 共用相同零件應該正確彙總', () => {
      const fgDemands = [
        { material_code: 'FG-001', plant_id: 'P001', time_bucket: '2026-02-01', demand_qty: 100 },
        { material_code: 'FG-002', plant_id: 'P001', time_bucket: '2026-02-01', demand_qty: 50 }
      ];
      
      const bomEdges = [
        { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 },
        { parent_material: 'FG-002', child_material: 'COMP-A', qty_per: 3 } // 共用 COMP-A
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      const compA = result.componentDemandRows.find(r => r.material_code === 'COMP-A');
      expect(compA.demand_qty).toBe(350); // (100 * 2) + (50 * 3)
    });
    
    // ========== 新增錯誤案例測試 ==========
    
    test('應該拋出錯誤：fgDemands 不是陣列', () => {
      expect(() => explodeBOM('not an array', [])).toThrow();
      expect(() => explodeBOM(null, [])).toThrow();
      expect(() => explodeBOM({}, [])).toThrow();
    });
    
    test('應該拋出錯誤：bomEdges 不是陣列', () => {
      expect(() => explodeBOM([], 'not an array')).toThrow();
      expect(() => explodeBOM([], null)).toThrow();
      expect(() => explodeBOM([], {})).toThrow();
    });
    
    test('錯誤案例：循環 BOM（A→B→A）應該檢測並報錯', () => {
      const fgDemands = [
        { material_code: 'A', plant_id: 'P001', time_bucket: '2026-02-01', demand_qty: 100 }
      ];
      
      const bomEdges = [
        { parent_material: 'A', child_material: 'B', qty_per: 1 },
        { parent_material: 'B', child_material: 'A', qty_per: 1 } // 循環！
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      const cycleError = result.errors.find(e => e.type === 'BOM_CYCLE');
      expect(cycleError).toBeDefined();
      expect(cycleError.message).toContain('Circular BOM');
      expect(cycleError.cycle_path).toContain('A');
      expect(cycleError.cycle_path).toContain('B');
    });
    
    test('錯誤案例：複雜循環 BOM（A→B→C→A）', () => {
      const fgDemands = [
        { material_code: 'A', plant_id: 'P001', time_bucket: '2026-02-01', demand_qty: 100 }
      ];
      
      const bomEdges = [
        { parent_material: 'A', child_material: 'B', qty_per: 1 },
        { parent_material: 'B', child_material: 'C', qty_per: 1 },
        { parent_material: 'C', child_material: 'A', qty_per: 1 } // 循環！
      ];
      
      const result = explodeBOM(fgDemands, bomEdges);
      
      const cycleError = result.errors.find(e => e.type === 'BOM_CYCLE');
      expect(cycleError).toBeDefined();
    });
  });
  
  // ========== 常數測試 ==========
  
  describe('Constants', () => {
    test('DEFAULTS 應該包含所有必要常數', () => {
      expect(DEFAULTS.MAX_BOM_DEPTH).toBeDefined();
      expect(DEFAULTS.DEFAULT_SCRAP_RATE).toBe(0);
      expect(DEFAULTS.DEFAULT_YIELD_RATE).toBe(1);
      expect(DEFAULTS.QUANTITY_DECIMALS).toBe(4);
    });
    
    test('ERROR_MESSAGES 應該提供所有錯誤訊息', () => {
      expect(ERROR_MESSAGES.CIRCULAR_BOM).toBeDefined();
      expect(ERROR_MESSAGES.INVALID_ARRAY).toBeDefined();
      expect(typeof ERROR_MESSAGES.INVALID_ARRAY).toBe('function');
    });
  });
});
