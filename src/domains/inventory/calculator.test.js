/**
 * Inventory Domain - Calculator Tests
 * 庫存計算器單元測試
 * 
 * 測試所有核心計算函數的正確性
 */

import {
  calculateDaysToStockout,
  calculateStockoutProbability,
  calculateUrgencyScore,
  calculateInventoryRisk,
  RISK_THRESHOLDS,
  ERROR_MESSAGES
} from './calculator.js';

// ============================================
// calculateDaysToStockout 測試
// ============================================

describe('calculateDaysToStockout', () => {
  describe('Happy Path - 正常計算', () => {
    test('應該正確計算斷料天數（無安全庫存）', () => {
      // 庫存 100，日需求 10 = 10 天（在 7-14 天之間，為 warning）
      const result = calculateDaysToStockout(100, 10, 0);
      expect(result.days).toBe(10);
      expect(result.status).toBe('warning'); // 10 天在 7-14 之間
    });
    
    test('應該正確計算斷料天數（含安全庫存）', () => {
      // 庫存 100，日需求 10，安全庫存 20
      // (100 - 20) / 10 = 8 天（在 7-14 天之間）
      const result = calculateDaysToStockout(100, 10, 20);
      expect(result.days).toBe(8);
      expect(result.status).toBe('warning'); // 8 天在 7-14 之間
    });
    
    test('應該正確判斷 Critical 狀態（< 7 天）', () => {
      const result = calculateDaysToStockout(50, 10, 0);
      expect(result.days).toBe(5);
      expect(result.status).toBe('critical');
    });
    
    test('應該正確判斷 Warning 狀態（7-14 天）', () => {
      const result = calculateDaysToStockout(100, 10, 0);
      expect(result.days).toBe(10);
      expect(result.status).toBe('warning');
    });
    
    test('應該正確判斷 OK 狀態（>= 14 天）', () => {
      const result = calculateDaysToStockout(200, 10, 0);
      expect(result.days).toBe(20);
      expect(result.status).toBe('ok');
    });
  });
  
  describe('Edge Cases - 邊界案例', () => {
    test('Edge Case: dailyDemand = 0 應該返回 Infinity', () => {
      const result = calculateDaysToStockout(100, 0, 0);
      expect(result.days).toBe(Infinity);
      expect(result.status).toBe('ok');
    });
    
    test('Edge Case: dailyDemand < 0 應該返回 Infinity', () => {
      const result = calculateDaysToStockout(100, -5, 0);
      expect(result.days).toBe(Infinity);
      expect(result.status).toBe('ok');
    });
    
    test('Edge Case: currentStock < 0 應該返回 0 (已斷料)', () => {
      const result = calculateDaysToStockout(-10, 10, 0);
      expect(result.days).toBe(0);
      expect(result.status).toBe('critical');
    });
    
    test('Edge Case: currentStock < safetyStock 應該返回 0', () => {
      const result = calculateDaysToStockout(15, 10, 20);
      expect(result.days).toBe(0);
      expect(result.status).toBe('critical');
    });
    
    test('Edge Case: currentStock = safetyStock 應該返回 0', () => {
      const result = calculateDaysToStockout(20, 10, 20);
      expect(result.days).toBe(0);
      expect(result.status).toBe('critical');
    });
  });
  
  describe('Error Cases - 錯誤案例', () => {
    test('應該拋出錯誤：currentStock 不是數字', () => {
      expect(() => calculateDaysToStockout('100', 10)).toThrow();
      expect(() => calculateDaysToStockout(NaN, 10)).toThrow();
    });
    
    test('應該拋出錯誤：dailyDemand 不是數字', () => {
      expect(() => calculateDaysToStockout(100, '10')).toThrow();
      expect(() => calculateDaysToStockout(100, NaN)).toThrow();
    });
    
    test('應該拋出錯誤：safetyStock 為負數', () => {
      expect(() => calculateDaysToStockout(100, 10, -5)).toThrow();
    });
  });
});

// ============================================
// calculateStockoutProbability 測試
// ============================================

describe('calculateStockoutProbability', () => {
  describe('Happy Path - 正常計算', () => {
    test('庫存 < 提前期 * 0.5 應該返回 0.9', () => {
      // 3 天 < 10 天 * 0.5
      const prob = calculateStockoutProbability(3, 10, 0.1);
      expect(prob).toBe(0.9);
    });
    
    test('庫存 < 提前期 應該返回 0.7', () => {
      // 8 天 < 10 天
      const prob = calculateStockoutProbability(8, 10, 0.1);
      expect(prob).toBe(0.7);
    });
    
    test('庫存 < 提前期 * 1.5 應該返回 0.3', () => {
      // 12 天 < 10 天 * 1.5
      const prob = calculateStockoutProbability(12, 10, 0.1);
      expect(prob).toBe(0.3);
    });
    
    test('庫存充足應該返回 0.1', () => {
      // 20 天 >= 10 天 * 1.5
      const prob = calculateStockoutProbability(20, 10, 0.1);
      expect(prob).toBe(0.1);
    });
  });
  
  describe('Volatility Adjustment - 波動調整', () => {
    test('高波動（> 0.2）應該增加 10% 機率', () => {
      // 基礎 0.9 + 0.1 = 1.0，但最高 0.95
      const prob = calculateStockoutProbability(3, 10, 0.25);
      expect(prob).toBe(0.95);
    });
    
    test('高波動對低風險的影響', () => {
      // 基礎 0.1 + 0.1 = 0.2
      const prob = calculateStockoutProbability(20, 10, 0.25);
      expect(prob).toBe(0.2);
    });
    
    test('低波動（<= 0.2）不應調整機率', () => {
      const prob = calculateStockoutProbability(3, 10, 0.15);
      expect(prob).toBe(0.9);
    });
  });
  
  describe('Edge Cases - 邊界案例', () => {
    test('Edge Case: daysToStockout = 0', () => {
      const prob = calculateStockoutProbability(0, 10, 0.1);
      expect(prob).toBe(0.9);
    });
    
    test('Edge Case: leadTimeDays = 0', () => {
      // 0 < 0 * 0.5 為 false，繼續判斷
      const prob = calculateStockoutProbability(5, 0, 0.1);
      expect(prob).toBe(0.1); // 5 >= 0 * 1.5
    });
    
    test('Edge Case: 機率不應超過 0.95', () => {
      const prob = calculateStockoutProbability(1, 10, 0.5);
      expect(prob).toBeLessThanOrEqual(0.95);
    });
  });
  
  describe('Error Cases - 錯誤案例', () => {
    test('應該拋出錯誤：daysToStockout 為負數', () => {
      expect(() => calculateStockoutProbability(-5, 10)).toThrow();
    });
    
    test('應該拋出錯誤：leadTimeDays 為負數', () => {
      expect(() => calculateStockoutProbability(10, -5)).toThrow();
    });
    
    test('應該拋出錯誤：demandVolatility 為負數', () => {
      expect(() => calculateStockoutProbability(10, 10, -0.1)).toThrow();
    });
    
    test('應該拋出錯誤：輸入不是數字', () => {
      expect(() => calculateStockoutProbability('10', 10)).toThrow();
      expect(() => calculateStockoutProbability(NaN, 10)).toThrow();
    });
  });
});

// ============================================
// calculateUrgencyScore 測試
// ============================================

describe('calculateUrgencyScore', () => {
  describe('Happy Path - 正常計算', () => {
    test('< 7 天應該返回 100 (Critical)', () => {
      expect(calculateUrgencyScore(0)).toBe(100);
      expect(calculateUrgencyScore(3)).toBe(100);
      expect(calculateUrgencyScore(6.99)).toBe(100);
    });
    
    test('7-14 天應該返回 50 (Warning)', () => {
      expect(calculateUrgencyScore(7)).toBe(50);
      expect(calculateUrgencyScore(10)).toBe(50);
      expect(calculateUrgencyScore(13.99)).toBe(50);
    });
    
    test('>= 14 天應該返回 10 (Low)', () => {
      expect(calculateUrgencyScore(14)).toBe(10);
      expect(calculateUrgencyScore(20)).toBe(10);
      expect(calculateUrgencyScore(100)).toBe(10);
    });
  });
  
  describe('Edge Cases - 邊界案例', () => {
    test('Edge Case: Infinity 應該返回 10', () => {
      expect(calculateUrgencyScore(Infinity)).toBe(10);
    });
    
    test('Edge Case: 0 天應該返回 100', () => {
      expect(calculateUrgencyScore(0)).toBe(100);
    });
    
    test('Edge Case: 邊界值 7 天', () => {
      expect(calculateUrgencyScore(6.99)).toBe(100);
      expect(calculateUrgencyScore(7)).toBe(50);
      expect(calculateUrgencyScore(7.01)).toBe(50);
    });
    
    test('Edge Case: 邊界值 14 天', () => {
      expect(calculateUrgencyScore(13.99)).toBe(50);
      expect(calculateUrgencyScore(14)).toBe(10);
      expect(calculateUrgencyScore(14.01)).toBe(10);
    });
  });
  
  describe('Error Cases - 錯誤案例', () => {
    test('應該拋出錯誤：負數', () => {
      expect(() => calculateUrgencyScore(-5)).toThrow();
    });
    
    test('應該拋出錯誤：不是數字', () => {
      expect(() => calculateUrgencyScore('10')).toThrow();
      expect(() => calculateUrgencyScore(NaN)).toThrow();
    });
  });
});

// ============================================
// calculateInventoryRisk 綜合測試
// ============================================

describe('calculateInventoryRisk', () => {
  describe('Happy Path - 正常計算', () => {
    test('應該正確計算 Critical 風險', () => {
      const position = {
        materialCode: 'COMP-001',
        plantId: 'P001',
        currentStock: 50,
        safetyStock: 20,
        dailyDemand: 10,
        leadTimeDays: 7,
        demandVolatility: 0.15
      };
      
      const risk = calculateInventoryRisk(position);
      
      expect(risk.daysToStockout).toBe(3); // (50 - 20) / 10
      expect(risk.probability).toBe(0.9);   // < 7 * 0.5
      expect(risk.urgencyScore).toBe(100);  // < 7 天
      expect(risk.riskLevel).toBe('critical');
    });
    
    test('應該正確計算 Warning 風險', () => {
      const position = {
        currentStock: 100,
        safetyStock: 0,
        dailyDemand: 10,
        leadTimeDays: 7,
        demandVolatility: 0.1
      };
      
      const risk = calculateInventoryRisk(position);
      
      expect(risk.daysToStockout).toBe(10);
      expect(risk.urgencyScore).toBe(50);
      expect(risk.riskLevel).toBe('warning');
    });
    
    test('應該正確計算 Low 風險', () => {
      const position = {
        currentStock: 200,
        safetyStock: 0,
        dailyDemand: 10,
        leadTimeDays: 7,
        demandVolatility: 0.1
      };
      
      const risk = calculateInventoryRisk(position);
      
      expect(risk.daysToStockout).toBe(20);
      expect(risk.urgencyScore).toBe(10);
      expect(risk.riskLevel).toBe('low');
    });
  });
  
  describe('Edge Cases - 邊界案例', () => {
    test('Edge Case: 無需求應該返回低風險', () => {
      const position = {
        currentStock: 100,
        safetyStock: 0,
        dailyDemand: 0,
        leadTimeDays: 7
      };
      
      const risk = calculateInventoryRisk(position);
      
      expect(risk.daysToStockout).toBe(Infinity);
      expect(risk.urgencyScore).toBe(10);
      expect(risk.riskLevel).toBe('low');
    });
    
    test('Edge Case: 高波動應該增加斷料機率', () => {
      const position = {
        currentStock: 50,
        safetyStock: 0,
        dailyDemand: 10,
        leadTimeDays: 7,
        demandVolatility: 0.3 // 高波動
      };
      
      const risk = calculateInventoryRisk(position);
      
      // 使用 toBeCloseTo 避免浮點數精度問題
      expect(risk.probability).toBeCloseTo(0.8, 1); // 0.7 + 0.1
    });
  });
  
  describe('Error Cases - 錯誤案例', () => {
    test('應該拋出錯誤：position 不是物件', () => {
      expect(() => calculateInventoryRisk(null)).toThrow();
      expect(() => calculateInventoryRisk('invalid')).toThrow();
    });
    
    test('應該拋出錯誤：缺少必要欄位', () => {
      const position = {
        currentStock: 100
        // 缺少其他欄位
      };
      
      expect(() => calculateInventoryRisk(position)).toThrow();
    });
  });
});

// ============================================
// 常數測試
// ============================================

describe('Constants', () => {
  test('RISK_THRESHOLDS 應該包含所有必要常數', () => {
    expect(RISK_THRESHOLDS.CRITICAL_DAYS).toBe(7);
    expect(RISK_THRESHOLDS.WARNING_DAYS).toBe(14);
    expect(RISK_THRESHOLDS.URGENCY_CRITICAL).toBe(100);
    expect(RISK_THRESHOLDS.URGENCY_WARNING).toBe(50);
    expect(RISK_THRESHOLDS.URGENCY_LOW).toBe(10);
  });
  
  test('ERROR_MESSAGES 應該提供錯誤訊息模板', () => {
    expect(ERROR_MESSAGES.INVALID_NUMBER).toBeDefined();
    expect(typeof ERROR_MESSAGES.INVALID_NUMBER).toBe('function');
    expect(ERROR_MESSAGES.INVALID_NUMBER('test')).toContain('test');
  });
});
