/**
 * BOM Explosion Service
 * BOM 展開服務 - 將 FG 需求展開為 Component 需求
 * 
 * 此檔案是 Service 層，負責：
 * - 呼叫 Edge Function 執行耗時計算
 * - 輪詢 job 狀態
 * - 提供 fallback 本地計算
 * 
 * Edge Function 端點: /functions/v1/bom-explosion
 */

// Feature flag: 使用 Edge Function (true) 或本地計算 (false)
const USE_EDGE_FUNCTION = true;

// Import Domain layer functions (for fallback)
import {
  explodeBOM as domainExplodeBOM,
  getAggregationKey,
  parseAggregationKey
} from '../domains/forecast/bomCalculator.js';

import { supabase } from './supabaseClient';

/**
 * 透過 Edge Function 執行 BOM Explosion
 * 兩段式流程: 1) 啟動 job 2) 輪詢狀態
 * 
 * @param {Object} options - 選項
 * @param {string} options.plantId - 工廠篩選
 * @param {string[]} options.timeBuckets - 時間區間篩選
 * @param {string} options.demandSource - 'demand_fg' | 'demand_forecast'
 * @param {string} options.demandForecastRunId - Demand forecast run ID (若 demandSource = demand_forecast)
 * @param {string} options.inboundSource - Inbound 來源
 * @param {string} options.supplyForecastRunId - Supply forecast run ID
 * @param {string} options.scenarioName - 情境名稱
 * @param {Object} options.metadata - 額外元數據
 * @returns {Promise<Object>} {success, batchId, forecastRunId, status, message}
 */
export async function executeBomExplosion(options = {}) {
  // 若關閉 Edge Function，使用 legacy 本地計算
  if (!USE_EDGE_FUNCTION) {
    return _executeBomExplosionLegacyPlaceholder(options);
  }

  try {
    // Step 1: 呼叫 Edge Function 啟動 job
    const { data, error } = await supabase.functions.invoke('bom-explosion', {
      body: {
        plantId: options.metadata?.plant_id,
        timeBuckets: options.metadata?.time_buckets,
        demandSource: options.demandSource || 'demand_fg',
        demandForecastRunId: options.inputDemandForecastRunId,
        inboundSource: options.inboundSource,
        supplyForecastRunId: options.inputSupplyForecastRunId,
        scenarioName: options.scenarioName || 'baseline',
        metadata: options.metadata || {},
        forceNewRun: options.forceNewRun || false
      }
    });

    if (error) {
      console.error('Edge Function invocation failed:', error);
      // 尝试提取详细的错误信息
      let errorDetails = error.message;
      if (error.context && error.context.response) {
        try {
          const responseData = await error.context.response.json();
          errorDetails = JSON.stringify(responseData, null, 2);
        } catch (e) {
          // 如果不是 JSON，使用原始消息
        }
      }
      throw new Error(`Edge Function 呼叫失敗: ${errorDetails}`);
    }

    // 立即回傳 job 資訊，前端需要開始輪詢
    return {
      success: true,
      batchId: data.batchId,
      forecastRunId: data.forecastRunId,
      status: data.status,
      message: data.message,
      // 標記這是 Edge Function 模式，前端需要輪詢
      requiresPolling: true
    };

  } catch (error) {
    console.error('BOM Explosion Edge Function 啟動失敗:', error);
    
    // 若 Edge Function 失敗，可選擇 fallback 到本地計算
    // return _executeBomExplosionLegacyPlaceholder(options);
    
    throw error;
  }
}

/**
 * 輪詢 BOM Explosion 計算狀態
 * 
 * @param {string} batchId - 批次 ID
 * @param {Object} callbacks - 回調函數
 * @param {Function} callbacks.onProgress - 進度更新回調 (status, metadata)
 * @param {Function} callbacks.onComplete - 完成回調 (result)
 * @param {Function} callbacks.onError - 錯誤回調 (error)
 * @param {number} maxAttempts - 最大輪詢次數 (預設 60 次 = 2 分鐘)
 * @param {number} intervalMs - 輪詢間隔 (預設 2000ms)
 * @returns {Promise<Object>} 最終結果
 */
export async function pollBomExplosionStatus(
  batchId,
  callbacks = {},
  maxAttempts = 60,
  intervalMs = 2000
) {
  const { onProgress, onComplete, onError } = callbacks;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data, error } = await supabase
        .from('import_batches')
        .select('status, metadata, error_message')
        .eq('id', batchId)
        .single();

      if (error) {
        throw new Error(`查詢 batch 狀態失敗: ${error.message}`);
      }

      if (!data) {
        throw new Error(`找不到 batch: ${batchId}`);
      }

      // 呼叫進度回調
      if (onProgress) {
        onProgress(data.status, data.metadata);
      }

      // 根據狀態處理
      switch (data.status) {
        case 'completed': {
          const result = {
            success: true,
            batchId,
            forecastRunId: data.metadata?.forecast_run_id,
            componentDemandCount: data.metadata?.component_demand_count || 0,
            traceCount: data.metadata?.component_demand_trace_count || 0,
            errors: data.metadata?.errors || [],
            metadata: data.metadata
          };
          
          if (onComplete) {
            onComplete(result);
          }
          
          return result;
        }

        case 'failed': {
          const errorMsg = data.error_message || data.metadata?.error || '計算失敗';
          const error = new Error(errorMsg);
          
          if (onError) {
            onError(error);
          }
          
          return {
            success: false,
            batchId,
            error: errorMsg,
            metadata: data.metadata
          };
        }

        case 'running':
        case 'pending':
          // 繼續輪詢
          break;

        default:
          throw new Error(`未知的 batch 狀態: ${data.status}`);
      }

      // 等待後重試
      await new Promise(resolve => setTimeout(resolve, intervalMs));

    } catch (error) {
      console.error(`輪詢失敗 (attempt ${attempt + 1}/${maxAttempts}):`, error);
      
      if (attempt === maxAttempts - 1) {
        const timeoutError = new Error(`輪詢超時: ${error.message}`);
        if (onError) {
          onError(timeoutError);
        }
        throw timeoutError;
      }
      
      // 短暫等待後重試
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  const timeoutError = new Error(`輪詢超時: 已達最大嘗試次數 ${maxAttempts}`);
  if (onError) {
    onError(timeoutError);
  }
  throw timeoutError;
}

/**
 * Legacy: 本地執行 BOM Explosion (保留作為 fallback)
 * @deprecated 請使用 executeBomExplosion + Edge Function
 */
async function _executeBomExplosionLegacyPlaceholder(options = {}) {
  // 這是原有的本地計算邏輯，保留但不直接使用
  // 需要時可從 options 中提取舊版參數並呼叫
  console.warn('使用 legacy 本地計算模式');
  throw new Error('Legacy mode not implemented in this refactor');
}

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
export async function executeBomExplosionLegacy(userId, batchId, demandFgRows, bomEdgesRows, options = {}) {
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
      kind: 'bom_explosion'
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
