/**
 * Inventory Domain - Calculator
 * 庫存計算器 - 純函數實現
 * 
 * 此檔案包含所有庫存風險計算的核心邏輯
 * 所有函數都是 Pure Functions：
 * - 不依賴外部狀態
 * - 不產生副作用
 * - 相同輸入永遠產生相同輸出
 */

// ============================================
// 常數定義 (Constants)
// ============================================

/**
 * 風險評估常數
 */
export const RISK_THRESHOLDS = {
  CRITICAL_DAYS: 7,      // 7 天內斷料為緊急
  WARNING_DAYS: 14,      // 14 天內斷料為警告
  HIGH_VOLATILITY: 0.2,  // 需求波動超過 20% 視為高波動
  
  // 緊迫分數
  URGENCY_CRITICAL: 100,
  URGENCY_WARNING: 50,
  URGENCY_LOW: 10,
  
  // 機率上限
  MAX_PROBABILITY: 0.95,
  
  // 狀態標籤
  STATUS_CRITICAL: 'critical',
  STATUS_WARNING: 'warning',
  STATUS_OK: 'ok',
  STATUS_LOW: 'low'
};

/**
 * 錯誤訊息
 */
export const ERROR_MESSAGES = {
  INVALID_NUMBER: (name) => `${name} must be a valid number`,
  NEGATIVE_NUMBER: (name) => `${name} cannot be negative`,
  INVALID_PROBABILITY: 'Probability must be between 0 and 1'
};

// ============================================
// 核心計算函數 (Core Functions)
// ============================================

/**
 * 計算距離斷料天數
 * 
 * 公式：(currentStock - safetyStock) / dailyDemand
 * 
 * @param {number} currentStock - 現有庫存
 * @param {number} dailyDemand - 日均需求量
 * @param {number} [safetyStock=0] - 安全庫存水位
 * @returns {DaysToStockoutResult} 包含天數和狀態的結果
 * 
 * @example
 * // 庫存 100，日需求 10，安全庫存 20
 * calculateDaysToStockout(100, 10, 20)
 * // => { days: 8, status: 'critical' }
 * 
 * @example
 * // 無需求情況
 * calculateDaysToStockout(100, 0, 0)
 * // => { days: Infinity, status: 'ok' }
 */
export function calculateDaysToStockout(currentStock, dailyDemand, safetyStock = 0) {
  // 輸入驗證
  if (typeof currentStock !== 'number' || isNaN(currentStock)) {
    throw new Error(ERROR_MESSAGES.INVALID_NUMBER('currentStock'));
  }
  if (typeof dailyDemand !== 'number' || isNaN(dailyDemand)) {
    throw new Error(ERROR_MESSAGES.INVALID_NUMBER('dailyDemand'));
  }
  if (typeof safetyStock !== 'number' || isNaN(safetyStock) || safetyStock < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('safetyStock'));
  }
  
  // Edge Case 1: 負庫存（已斷料）
  if (currentStock < 0) {
    return {
      days: 0,
      status: RISK_THRESHOLDS.STATUS_CRITICAL
    };
  }
  
  // Edge Case 2: 庫存低於安全庫存（已觸發警戒）
  if (currentStock < safetyStock) {
    return {
      days: 0,
      status: RISK_THRESHOLDS.STATUS_CRITICAL
    };
  }
  
  // Edge Case 3: 無需求或零需求（無限期可用）
  if (dailyDemand <= 0) {
    return {
      days: Infinity,
      status: RISK_THRESHOLDS.STATUS_OK
    };
  }
  
  // 正常計算
  const availableStock = currentStock - safetyStock;
  const days = availableStock / dailyDemand;
  
  // 判斷狀態
  let status;
  if (days < RISK_THRESHOLDS.CRITICAL_DAYS) {
    status = RISK_THRESHOLDS.STATUS_CRITICAL;
  } else if (days < RISK_THRESHOLDS.WARNING_DAYS) {
    status = RISK_THRESHOLDS.STATUS_WARNING;
  } else {
    status = RISK_THRESHOLDS.STATUS_OK;
  }
  
  return {
    days: Math.max(0, days), // 確保不為負數
    status
  };
}

/**
 * 計算斷料機率
 * 
 * 使用簡易啟發式規則：
 * - 庫存 < 提前期 * 0.5 → 90% 機率
 * - 庫存 < 提前期 → 70% 機率
 * - 庫存 < 提前期 * 1.5 → 30% 機率
 * - 否則 → 10% 機率
 * 
 * 若需求波動高（> 0.2），機率 +10%（最高 95%）
 * 
 * @param {number} daysToStockout - 距離斷料天數
 * @param {number} leadTimeDays - 補貨提前期（天）
 * @param {number} [demandVolatility=0.1] - 需求波動係數
 * @returns {number} 斷料機率 (0-1)
 * 
 * @example
 * // 庫存僅剩 3 天，提前期 10 天，波動 0.15
 * calculateStockoutProbability(3, 10, 0.15)
 * // => 0.9 (90%)
 * 
 * @example
 * // 庫存充足 20 天，提前期 10 天
 * calculateStockoutProbability(20, 10, 0.1)
 * // => 0.1 (10%)
 */
export function calculateStockoutProbability(daysToStockout, leadTimeDays, demandVolatility = 0.1) {
  // 輸入驗證
  if (typeof daysToStockout !== 'number' || isNaN(daysToStockout) || daysToStockout < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('daysToStockout'));
  }
  if (typeof leadTimeDays !== 'number' || isNaN(leadTimeDays) || leadTimeDays < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('leadTimeDays'));
  }
  if (typeof demandVolatility !== 'number' || isNaN(demandVolatility) || demandVolatility < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('demandVolatility'));
  }
  
  // 基礎機率（根據啟發式規則）
  let baseProbability;
  
  if (daysToStockout < leadTimeDays * 0.5) {
    baseProbability = 0.9; // 90%
  } else if (daysToStockout < leadTimeDays) {
    baseProbability = 0.7; // 70%
  } else if (daysToStockout < leadTimeDays * 1.5) {
    baseProbability = 0.3; // 30%
  } else {
    baseProbability = 0.1; // 10%
  }
  
  // 波動調整：高波動增加 10% 機率
  const volatilityAdjustment = demandVolatility > RISK_THRESHOLDS.HIGH_VOLATILITY ? 0.1 : 0;
  
  // 計算最終機率（不超過 95%）
  const probability = Math.min(
    baseProbability + volatilityAdjustment,
    RISK_THRESHOLDS.MAX_PROBABILITY
  );
  
  return probability;
}

/**
 * 計算緊迫分數
 * 
 * 評分標準：
 * - < 7 天 → 100 分（Critical）
 * - < 14 天 → 50 分（Warning）
 * - >= 14 天 → 10 分（Low）
 * 
 * @param {number} daysToStockout - 距離斷料天數
 * @returns {number} 緊迫分數 (100 | 50 | 10)
 * 
 * @example
 * calculateUrgencyScore(5)   // => 100 (Critical)
 * calculateUrgencyScore(10)  // => 50 (Warning)
 * calculateUrgencyScore(20)  // => 10 (Low)
 */
export function calculateUrgencyScore(daysToStockout) {
  // 輸入驗證
  if (typeof daysToStockout !== 'number' || isNaN(daysToStockout) || daysToStockout < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('daysToStockout'));
  }
  
  // Edge Case: Infinity（無限期可用）
  if (daysToStockout === Infinity) {
    return RISK_THRESHOLDS.URGENCY_LOW;
  }
  
  // 根據天數判斷緊迫程度
  if (daysToStockout < RISK_THRESHOLDS.CRITICAL_DAYS) {
    return RISK_THRESHOLDS.URGENCY_CRITICAL; // 100
  } else if (daysToStockout < RISK_THRESHOLDS.WARNING_DAYS) {
    return RISK_THRESHOLDS.URGENCY_WARNING; // 50
  } else {
    return RISK_THRESHOLDS.URGENCY_LOW; // 10
  }
}

/**
 * 綜合計算庫存風險
 * 
 * 整合所有計算函數，返回完整的風險評估
 * 
 * @param {InventoryPosition} position - 庫存位置資訊
 * @returns {StockoutRisk} 完整的風險評估結果
 * 
 * @example
 * const position = {
 *   materialCode: 'COMP-001',
 *   plantId: 'P001',
 *   currentStock: 50,
 *   safetyStock: 20,
 *   dailyDemand: 10,
 *   leadTimeDays: 7,
 *   demandVolatility: 0.15
 * };
 * 
 * const risk = calculateInventoryRisk(position);
 * // => {
 * //   daysToStockout: 3,
 * //   probability: 0.9,
 * //   urgencyScore: 100,
 * //   riskLevel: 'critical'
 * // }
 */
export function calculateInventoryRisk(position) {
  // 驗證輸入物件
  if (!position || typeof position !== 'object') {
    throw new Error('Position must be a valid object');
  }
  
  const {
    currentStock,
    safetyStock = 0,
    dailyDemand,
    leadTimeDays,
    demandVolatility = 0.1
  } = position;
  
  // 計算斷料天數
  const stockoutResult = calculateDaysToStockout(currentStock, dailyDemand, safetyStock);
  
  // 計算斷料機率
  const probability = calculateStockoutProbability(
    stockoutResult.days,
    leadTimeDays,
    demandVolatility
  );
  
  // 計算緊迫分數
  const urgencyScore = calculateUrgencyScore(stockoutResult.days);
  
  // 決定風險等級
  let riskLevel;
  if (urgencyScore === RISK_THRESHOLDS.URGENCY_CRITICAL) {
    riskLevel = RISK_THRESHOLDS.STATUS_CRITICAL;
  } else if (urgencyScore === RISK_THRESHOLDS.URGENCY_WARNING) {
    riskLevel = RISK_THRESHOLDS.STATUS_WARNING;
  } else {
    riskLevel = RISK_THRESHOLDS.STATUS_LOW;
  }
  
  return {
    daysToStockout: stockoutResult.days,
    probability,
    urgencyScore,
    riskLevel
  };
}

// Export all functions
export default {
  calculateDaysToStockout,
  calculateStockoutProbability,
  calculateUrgencyScore,
  calculateInventoryRisk,
  RISK_THRESHOLDS,
  ERROR_MESSAGES
};
