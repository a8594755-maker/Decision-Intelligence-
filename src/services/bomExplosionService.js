/**
 * BOM Explosion Service
 * BOM 展開服務 - 將 FG 需求展開為 Component 需求
 * 
 * 此檔案是 Service 層，負責：
 * - 整合 Domain 層的計算邏輯
 * - 與資料庫互動（讀取/寫入）
 * - 批次管理
 * 
 * 核心計算邏輯已移至 Domain 層：
 * @see src/domains/forecast/bomCalculator.js
 */

// Import Domain layer functions
import {
  explodeBOM as domainExplodeBOM,
  getAggregationKey,
  parseAggregationKey
} from '../domains/forecast/bomCalculator.js';

/**
 * 執行 BOM Explosion 計算
 * 
 * 此函數是對 Domain 層 explodeBOM 的包裝，保持向後兼容
 * 
 * @deprecated 建議直接使用 Domain 層的 explodeBOM 函數
 * @param {Array} demandFgRows - FG 需求陣列
 * @param {Array} bomEdgesRows - BOM 關係陣列
 * @param {Object} options - 選項
 * @returns {Object} {componentDemandRows, traceRows, errors}
 */
export function calculateBomExplosion(demandFgRows, bomEdgesRows, options = {}) {
  // 直接調用 Domain 層函數
  return domainExplodeBOM(demandFgRows, bomEdgesRows, options);
}

/**
 * 執行 BOM Explosion 並寫入資料庫
 * 
 * 此函數負責：
 * 1. 建立批次記錄
 * 2. 調用 Domain 層計算
 * 3. 寫入資料庫
 * 4. 更新批次狀態
 * 
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
  const { componentDemandService, componentDemandTraceService, forecastRunsService } = await import('./supabaseClient');
  const { importBatchesService } = await import('./importHistoryService');

  const filename = options.filename || 'BOM Explosion Calculation';
  const metadata = options.metadata || {};

  // 收集 input batch_ids（用於 forecast_runs 追溯）
  const demandBatchIds = [...new Set((demandFgRows || []).map(r => r.batch_id).filter(Boolean))];
  const bomBatchIds = [...new Set((bomEdgesRows || []).map(r => r.batch_id).filter(Boolean))];
  const inputBatchIds = [...demandBatchIds, ...bomBatchIds];

  // Step 1: 建立 forecast_run（版本化：每次執行一筆 run）
  let forecastRunId = null;
  try {
    const runRow = await forecastRunsService.createRun(userId, {
      scenarioName: options.scenarioName || 'baseline',
      parameters: {
        time_buckets: metadata.time_buckets,
        plant_id: metadata.plant_id,
        // Run-level traceability for P0-2
        demand_source: options.demandSource || 'uploaded',
        input_demand_forecast_run_id: options.inputDemandForecastRunId || null,
        ...(options.parameters || {})
      },
      inputBatchIds
    });
    forecastRunId = runRow.id;
    console.log('Created forecast_run:', forecastRunId);
  } catch (error) {
    console.error('Failed to create forecast_run (continuing without run_id):', error);
  }

  // Step 2: 如果沒有提供 batchId，建立新的 import_batch 記錄
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
          started_at: new Date().toISOString(),
          forecast_run_id: forecastRunId
        }
      });
      actualBatchId = batchRecord.id;
      console.log('Created batch record:', actualBatchId);
    } catch (error) {
      console.error('Failed to create batch record:', error);
    }
  }

  // Step 3: 執行計算（調用 Domain 層）
  const result = calculateBomExplosion(demandFgRows, bomEdgesRows, {
    ...options,
    userId,
    batchId: actualBatchId
  });
  
  if (result.errors.length > 0) {
    console.warn('BOM Explosion 計算過程中有錯誤：', result.errors);
  }

  // Step 4: 寫入 component_demand（帶入 forecast_run_id）
  let componentDemandCount = 0;
  let componentDemandIdMap = new Map();
  const rowsWithRunId = (result.componentDemandRows || []).map(r => ({
    ...r,
    batch_id: actualBatchId,
    forecast_run_id: forecastRunId
  }));

  if (rowsWithRunId.length > 0) {
    try {
      const insertResult = await componentDemandService.upsertComponentDemand(rowsWithRunId);
      componentDemandCount = insertResult.count || rowsWithRunId.length;
      
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
  
  // Step 5: 寫入 component_demand_trace（帶入 forecast_run_id）
  let traceCount = 0;
  if (result.traceRows.length > 0 && componentDemandIdMap.size > 0) {
    try {
      const tracePayload = [];
      const missingMappings = [];

      for (const trace of result.traceRows) {
        const key = getAggregationKey(trace.plant_id, trace.time_bucket, trace.component_material_code);
        const componentDemandId = componentDemandIdMap.get(key);

        if (componentDemandId) {
          const pathArray = trace.path || [];

          tracePayload.push({
            user_id: userId,
            batch_id: actualBatchId,
            forecast_run_id: forecastRunId,
            component_demand_id: componentDemandId,
            fg_demand_id: trace.fg_demand_id || null,
            bom_edge_id: trace.bom_edge_id || null,
            qty_multiplier: trace.qty_multiplier || (trace.component_qty / trace.fg_qty),
            bom_level: trace.bom_level || null,
            // 額外追溯信息存入 trace_meta (JSONB)
            trace_meta: {
              path: pathArray, // JSON array
              fg_material_code: trace.fg_material_code || null,
              component_material_code: trace.component_material_code || null,
              plant_id: trace.plant_id || null,
              time_bucket: trace.time_bucket || null,
              fg_qty: trace.fg_qty || null,
              component_qty: trace.component_qty || null,
              source_type: trace.source_type || null,
              source_id: trace.source_id || null,
              source_fg_demand_id: trace.fg_demand_id || null // P0-3: explicit traceability
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
  
  // Step 6: 更新 batch 狀態為 completed
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
    batchId: actualBatchId,
    forecastRunId
  };
}
