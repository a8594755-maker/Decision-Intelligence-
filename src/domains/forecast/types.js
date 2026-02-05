/**
 * Forecast Domain - Type Definitions
 * 預測需求領域層 - 型別定義
 * 
 * 此檔案定義了 BOM Explosion 計算所需的所有型別
 * 使用 JSDoc 提供完整的型別註解
 */

/**
 * @typedef {Object} FGDemand
 * 成品需求
 * @property {string} material_code - 成品料號 (必填)
 * @property {string} plant_id - 工廠代碼 (必填)
 * @property {string} time_bucket - 時間區間，格式: YYYY-MM-DD 或 YYYY-W## (必填)
 * @property {number} demand_qty - 需求量 (必填)
 * @property {string} [id] - 需求記錄 ID（用於追溯）
 * @property {string} [source_type] - 需求來源類型（如: 'sales_order', 'forecast'）
 * @property {string} [source_id] - 需求來源 ID
 * @property {string} [uom='pcs'] - 單位
 */

/**
 * @typedef {Object} BOMEdge
 * BOM 關係（父件-子件）
 * @property {string} parent_material - 父件料號 (必填)
 * @property {string} child_material - 子件料號 (必填)
 * @property {number} qty_per - 單位用量（每個父件需要多少子件） (必填)
 * @property {number} [scrap_rate=0] - 報廢率 (0-1)，例如 0.05 表示 5% 報廢
 * @property {number} [yield_rate=1] - 良率 (0-1)，例如 0.95 表示 95% 良率
 * @property {string} [plant_id] - 工廠代碼（null 表示通用 BOM）
 * @property {string} [valid_from] - 生效日期（ISO 8601 格式）
 * @property {string} [valid_to] - 失效日期（ISO 8601 格式）
 * @property {number} [priority] - 優先級（數字越小優先級越高）
 * @property {string} [id] - BOM 記錄 ID
 * @property {string} [created_at] - 建立時間（用於衝突解決）
 */

/**
 * @typedef {Object} ComponentDemand
 * 零件需求（BOM 展開結果）
 * @property {string} material_code - 零件料號
 * @property {string} plant_id - 工廠代碼
 * @property {string} time_bucket - 時間區間
 * @property {number} demand_qty - 總需求量（彙總後）
 * @property {string} [uom='pcs'] - 單位
 * @property {string} [user_id] - 使用者 ID（用於資料庫寫入）
 * @property {string} [batch_id] - 批次 ID（用於資料庫寫入）
 * @property {string} [notes] - 備註
 */

/**
 * @typedef {Object} ComponentDemandTrace
 * 零件需求追溯記錄（記錄從 FG 到 Component 的展開路徑）
 * @property {string} fg_material_code - 來源成品料號
 * @property {string} component_material_code - 目標零件料號
 * @property {string} plant_id - 工廠代碼
 * @property {string} time_bucket - 時間區間
 * @property {number} fg_qty - 原始 FG 需求數量
 * @property {number} component_qty - 此路徑對 Component 的貢獻量
 * @property {number} qty_multiplier - 數量乘數（累積的 qty_per × scrap × yield）
 * @property {number} bom_level - BOM 層級（1, 2, 3...）
 * @property {string[]} path - 展開路徑（JSON array），例如: ['FG-001', 'SA-01', 'COMP-10']
 * @property {string} [source_type] - 需求來源類型
 * @property {string} [source_id] - 需求來源 ID
 * @property {string} [fg_demand_id] - FG 需求記錄 ID
 * @property {string} [bom_edge_id] - BOM 邊記錄 ID
 */

/**
 * @typedef {Object} ExplosionOptions
 * BOM 展開選項
 * @property {number} [maxDepth=50] - 最大展開層級（防止循環引用導致無限遞迴）
 * @property {boolean} [ignoreScrap=false] - 是否忽略報廢率（測試用）
 * @property {string} [userId] - 使用者 ID（用於輸出）
 * @property {string} [batchId] - 批次 ID（用於輸出）
 */

/**
 * @typedef {Object} ExplosionError
 * BOM 展開錯誤/警告
 * @property {string} type - 錯誤類型（如: 'BOM_CYCLE', 'MAX_DEPTH_EXCEEDED', 'MISSING_BOM'）
 * @property {string} message - 錯誤訊息
 * @property {string} [material] - 相關料號
 * @property {string[]} [path] - 相關路徑
 * @property {*} [details] - 其他詳細資訊
 */

/**
 * @typedef {Object} ExplosionResult
 * BOM 展開計算結果
 * @property {ComponentDemand[]} componentDemandRows - 零件需求清單（已彙總）
 * @property {ComponentDemandTrace[]} traceRows - 追溯記錄清單
 * @property {ExplosionError[]} errors - 錯誤/警告清單
 */

/**
 * @typedef {Object} BOMIndex
 * BOM 索引（內部使用）
 * @property {Map<string, BOMEdge[]>} index - parent_material -> BOMEdge[]
 */

// Export empty object for module compatibility
export default {};
