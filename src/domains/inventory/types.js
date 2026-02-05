/**
 * Inventory Domain - Type Definitions
 * 庫存領域層 - 型別定義
 * 
 * 此檔案定義了庫存計算所需的所有型別
 * 使用 JSDoc 提供完整的型別註解
 */

/**
 * @typedef {Object} InventoryPosition
 * 庫存位置資訊
 * @property {string} materialCode - 料號
 * @property {string} plantId - 工廠代碼
 * @property {number} currentStock - 現有庫存（含在途）
 * @property {number} safetyStock - 安全庫存水位
 * @property {number} dailyDemand - 日均消耗量
 * @property {number} leadTimeDays - 補貨提前期（天）
 * @property {number} [demandVolatility=0.1] - 需求波動係數 (Coefficient of Variation)
 */

/**
 * @typedef {Object} StockoutRisk
 * 斷料風險評估結果
 * @property {number} daysToStockout - 距離斷料天數
 * @property {number} probability - 斷料機率 (0-1)
 * @property {number} urgencyScore - 緊迫分數 (100/50/10)
 * @property {string} riskLevel - 風險等級：'critical' | 'warning' | 'low'
 */

/**
 * @typedef {Object} DaysToStockoutResult
 * 斷料天數計算結果
 * @property {number} days - 距離斷料天數
 * @property {string} status - 狀態：'critical' | 'warning' | 'ok'
 */

// Export empty object for module compatibility
export default {};
