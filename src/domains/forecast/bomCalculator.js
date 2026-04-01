/**
 * Forecast Domain - BOM Calculator
 * BOM 計算器 - 純函數實現
 * 
 * 此檔案包含所有 BOM Explosion 的核心計算邏輯
 * 所有函數都是 Pure Functions：
 * - 不依賴外部狀態
 * - 不產生副作用
 * - 相同輸入永遠產生相同輸出
 * - 不呼叫 API 或修改輸入參數
 */

// ============================================
// 常數定義 (Constants)
// ============================================

/**
 * 預設值和限制常數
 */
export const DEFAULTS = {
  // BOM 展開限制
  MAX_BOM_DEPTH: 50,           // 最大 BOM 展開層級
  DEFAULT_SCRAP_RATE: 0,       // 預設報廢率
  DEFAULT_YIELD_RATE: 1,       // 預設良率
  DEFAULT_QTY_PER: 1,          // 預設單位用量
  
  // 數值精度
  QUANTITY_DECIMALS: 4,        // 數量小數位數
  
  // 驗證範圍
  MIN_SCRAP_RATE: 0,           // 最小報廢率
  MAX_SCRAP_RATE: 0.99,        // 最大報廢率（防止除以零）
  MIN_YIELD_RATE: 0.01,        // 最小良率（防止除以零）
  MAX_YIELD_RATE: 1,           // 最大良率
  MIN_QTY_PER: 0,              // 最小單位用量
  
  // 預設單位
  DEFAULT_UOM: 'pcs'
};

/**
 * 錯誤訊息常數
 */
export const ERROR_MESSAGES = {
  // 輸入驗證
  INVALID_ARRAY: (name) => `${name} must be an array`,
  EMPTY_ARRAY: (name) => `${name} cannot be empty`,
  INVALID_NUMBER: (name) => `${name} must be a valid number`,
  NEGATIVE_NUMBER: (name) => `${name} cannot be negative`,
  
  // 範圍驗證
  OUT_OF_RANGE: (name, min, max) => `${name} must be between ${min} and ${max}`,
  
  // BOM 驗證
  MISSING_FIELD: (field) => `Missing required field: ${field}`,
  CIRCULAR_BOM: 'Circular BOM reference detected',
  MAX_DEPTH: (depth) => `BOM explosion depth exceeded maximum limit (${depth})`,
  MISSING_BOM_DEFINITION: (material) => `No BOM definition found for ${material}`,
  UOM_MISMATCH: (material, existing, incoming) =>
    `UOM mismatch for ${material}: existing "${existing}" vs incoming "${incoming}"`,

  // 時間驗證
  INVALID_TIME_BUCKET: (bucket) => `Cannot parse time_bucket: ${bucket}`
};

// ============================================
// 工具函數 (Utility Functions)
// ============================================

/**
 * 四捨五入到指定小數位數
 * @param {number} value - 數值
 * @param {number} [decimals=4] - 小數位數
 * @returns {number} 四捨五入後的數值
 * @throws {Error} 如果輸入不是有效數字
 */
export function roundTo(value, decimals = DEFAULTS.QUANTITY_DECIMALS) {
  // 輸入驗證
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error(ERROR_MESSAGES.INVALID_NUMBER('value'));
  }
  if (typeof decimals !== 'number' || decimals < 0) {
    throw new Error(ERROR_MESSAGES.INVALID_NUMBER('decimals'));
  }
  
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * 生成聚合 key（用於 Map 鍵值）
 * @param {string} plantId - 工廠代碼
 * @param {string} timeBucket - 時間區間
 * @param {string} materialCode - 料號
 * @returns {string} 聚合 key (格式: plantId|timeBucket|materialCode)
 * @throws {Error} 如果任何參數為空
 */
export function getAggregationKey(plantId, timeBucket, materialCode) {
  // 輸入驗證
  if (!plantId || typeof plantId !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('plantId'));
  }
  if (!timeBucket || typeof timeBucket !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('timeBucket'));
  }
  if (!materialCode || typeof materialCode !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('materialCode'));
  }
  
  return `${plantId}|${timeBucket}|${materialCode}`;
}

/**
 * 解析聚合 key
 * @param {string} key - 聚合 key
 * @returns {{plantId: string, timeBucket: string, materialCode: string}}
 */
export function parseAggregationKey(key) {
  const [plantId, timeBucket, materialCode] = key.split('|');
  return { plantId, timeBucket, materialCode };
}

/**
 * 將 time_bucket 轉換為日期
 * @param {string} timeBucket - 時間桶（YYYY-MM-DD 或 YYYY-W##）
 * @returns {Date|null} 日期物件，無法解析時返回 null
 */
export function timeBucketToDate(timeBucket) {
  if (!timeBucket) return null;
  
  // 檢查是否為 YYYY-MM-DD 格式
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeBucket)) {
    return new Date(timeBucket);
  }
  
  // 檢查是否為 YYYY-W## 格式（ISO week）
  const weekMatch = timeBucket.match(/^(\d{4})-W(\d{2})$/);
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10);
    const week = parseInt(weekMatch[2], 10);
    
    // ISO 8601 週的定義：
    // - 第 1 週是包含該年第一個星期四的週
    // - 週從星期一開始
    
    // 取得該年 1 月 4 日（保證在第 1 週內）
    const jan4 = new Date(year, 0, 4);
    
    // 找到第 1 週的星期一
    const dayOfWeek = jan4.getDay(); // 0=Sunday, 1=Monday, ...
    const daysToMonday = (dayOfWeek === 0) ? -6 : 1 - dayOfWeek;
    const firstMonday = new Date(jan4);
    firstMonday.setDate(jan4.getDate() + daysToMonday);
    
    // 計算目標週的星期一
    const targetMonday = new Date(firstMonday);
    targetMonday.setDate(firstMonday.getDate() + (week - 1) * 7);
    
    return targetMonday;
  }
  
  // 無法識別的格式
  return null;
}

// ============================================
// 核心計算函數 (Core Calculation Functions)
// ============================================

/**
 * 計算零件需求量（考慮報廢率和良率）
 * 
 * 公式: component_qty = parent_qty × qty_per × (1 + scrap_rate) / yield_rate
 * 
 * @param {number} parentQty - 父件數量
 * @param {number} qtyPer - 單位用量（每個父件需要多少子件）
 * @param {number} [scrapRate=0] - 報廢率 (0-1)
 * @param {number} [yieldRate=1] - 良率 (0-1)
 * @returns {number} 子件需求數量（四捨五入到小數點 4 位）
 * 
 * @example
 * // 生產 100 個父件，每個父件需要 2 個子件，報廢率 5%，良率 95%
 * calculateComponentRequirement(100, 2, 0.05, 0.95)
 * // = 100 × 2 × (1 + 0.05) / 0.95
 * // = 100 × 2 × 1.05 / 0.95
 * // = 221.0526
 */
export function calculateComponentRequirement(
  parentQty, 
  qtyPer, 
  scrapRate = DEFAULTS.DEFAULT_SCRAP_RATE, 
  yieldRate = DEFAULTS.DEFAULT_YIELD_RATE
) {
  // Early Return: 處理 null/undefined
  if (parentQty === null || parentQty === undefined) {
    return 0;
  }
  if (qtyPer === null || qtyPer === undefined) {
    qtyPer = DEFAULTS.DEFAULT_QTY_PER;
  }
  
  // 參數驗證
  if (typeof parentQty !== 'number' || isNaN(parentQty) || parentQty < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('parentQty'));
  }
  
  // Edge Case: qtyPer 為 0 或負數
  if (typeof qtyPer !== 'number' || isNaN(qtyPer) || qtyPer < DEFAULTS.MIN_QTY_PER) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('qtyPer'));
  }
  
  // Edge Case: qtyPer 為 0 直接返回 0
  if (qtyPer === 0) {
    return 0;
  }
  
  // 報廢率驗證（防止 >= 1 導致除以零）
  if (typeof scrapRate !== 'number' || isNaN(scrapRate) || 
      scrapRate < DEFAULTS.MIN_SCRAP_RATE || scrapRate >= DEFAULTS.MAX_SCRAP_RATE) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE(
      'scrapRate', 
      DEFAULTS.MIN_SCRAP_RATE, 
      DEFAULTS.MAX_SCRAP_RATE
    ));
  }
  
  // 良率驗證（防止 <= 0 導致除以零）
  if (typeof yieldRate !== 'number' || isNaN(yieldRate) || 
      yieldRate < DEFAULTS.MIN_YIELD_RATE || yieldRate > DEFAULTS.MAX_YIELD_RATE) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE(
      'yieldRate',
      DEFAULTS.MIN_YIELD_RATE,
      DEFAULTS.MAX_YIELD_RATE
    ));
  }
  
  const result = parentQty * qtyPer * (1 + scrapRate) / yieldRate;
  return roundTo(result, DEFAULTS.QUANTITY_DECIMALS);
}

/**
 * 彙總零件需求（按 material_code + plant_id + time_bucket）
 * 
 * @param {Array} componentList - 零件清單（可能包含重複的 material_code）
 * @param {Array} [errors=[]] - 錯誤陣列（用於記錄驗證警告）
 * @returns {Map<string, number>} 彙總結果 (aggregation_key -> total_qty)
 * 
 * @example
 * const components = [
 *   { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
 *   { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 50 },
 *   { material_code: 'COMP-B', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 200 }
 * ];
 * 
 * const errors = [];
 * const aggregated = aggregateByComponent(components, errors);
 * // Map {
 * //   'P001|2026-W01|COMP-A' => 150,
 * //   'P001|2026-W01|COMP-B' => 200
 * // }
 */
export function aggregateByComponent(componentList, errors = []) {
  // 輸入驗證
  if (!Array.isArray(componentList)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('componentList'));
  }
  
  // Early Return: 空陣列
  if (componentList.length === 0) {
    return new Map();
  }
  
  const aggregationMap = new Map();
  
  for (const component of componentList) {
    // 驗證必要欄位
    if (!component.plant_id || !component.time_bucket || !component.material_code) {
      // 找出缺少的欄位
      const missingFields = [];
      if (!component.plant_id) missingFields.push('plant_id');
      if (!component.time_bucket) missingFields.push('time_bucket');
      if (!component.material_code) missingFields.push('material_code');
      
      errors.push({
        type: 'VALIDATION_WARNING',
        severity: 'low',
        message: `Component missing required fields: ${missingFields.join(', ')}`,
        material: component.material_code || 'unknown',
        component_id: component.id || null,
        missing_fields: missingFields
      });
      continue;
    }
    
    // 驗證數量
    const qty = component.demand_qty ?? 0;
    if (typeof qty !== 'number' || isNaN(qty) || qty < 0) {
      errors.push({
        type: 'VALIDATION_WARNING',
        severity: 'medium',
        message: `Invalid demand_qty: ${qty} (expected non-negative number)`,
        material: component.material_code,
        plant_id: component.plant_id,
        time_bucket: component.time_bucket,
        provided_value: qty
      });
      continue;
    }
    
    const key = getAggregationKey(
      component.plant_id,
      component.time_bucket,
      component.material_code
    );
    
    const currentQty = aggregationMap.get(key) || 0;
    aggregationMap.set(key, currentQty + qty);
  }
  
  return aggregationMap;
}

/**
 * 建立 BOM 索引（按 parent_material 分組）
 * 
 * 此函數會：
 * 1. 根據 plant_id 過濾 BOM（plant_id 匹配或為 null 的通用 BOM）
 * 2. 根據 time_bucket 進行時效性過濾（valid_from/valid_to）
 * 3. 處理重疊的 effectivity（同一時間有多筆有效的 BOM）
 * 4. 選擇規則：優先 priority（數字越小越優先），其次 created_at（越新越優先）
 * 
 * @param {Array} bomEdges - BOM 關係陣列
 * @param {string} plantId - 工廠代碼
 * @param {Date} bucketDate - 時間桶對應的日期
 * @param {Array} errors - 錯誤陣列（用於記錄警告）
 * @returns {Map<string, Array>} parent_material -> [BOMEdge, ...]
 */
export function buildBomIndex(bomEdges, plantId, bucketDate, errors = []) {
  // 輸入驗證
  if (!Array.isArray(bomEdges)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('bomEdges'));
  }
  if (!plantId || typeof plantId !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('plantId'));
  }
  
  // Early Return: 空陣列
  if (bomEdges.length === 0) {
    return new Map();
  }
  
  const index = new Map();
  const overlapWarnings = new Map();
  
  for (const edge of bomEdges) {
    // 過濾 1：工廠匹配（plant_id 匹配或為 NULL 的通用 BOM）
    if (edge.plant_id && edge.plant_id !== plantId) {
      continue;
    }
    
    // 過濾 2：時效性過濾（effectivity）
    if (bucketDate) {
      const validFrom = edge.valid_from ? new Date(edge.valid_from) : null;
      const validTo = edge.valid_to ? new Date(edge.valid_to) : null;
      
      if (validFrom && bucketDate < validFrom) {
        continue; // 尚未生效
      }
      if (validTo && bucketDate > validTo) {
        continue; // 已失效
      }
    }
    
    const parent = edge.parent_material;
    const child = edge.child_material;
    
    if (!index.has(parent)) {
      index.set(parent, []);
    }
    
    const edges = index.get(parent);
    const existingChild = edges.find(e => e.child_material === child);
    
    if (!existingChild) {
      edges.push(edge);
    } else {
      // 檢測到重疊的 effectivity
      const overlapKey = `${parent}|${child}`;
      
      if (!overlapWarnings.has(overlapKey)) {
        errors.push({
          type: 'OVERLAP_EFFECTIVITY',
          message: `同一時間有效的 BOM 記錄重疊`,
          parent_material: parent,
          child_material: child,
          details: {
            existing_bom: {
              id: existingChild.id,
              priority: existingChild.priority,
              created_at: existingChild.created_at
            },
            new_bom: {
              id: edge.id,
              priority: edge.priority,
              created_at: edge.created_at
            }
          }
        });
        overlapWarnings.set(overlapKey, true);
      }
      
      // 選擇規則：priority 優先，其次 created_at
      let shouldReplace = false;
      
      if (edge.priority !== null && edge.priority !== undefined) {
        if (existingChild.priority === null || existingChild.priority === undefined) {
          shouldReplace = true;
        } else if (edge.priority < existingChild.priority) {
          shouldReplace = true;
        } else if (edge.priority === existingChild.priority) {
          const newCreatedAt = edge.created_at ? new Date(edge.created_at) : null;
          const existingCreatedAt = existingChild.created_at ? new Date(existingChild.created_at) : null;
          
          if (newCreatedAt && existingCreatedAt && newCreatedAt > existingCreatedAt) {
            shouldReplace = true;
          }
        }
      } else {
        if (existingChild.priority === null || existingChild.priority === undefined) {
          const newCreatedAt = edge.created_at ? new Date(edge.created_at) : null;
          const existingCreatedAt = existingChild.created_at ? new Date(existingChild.created_at) : null;
          
          if (newCreatedAt && existingCreatedAt && newCreatedAt > existingCreatedAt) {
            shouldReplace = true;
          }
        }
      }
      
      if (shouldReplace) {
        const idx = edges.indexOf(existingChild);
        edges[idx] = edge;
      }
    }
  }
  
  return index;
}

/**
 * 遞迴展開 BOM（內部函數）
 * 
 * 此函數會遞迴展開 BOM 結構，並：
 * 1. 檢測循環引用（透過 path 追蹤）
 * 2. 檢測最大深度（防止無限遞迴）
 * 3. 計算每個零件的需求量（考慮 scrap/yield）
 * 4. 記錄追溯資訊（path, qty_multiplier, bom_level）
 * 
 * @private
 */
function explodeBOMRecursive(
  parentDemand,
  bomLevel,
  multiplier,
  path,
  bomIndex,
  componentDemandMap,
  traceRows,
  errors,
  maxDepth,
  fgMaterialCode,
  fgDemandId,
  fgQty,
  sourceType,
  sourceId,
  bomEdgeId
) {
  // 檢查最大深度
  if (bomLevel > maxDepth) {
    errors.push({
      type: 'MAX_DEPTH_EXCEEDED',
      message: ERROR_MESSAGES.MAX_DEPTH(maxDepth),
      material: parentDemand.material_code,
      path: [...path, parentDemand.material_code]
    });
    return;
  }
  
  // 檢查循環引用（防止 A→B→C→A）
  if (path.includes(parentDemand.material_code)) {
    errors.push({
      type: 'BOM_CYCLE',
      message: ERROR_MESSAGES.CIRCULAR_BOM,
      material: parentDemand.material_code,
      path: [...path, parentDemand.material_code],
      cycle_path: [...path, parentDemand.material_code]
    });
    return;
  }
  
  // 查找子件
  const children = bomIndex.get(parentDemand.material_code) || [];
  
  // 記錄零件需求（path.length > 0 表示不是 FG 本身）
  if (path.length > 0) {
    const key = getAggregationKey(
      parentDemand.plant_id,
      parentDemand.time_bucket,
      parentDemand.material_code
    );

    const demandUom = parentDemand.uom || DEFAULTS.DEFAULT_UOM;

    // 累加需求數量，tracking UOM
    const existing = componentDemandMap.get(key);
    if (existing) {
      if (existing.uom !== demandUom) {
        errors.push({
          type: 'UOM_MISMATCH',
          severity: 'high',
          message: ERROR_MESSAGES.UOM_MISMATCH(parentDemand.material_code, existing.uom, demandUom),
          material: parentDemand.material_code,
          plant_id: parentDemand.plant_id,
          time_bucket: parentDemand.time_bucket,
          existing_uom: existing.uom,
          incoming_uom: demandUom
        });
      }
      existing.qty += parentDemand.demand_qty;
    } else {
      componentDemandMap.set(key, { qty: parentDemand.demand_qty, uom: demandUom });
    }
    
    // 記錄追溯資訊
    const fullPath = [...path, parentDemand.material_code];
    const componentBomLevel = path.length;
    
    traceRows.push({
      fg_material_code: fgMaterialCode,
      component_material_code: parentDemand.material_code,
      plant_id: parentDemand.plant_id,
      time_bucket: parentDemand.time_bucket,
      fg_qty: fgQty,
      component_qty: parentDemand.demand_qty,
      source_type: sourceType,
      source_id: sourceId,
      path: fullPath,
      fg_demand_id: fgDemandId,
      bom_edge_id: bomEdgeId,
      bom_level: componentBomLevel,
      qty_multiplier: multiplier
    });
  }
  
  // 如果有子件，繼續遞迴展開
  if (children.length > 0) {
    for (const childEdge of children) {
      const scrapRate = childEdge.scrap_rate ?? 0;
      const yieldRate = childEdge.yield_rate ?? 1;
      
      // 計算子件數量
      const childQty = calculateComponentRequirement(
        parentDemand.demand_qty,
        childEdge.qty_per,
        scrapRate,
        yieldRate
      );
      
      const newMultiplier = roundTo(
        multiplier * childEdge.qty_per * (1 + scrapRate) / yieldRate,
        4
      );
      
      // Read UOM from BOM edge
      const childUom = childEdge.uom || childEdge.child_uom || DEFAULTS.DEFAULT_UOM;

      // 建立子件需求物件
      const childDemand = {
        material_code: childEdge.child_material,
        plant_id: parentDemand.plant_id,
        time_bucket: parentDemand.time_bucket,
        demand_qty: childQty,
        uom: childUom,
        id: null
      };
      
      // 遞迴展開子件
      explodeBOMRecursive(
        childDemand,
        bomLevel + 1,
        newMultiplier,
        [...path, parentDemand.material_code],
        bomIndex,
        componentDemandMap,
        traceRows,
        errors,
        maxDepth,
        fgMaterialCode,
        fgDemandId,
        fgQty,
        sourceType,
        sourceId,
        childEdge.id
      );
    }
  }
}

/**
 * 執行 BOM Explosion 計算（主函數）
 * 
 * 此函數是 BOM Explosion 的主入口，會：
 * 1. 驗證輸入資料
 * 2. 對每個 FG 需求建立 BOM 索引
 * 3. 遞迴展開 BOM 結構
 * 4. 彙總零件需求
 * 5. 返回計算結果和追溯記錄
 * 
 * @param {Array} fgDemands - FG 需求陣列（參考 types.js 的 FGDemand）
 * @param {Array} bomEdges - BOM 關係陣列（參考 types.js 的 BOMEdge）
 * @param {Object} [options={}] - 選項（參考 types.js 的 ExplosionOptions）
 * @returns {Object} 計算結果（參考 types.js 的 ExplosionResult）
 * 
 * @example
 * const fgDemands = [
 *   { material_code: 'FG-001', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 }
 * ];
 * 
 * const bomEdges = [
 *   { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2, scrap_rate: 0.05 },
 *   { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1 }
 * ];
 * 
 * const result = explodeBOM(fgDemands, bomEdges);
 * // result.componentDemandRows: [
 * //   { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 210 },
 * //   { material_code: 'COMP-B', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 }
 * // ]
 */
export function explodeBOM(fgDemands, bomEdges, options = {}) {
  // 輸入驗證：必須是陣列
  if (!Array.isArray(fgDemands)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('fgDemands'));
  }
  if (!Array.isArray(bomEdges)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('bomEdges'));
  }
  
  const {
    maxDepth = DEFAULTS.MAX_BOM_DEPTH,
    ignoreScrap = false,
    userId = null,
    batchId = null
  } = options;
  
  // 初始化結果
  const componentDemandMap = new Map();
  const traceRows = [];
  const errors = [];
  
  // Early Return: 空陣列
  if (fgDemands.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [{
        type: 'NO_INPUT',
        message: ERROR_MESSAGES.EMPTY_ARRAY('fgDemands')
      }]
    };
  }
  
  if (bomEdges.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [{
        type: 'NO_BOM',
        message: ERROR_MESSAGES.EMPTY_ARRAY('bomEdges')
      }]
    };
  }
  
  // 如果 ignoreScrap = true，移除所有 scrap_rate（測試用）
  const processedBomEdges = ignoreScrap
    ? bomEdges.map(edge => ({ ...edge, scrap_rate: 0, yield_rate: 1 }))
    : bomEdges;
  
  // 對每個 FG 需求進行展開
  for (const fgDemand of fgDemands) {
    // 驗證必要欄位
    if (!fgDemand.material_code || !fgDemand.plant_id || !fgDemand.time_bucket ||
        fgDemand.demand_qty === undefined || fgDemand.demand_qty === null) {
      errors.push({
        type: 'INVALID_FG_DEMAND',
        message: 'FG 需求缺少必要欄位',
        details: fgDemand
      });
      continue;
    }
    
    // 將 time_bucket 轉換為日期
    const bucketDate = timeBucketToDate(fgDemand.time_bucket);
    
    if (!bucketDate) {
      errors.push({
        type: 'INVALID_TIME_BUCKET',
        message: `無法解析 time_bucket: ${fgDemand.time_bucket}`,
        details: fgDemand
      });
      continue;
    }
    
    // 建立 BOM 索引
    const bomIndex = buildBomIndex(processedBomEdges, fgDemand.plant_id, bucketDate, errors);
    
    // 檢查是否有對應的 BOM 定義
    if (!bomIndex.has(fgDemand.material_code)) {
      errors.push({
        type: 'MISSING_BOM',
        message: `找不到 ${fgDemand.material_code} 的 BOM 定義`,
        material: fgDemand.material_code,
        plant_id: fgDemand.plant_id,
        time_bucket: fgDemand.time_bucket
      });
      continue;
    }
    
    // 開始展開
    explodeBOMRecursive(
      {
        material_code: fgDemand.material_code,
        plant_id: fgDemand.plant_id,
        time_bucket: fgDemand.time_bucket,
        demand_qty: fgDemand.demand_qty,
        id: fgDemand.id
      },
      1, // bomLevel
      1.0, // multiplier
      [], // path
      bomIndex,
      componentDemandMap,
      traceRows,
      errors,
      maxDepth,
      fgDemand.material_code,
      fgDemand.id,
      fgDemand.demand_qty,
      fgDemand.source_type || null,
      fgDemand.source_id || null,
      null // bomEdgeId（FG 沒有 edge）
    );
  }
  
  // 將聚合 Map 轉換為 componentDemandRows
  const componentDemandRows = [];
  for (const [key, entry] of componentDemandMap.entries()) {
    const { plantId, timeBucket, materialCode } = parseAggregationKey(key);

    componentDemandRows.push({
      user_id: userId,
      batch_id: batchId,
      material_code: materialCode,
      plant_id: plantId,
      time_bucket: timeBucket,
      demand_qty: entry.qty,
      uom: entry.uom,
      notes: null
    });
  }
  
  return {
    componentDemandRows,
    traceRows,
    errors
  };
}

// ============================================
// Export all functions
// ============================================

export default {
  // Utility functions
  roundTo,
  getAggregationKey,
  parseAggregationKey,
  timeBucketToDate,
  
  // Core calculation functions
  calculateComponentRequirement,
  aggregateByComponent,
  buildBomIndex,
  explodeBOM
};
