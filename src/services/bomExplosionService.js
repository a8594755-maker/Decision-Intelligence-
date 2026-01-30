/**
 * BOM Explosion Service
 * BOM 展開服務 - 將 FG 需求展開為 Component 需求
 * 
 * 功能特性：
 * - 支援多層 BOM 展開
 * - 循環引用檢測
 * - 防止無限遞迴（maxDepth=50）
 * - 工廠匹配過濾（plant_id match 或通用 BOM）
 * - 時效性過濾（valid_from/valid_to）
 * - Scrap/Yield 計算（component_qty = parent_qty × qty_per × (1 + scrap_rate) / yield_rate）
 * - 數量精度：小數點 4 位
 * - 先不做替代料分配（只取第一筆）
 */

/**
 * 生成聚合 Map 的 key
 * @param {string} plantId - 工廠代碼
 * @param {string} timeBucket - 時間桶
 * @param {string} materialCode - 料號
 * @returns {string} 聚合 key
 */
function getAggregationKey(plantId, timeBucket, materialCode) {
  return `${plantId}|${timeBucket}|${materialCode}`;
}

/**
 * 四捨五入到指定小數位數
 * @param {number} value - 數值
 * @param {number} decimals - 小數位數（預設 4）
 * @returns {number} 四捨五入後的數值
 */
function roundTo(value, decimals = 4) {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * 將 time_bucket 轉換為日期
 * @param {string} timeBucket - 時間桶（YYYY-MM-DD 或 YYYY-W##）
 * @returns {Date} 日期物件
 */
function timeBucketToDate(timeBucket) {
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
  
  // 無法識別的格式，返回 null
  console.warn(`無法識別的 time_bucket 格式: ${timeBucket}`);
  return null;
}

/**
 * 解析聚合 key
 * @param {string} key - 聚合 key
 * @returns {Object} {plantId, timeBucket, materialCode}
 */
function parseAggregationKey(key) {
  const [plantId, timeBucket, materialCode] = key.split('|');
  return { plantId, timeBucket, materialCode };
}

/**
 * 建立 BOM 索引（按 parent_material 分組）
 * @param {Array} bomEdges - BOM 關係陣列
 * @param {string} plantId - 工廠代碼（用於過濾）
 * @param {Date} bucketDate - 時間桶對應的日期（用於時效性過濾）
 * @param {Array} errors - 錯誤陣列（用於記錄警告）
 * @returns {Map} parent_material -> [bom_edges]
 */
function buildBomIndex(bomEdges, plantId, bucketDate, errors) {
  const index = new Map();
  const overlapWarnings = new Map(); // 用於追蹤重疊的 effectivity
  
  for (const edge of bomEdges) {
    // 過濾 1：工廠匹配
    // plant_id 匹配或為 NULL（通用 BOM）
    if (edge.plant_id && edge.plant_id !== plantId) {
      continue; // 跳過不匹配的工廠特定 BOM
    }
    
    // 過濾 2：時效性過濾（effectivity）
    // valid_from 和 valid_to 若為空，視為永遠有效
    if (bucketDate) {
      const validFrom = edge.valid_from ? new Date(edge.valid_from) : null;
      const validTo = edge.valid_to ? new Date(edge.valid_to) : null;
      
      // 檢查時效性
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
    
    // 檢查是否已有相同 parent-child 組合
    const existingChild = edges.find(e => e.child_material === child);
    
    if (!existingChild) {
      // 第一次遇到此 parent-child 組合
      edges.push(edge);
    } else {
      // 已有相同 parent-child 組合：overlap effectivity
      const overlapKey = `${parent}|${child}`;
      
      // 記錄警告（只記錄一次）
      if (!overlapWarnings.has(overlapKey)) {
        errors.push({
          type: 'OVERLAP_EFFECTIVITY',
          message: `同一時間有效的 BOM 記錄重疊`,
          parent_material: parent,
          child_material: child,
          existing_bom: {
            id: existingChild.id,
            valid_from: existingChild.valid_from,
            valid_to: existingChild.valid_to,
            priority: existingChild.priority,
            created_at: existingChild.created_at
          },
          new_bom: {
            id: edge.id,
            valid_from: edge.valid_from,
            valid_to: edge.valid_to,
            priority: edge.priority,
            created_at: edge.created_at
          }
        });
        overlapWarnings.set(overlapKey, true);
      }
      
      // 選擇規則：
      // 1. 優先考慮 priority（數字越小優先級越高）
      // 2. 如果 priority 相同或都為空，選擇 created_at 最新的
      let shouldReplace = false;
      
      if (edge.priority !== null && edge.priority !== undefined) {
        if (existingChild.priority === null || existingChild.priority === undefined) {
          shouldReplace = true; // 新的有 priority，舊的沒有
        } else if (edge.priority < existingChild.priority) {
          shouldReplace = true; // 新的 priority 更小（優先級更高）
        } else if (edge.priority === existingChild.priority) {
          // priority 相同，比較 created_at
          const newCreatedAt = edge.created_at ? new Date(edge.created_at) : null;
          const existingCreatedAt = existingChild.created_at ? new Date(existingChild.created_at) : null;
          
          if (newCreatedAt && existingCreatedAt && newCreatedAt > existingCreatedAt) {
            shouldReplace = true; // 新的 created_at 更晚
          }
        }
      } else {
        // 新的沒有 priority
        if (existingChild.priority === null || existingChild.priority === undefined) {
          // 兩者都沒有 priority，比較 created_at
          const newCreatedAt = edge.created_at ? new Date(edge.created_at) : null;
          const existingCreatedAt = existingChild.created_at ? new Date(existingChild.created_at) : null;
          
          if (newCreatedAt && existingCreatedAt && newCreatedAt > existingCreatedAt) {
            shouldReplace = true; // 新的 created_at 更晚
          }
        }
        // 如果舊的有 priority，新的沒有，保留舊的（不替換）
      }
      
      if (shouldReplace) {
        const idx = edges.indexOf(existingChild);
        edges[idx] = edge; // 替換
      }
    }
  }
  
  return index;
}

/**
 * 遞迴展開 BOM
 * @param {Object} parentDemand - 父件需求 {material_code, plant_id, time_bucket, demand_qty, id}
 * @param {number} bomLevel - BOM 層級（從 1 開始）
 * @param {number} multiplier - 數量乘數（累積的 qty_per 乘積）
 * @param {Array} path - 展開路徑（用於循環檢測）[material_code, ...]
 * @param {Map} bomIndex - BOM 索引
 * @param {Map} componentDemandMap - Component 需求聚合 Map（key -> demand_qty）
 * @param {Array} traceRows - 追溯記錄陣列
 * @param {Array} errors - 錯誤陣列
 * @param {number} maxDepth - 最大遞迴深度（預設 50）
 * @param {string} fgMaterialCode - 原始 FG 料號（用於追溯）
 * @param {string} fgDemandId - 原始 FG 需求 ID（用於追溯）
 * @param {number} fgQty - 原始 FG 需求數量（用於追溯）
 * @param {string} sourceType - 需求來源類型（從 demand_fg 帶過來）
 * @param {string} sourceId - 需求來源 ID（從 demand_fg 帶過來）
 * @param {string} bomEdgeId - 當前 BOM edge 的 ID（用於追溯）
 */
function explodeBOM(
  parentDemand,
  bomLevel,
  multiplier,
  path,
  bomIndex,
  componentDemandMap,
  traceRows,
  errors,
  maxDepth = 50,
  fgMaterialCode,
  fgDemandId,
  fgQty,
  sourceType = null,
  sourceId = null,
  bomEdgeId = null
) {
  // 檢查最大深度
  if (bomLevel > maxDepth) {
    errors.push({
      type: 'MAX_DEPTH_EXCEEDED',
      message: `BOM 展開深度超過最大限制 (${maxDepth})`,
      material: parentDemand.material_code,
      path: [...path, parentDemand.material_code]
    });
    return;
  }
  
  // 檢查循環引用
  if (path.includes(parentDemand.material_code)) {
    errors.push({
      type: 'BOM_CYCLE',
      message: `檢測到 BOM 循環引用`,
      material: parentDemand.material_code,
      path: [...path, parentDemand.material_code]
    });
    return;
  }
  
  // 查找子件
  const children = bomIndex.get(parentDemand.material_code) || [];
  
  // ✅ 修正：不管有沒有子件，只要不是 FG（path.length > 0），就記錄需求
  // path.length = 0 表示這是 FG 本身，不需要記錄
  // path.length > 0 表示這是 Component（包括中間組裝件和葉節點），都需要記錄
  if (path.length > 0) {
    const key = getAggregationKey(
      parentDemand.plant_id,
      parentDemand.time_bucket,
      parentDemand.material_code
    );
    
    // 累加需求數量
    const currentQty = componentDemandMap.get(key) || 0;
    componentDemandMap.set(key, currentQty + parentDemand.demand_qty);
    
    // 記錄追溯資訊
    // path 包含從 FG 到當前 Component 的所有中間節點（不包含當前 Component）
    // 完整路徑應該是 [...path, parentDemand.material_code]
    // 例如：["FG-001", "SA-01", "COMP-10"]
    const fullPath = [...path, parentDemand.material_code];
    
    // bom_level: 當前 Component 在 BOM 中的層級
    // path.length 就是當前 Component 的 BOM level
    // 例如：FG 的直接子件 path.length = 1（Level 1）
    const componentBomLevel = path.length;
    
    // 注意：同一 FG->component 可能有多條路徑
    // 每條路徑都會產生一筆 trace 記錄
    traceRows.push({
      // 基本追溯資訊
      fg_material_code: fgMaterialCode,
      component_material_code: parentDemand.material_code,
      plant_id: parentDemand.plant_id,
      time_bucket: parentDemand.time_bucket,
      
      // 數量資訊
      fg_qty: fgQty, // 原始 FG 需求數量
      component_qty: parentDemand.demand_qty, // 此路徑對 Component 的貢獻量
      
      // 來源資訊（從 demand_fg 帶過來）
      source_type: sourceType,
      source_id: sourceId,
      
      // 路徑資訊（JSON array 格式）
      path_json: JSON.stringify(fullPath),
      
      // 額外資訊（用於寫入資料庫）
      fg_demand_id: fgDemandId,
      bom_edge_id: bomEdgeId,
      bom_level: componentBomLevel,
      qty_multiplier: multiplier
    });
  }
  
  // 如果有子件，繼續遞迴展開
  if (children.length > 0) {
    for (const childEdge of children) {
    // 計算子件數量（考慮 scrap/yield）
    // component_qty = parent_qty × qty_per × (1 + scrap_rate) / yield_rate
    // scrap_rate 為 null 時視為 0，yield_rate 為 null 時視為 1
    const scrapRate = childEdge.scrap_rate !== null && childEdge.scrap_rate !== undefined 
      ? childEdge.scrap_rate 
      : 0;
    const yieldRate = childEdge.yield_rate !== null && childEdge.yield_rate !== undefined 
      ? childEdge.yield_rate 
      : 1;
    
    // 計算數量並四捨五入到小數點 4 位
    const childQty = roundTo(
      parentDemand.demand_qty * childEdge.qty_per * (1 + scrapRate) / yieldRate,
      4
    );
    const newMultiplier = roundTo(
      multiplier * childEdge.qty_per * (1 + scrapRate) / yieldRate,
      4
    );
    
    // 建立子件需求物件
    const childDemand = {
      material_code: childEdge.child_material,
      plant_id: parentDemand.plant_id,
      time_bucket: parentDemand.time_bucket,
      demand_qty: childQty,
      id: null // 虛擬需求，用於遞迴
    };
    
    // 遞迴展開子件
    explodeBOM(
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
      sourceType, // 傳遞 source_type
      sourceId, // 傳遞 source_id
      childEdge.id // 傳遞 bom_edge_id
    );
    }
  }
}

/**
 * 執行 BOM Explosion 計算
 * @param {Array} demandFgRows - FG 需求陣列
 * @param {Array} bomEdgesRows - BOM 關係陣列
 * @param {Object} options - 選項
 * @param {number} options.maxDepth - 最大遞迴深度（預設 50）
 * @param {string} options.userId - 使用者 ID（用於輸出）
 * @param {string} options.batchId - 批次 ID（用於輸出）
 * @returns {Object} {componentDemandRows, traceRows, errors}
 */
export function calculateBomExplosion(demandFgRows, bomEdgesRows, options = {}) {
  const {
    maxDepth = 50,
    userId = null,
    batchId = null
  } = options;
  
  // 初始化結果
  const componentDemandMap = new Map(); // key -> demand_qty
  const traceRows = [];
  const errors = [];
  
  // 驗證輸入
  if (!demandFgRows || demandFgRows.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [{
        type: 'NO_INPUT',
        message: '沒有 FG 需求資料'
      }]
    };
  }
  
  if (!bomEdgesRows || bomEdgesRows.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [{
        type: 'NO_BOM',
        message: '沒有 BOM 關係資料'
      }]
    };
  }
  
  // ✅ 修正：移除 plant_id 一致性檢查，支援多工廠場景
  // 每個 FG 需求使用自己的 plant_id 進行 BOM 展開
  
  // 對每個 FG 需求進行展開
  for (const fgDemand of demandFgRows) {
    // 驗證必要欄位
    if (!fgDemand.material_code || !fgDemand.plant_id || !fgDemand.time_bucket || 
        fgDemand.demand_qty === undefined || fgDemand.demand_qty === null) {
      errors.push({
        type: 'INVALID_FG_DEMAND',
        message: 'FG 需求缺少必要欄位',
        fgDemand
      });
      continue;
    }
    
    // 將 time_bucket 轉換為日期（用於時效性過濾）
    const bucketDate = timeBucketToDate(fgDemand.time_bucket);
    
    if (!bucketDate) {
      errors.push({
        type: 'INVALID_TIME_BUCKET',
        message: `無法解析 time_bucket: ${fgDemand.time_bucket}`,
        fgDemand
      });
      continue;
    }
    
    // 建立 BOM 索引（根據當前 FG 的 plant_id 和 time_bucket）
    const bomIndex = buildBomIndex(bomEdgesRows, fgDemand.plant_id, bucketDate, errors);
    
    // 檢查是否有對應的 BOM 定義
    const hasBom = bomIndex.has(fgDemand.material_code);
    
    if (!hasBom) {
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
    explodeBOM(
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
      fgDemand.material_code, // fgMaterialCode
      fgDemand.id, // fgDemandId
      fgDemand.demand_qty, // fgQty
      fgDemand.source_type || null, // source_type（從 demand_fg 帶過來）
      fgDemand.source_id || null // source_id（從 demand_fg 帶過來）
    );
  }
  
  // 將聚合 Map 轉換為 componentDemandRows
  const componentDemandRows = [];
  for (const [key, demandQty] of componentDemandMap.entries()) {
    const { plantId: pId, timeBucket, materialCode } = parseAggregationKey(key);
    
    componentDemandRows.push({
      user_id: userId,
      batch_id: batchId,
      material_code: materialCode,
      plant_id: pId,
      time_bucket: timeBucket,
      demand_qty: demandQty,
      uom: 'pcs', // 預設單位
      notes: null
    });
  }
  
  return {
    componentDemandRows,
    traceRows,
    errors
  };
}

/**
 * 執行 BOM Explosion 並寫入資料庫
 * @param {string} userId - 使用者 ID
 * @param {string} batchId - 批次 ID（可選，如果不提供則自動建立）
 * @param {Array} demandFgRows - FG 需求陣列
 * @param {Array} bomEdgesRows - BOM 關係陣列
 * @param {Object} options - 選項
 * @param {string} options.filename - 檔案名稱（用於記錄）
 * @param {Object} options.metadata - 額外元數據
 * @returns {Promise<Object>} {success, componentDemandCount, traceCount, errors, batchId}
 */
export async function executeBomExplosion(userId, batchId, demandFgRows, bomEdgesRows, options = {}) {
  const { componentDemandService, componentDemandTraceService } = await import('./supabaseClient');
  const { importBatchesService } = await import('./importHistoryService');
  
  const filename = options.filename || 'BOM Explosion Calculation';
  const metadata = options.metadata || {};
  
  // Step 1: 如果沒有提供 batchId，建立新的 import_batch 記錄
  let actualBatchId = batchId;
  let batchRecord = null;
  
  if (!actualBatchId) {
    try {
      batchRecord = await importBatchesService.createBatch(userId, {
        uploadType: 'bom_explosion',
        filename: filename,
        targetTable: 'bom_explosion',
        totalRows: demandFgRows.length,
        metadata: {
          ...metadata,
          fg_demands_count: demandFgRows.length,
          bom_edges_count: bomEdgesRows.length,
          started_at: new Date().toISOString()
        }
      });
      actualBatchId = batchRecord.id;
      console.log('Created batch record:', actualBatchId);
    } catch (error) {
      console.error('Failed to create batch record:', error);
      // 即使建立 batch 失敗，仍然繼續執行計算（但不會有 undo 功能）
    }
  }
  
  // Step 2: 執行計算
  const result = calculateBomExplosion(demandFgRows, bomEdgesRows, {
    ...options,
    userId,
    batchId: actualBatchId
  });
  
  // 如果有錯誤，記錄但不中斷
  if (result.errors.length > 0) {
    console.warn('BOM Explosion 計算過程中有錯誤：', result.errors);
  }
  
  // Step 3: 寫入 component_demand
  let componentDemandCount = 0;
  let componentDemandIdMap = new Map();
  
  if (result.componentDemandRows.length > 0) {
    try {
      const insertResult = await componentDemandService.upsertComponentDemand(result.componentDemandRows);
      componentDemandCount = insertResult.count || result.componentDemandRows.length;
      
      // 建立 material_code + plant_id + time_bucket -> id 的映射
      if (insertResult.data && insertResult.data.length > 0) {
        for (const cd of insertResult.data) {
          const key = getAggregationKey(cd.plant_id, cd.time_bucket, cd.material_code);
          componentDemandIdMap.set(key, cd.id);
        }
      } else {
        // 如果沒有返回 data，需要查詢
        const componentDemands = await componentDemandService.getComponentDemands(userId, {
          limit: 10000
        });
        for (const cd of componentDemands) {
          const key = getAggregationKey(cd.plant_id, cd.time_bucket, cd.material_code);
          componentDemandIdMap.set(key, cd.id);
        }
      }
    } catch (error) {
      console.error('寫入 component_demand 失敗：', error);
      result.errors.push({
        type: 'DATABASE_ERROR',
        message: '寫入 component_demand 失敗',
        error: error.message
      });
    }
  }
  
  // Step 4: 寫入 component_demand_trace
  let traceCount = 0;
  if (result.traceRows.length > 0 && componentDemandIdMap.size > 0) {
    try {
      // 轉換 traceRows 為資料庫格式
      const tracePayload = [];
      const missingMappings = [];
      
      for (const trace of result.traceRows) {
        const key = getAggregationKey(trace.plant_id, trace.time_bucket, trace.component_material_code);
        const componentDemandId = componentDemandIdMap.get(key);
        
        if (componentDemandId) {
          // 解析 path_json（如果是字串）為 JSON array
          let pathArray = [];
          try {
            pathArray = typeof trace.path_json === 'string' 
              ? JSON.parse(trace.path_json) 
              : trace.path_json || [];
          } catch (parseError) {
            console.error(`Failed to parse path_json for trace:`, {
              component_material_code: trace.component_material_code,
              path_json: trace.path_json,
              error: parseError.message
            });
            pathArray = [];
          }
          
          // 構造符合 DB schema 的 payload
          tracePayload.push({
            user_id: userId,
            batch_id: actualBatchId,
            component_demand_id: componentDemandId,
            fg_demand_id: trace.fg_demand_id || null,
            bom_edge_id: trace.bom_edge_id || null,
            qty_multiplier: trace.qty_multiplier || (trace.component_qty / trace.fg_qty),
            bom_level: trace.bom_level || null,
            // 額外追溯信息存入 trace_meta (JSONB)
            trace_meta: {
              path: pathArray, // JSON array，不是字串
              fg_material_code: trace.fg_material_code || null,
              component_material_code: trace.component_material_code || null,
              plant_id: trace.plant_id || null,
              time_bucket: trace.time_bucket || null,
              fg_qty: trace.fg_qty || null,
              component_qty: trace.component_qty || null,
              source_type: trace.source_type || null,
              source_id: trace.source_id || null
            }
          });
        } else {
          missingMappings.push({
            component_material_code: trace.component_material_code,
            plant_id: trace.plant_id,
            time_bucket: trace.time_bucket,
            aggregation_key: key
          });
        }
      }
      
      // 記錄找不到映射的警告
      if (missingMappings.length > 0) {
        const errorMsg = `找不到 ${missingMappings.length} 筆 component_demand_id 映射`;
        console.error(errorMsg, {
          sample: missingMappings.slice(0, 5),
          total: missingMappings.length
        });
        result.errors.push({
          type: 'MAPPING_ERROR',
          message: errorMsg,
          details: {
            count: missingMappings.length,
            sample: missingMappings.slice(0, 5)
          }
        });
      }
      
      if (tracePayload.length > 0) {
        const insertResult = await componentDemandTraceService.insertComponentDemandTrace(tracePayload);
        traceCount = insertResult.count || tracePayload.length;
      }
    } catch (error) {
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
      console.error('寫入 component_demand_trace 失敗：', errorDetails);
      result.errors.push({
        type: 'DATABASE_ERROR',
        message: '寫入 component_demand_trace 失敗',
        error: errorDetails
      });
    }
  }
  
  // Step 5: 更新 batch 狀態為 completed
  if (actualBatchId && batchRecord) {
    try {
      await importBatchesService.updateBatch(actualBatchId, {
        status: 'completed',
        successRows: componentDemandCount,
        errorRows: result.errors.length,
        metadata: {
          ...metadata,
          fg_demands_count: demandFgRows.length,
          bom_edges_count: bomEdgesRows.length,
          component_demand_count: componentDemandCount,
          component_demand_trace_count: traceCount,
          errors_count: result.errors.length,
          completed_at: new Date().toISOString()
        }
      });
      console.log('Updated batch status to completed');
    } catch (error) {
      console.error('Failed to update batch status:', error);
    }
  }
  
  return {
    success: result.errors.length === 0,
    componentDemandCount,
    traceCount,
    errors: result.errors,
    batchId: actualBatchId
  };
}
