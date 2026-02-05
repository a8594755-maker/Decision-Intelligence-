/**
 * Ingest RPC Service
 * 提供高效能、交易性的批次資料寫入 API（透過 Supabase RPC）
 * 
 * 特性：
 * - Transaction 保證（全部成功或全部回滾）
 * - Idempotency（基於 batch_id）
 * - 自動處理 supplier/material 查找或建立
 * - Fallback 機制（若 RPC 失敗則回退到舊 API）
 */

import { supabase } from './supabaseClient';

/**
 * 批次資料大小限制
 * - 建議每次 RPC 呼叫處理 500-1000 筆資料
 * - Supabase RPC 預設 payload limit: 1-2 MB
 */
const MAX_ROWS_PER_BATCH = 1000;

/**
 * RPC 呼叫錯誤類型
 */
export class RpcError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 批次資料過大錯誤
 */
export class BatchSizeError extends Error {
  constructor(rowCount, maxRows = MAX_ROWS_PER_BATCH) {
    super(`批次資料過大：${rowCount} 筆 (上限 ${maxRows} 筆)。請分檔上傳或聯繫系統管理員。`);
    this.name = 'BatchSizeError';
    this.rowCount = rowCount;
    this.maxRows = maxRows;
  }
}

/**
 * 批次寫入收貨記錄（Goods Receipts）
 * 
 * @param {Object} params - 參數物件
 * @param {string} params.batchId - 批次 ID（UUID）
 * @param {string} params.uploadFileId - 上傳檔案 ID（UUID）
 * @param {Array<Object>} params.rows - 資料陣列（canonical keys）
 * @param {Object} params.rows[].material_code - 物料代碼（必填）
 * @param {Object} params.rows[].supplier_name - 供應商名稱（必填 if no supplier_code）
 * @param {Object} params.rows[].actual_delivery_date - 實際交期（必填）
 * @param {Object} params.rows[].received_qty - 收貨數量（必填）
 * @param {number} params.maxRows - 最大行數限制（預設 1000）
 * 
 * @returns {Promise<Object>} RPC 回傳結果
 * @returns {boolean} .success - 是否成功
 * @returns {number} .inserted_count - 插入的記錄數量
 * @returns {number} .suppliers_created - 新建立的 supplier 數量
 * @returns {number} .suppliers_found - 找到的現有 supplier 數量
 * @returns {number} .materials_upserted - Upsert 的 material 數量
 * @returns {string} .batch_id - 批次 ID
 * @returns {string} .upload_file_id - 上傳檔案 ID
 * 
 * @throws {BatchSizeError} 若 rows.length > maxRows
 * @throws {RpcError} 若 RPC 呼叫失敗
 * 
 * @example
 * try {
 *   const result = await ingestGoodsReceiptsRpc({
 *     batchId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
 *     uploadFileId: '11111111-2222-3333-4444-555555555555',
 *     rows: validationResult.validRows
 *   });
 *   console.log(`成功插入 ${result.inserted_count} 筆記錄`);
 * } catch (error) {
 *   if (error instanceof BatchSizeError) {
 *     // 提示使用者分檔上傳
 *   } else if (error instanceof RpcError) {
 *     // Fallback 到舊 API
 *   }
 * }
 */
export async function ingestGoodsReceiptsRpc({ 
  batchId, 
  uploadFileId, 
  rows,
  maxRows = MAX_ROWS_PER_BATCH
}) {
  // ===== 驗證參數 =====
  if (!batchId) {
    throw new Error('batchId is required');
  }
  if (!uploadFileId) {
    throw new Error('uploadFileId is required');
  }
  if (!rows || !Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }

  // ===== 檢查批次大小 =====
  if (rows.length > maxRows) {
    throw new BatchSizeError(rows.length, maxRows);
  }

  console.log(`[ingestGoodsReceiptsRpc] Starting RPC call for ${rows.length} rows`);
  console.log(`[ingestGoodsReceiptsRpc] batchId: ${batchId}, uploadFileId: ${uploadFileId}`);

  // TODO: Staging + Finalize 機制（Phase 3）
  // 若需要處理 > 1000 rows：
  // 1. 分批寫入 staging table
  // 2. 最後呼叫 finalize RPC 完成 transaction

  try {
    // ===== 呼叫 Supabase RPC =====
    const { data, error } = await supabase.rpc('ingest_goods_receipts_v1', {
      p_batch_id: batchId,
      p_upload_file_id: uploadFileId,
      p_rows: rows // 直接傳 validRows（必須是 canonical keys）
    });

    // ===== 錯誤處理 =====
    if (error) {
      console.error('[ingestGoodsReceiptsRpc] RPC Error:', error);
      throw new RpcError(
        `RPC 呼叫失敗: ${error.message || JSON.stringify(error)}`,
        error.code,
        error.details || error
      );
    }

    // ===== 驗證回傳資料 =====
    if (!data || typeof data !== 'object') {
      throw new RpcError(
        'RPC 回傳資料格式錯誤（預期 JSONB 物件）',
        'INVALID_RESPONSE',
        data
      );
    }

    if (!data.success) {
      throw new RpcError(
        'RPC 執行失敗（success = false）',
        'RPC_EXECUTION_FAILED',
        data
      );
    }

    console.log('[ingestGoodsReceiptsRpc] Success:', {
      inserted: data.inserted_count,
      suppliersCreated: data.suppliers_created,
      suppliersFound: data.suppliers_found,
      materialsUpserted: data.materials_upserted
    });

    return data;

  } catch (error) {
    // 若已是 RpcError，直接拋出
    if (error instanceof RpcError || error instanceof BatchSizeError) {
      throw error;
    }

    // 其他未預期的錯誤
    console.error('[ingestGoodsReceiptsRpc] Unexpected error:', error);
    throw new RpcError(
      `未預期的錯誤: ${error.message}`,
      'UNEXPECTED_ERROR',
      error
    );
  }
}

/**
 * 批次寫入價格歷史（Price History）
 * 
 * @param {Object} params - 參數物件
 * @param {string} params.batchId - 批次 ID（UUID）
 * @param {string} params.uploadFileId - 上傳檔案 ID（UUID）
 * @param {Array<Object>} params.rows - 資料陣列（canonical keys）
 * @param {Object} params.rows[].material_code - 物料代碼（必填）
 * @param {Object} params.rows[].supplier_name - 供應商名稱（必填 if no supplier_code）
 * @param {Object} params.rows[].order_date - 訂單日期（必填）
 * @param {Object} params.rows[].unit_price - 單價（必填）
 * @param {number} params.maxRows - 最大行數限制（預設 1000）
 * 
 * @returns {Promise<Object>} RPC 回傳結果（同 ingestGoodsReceiptsRpc）
 * @throws {BatchSizeError} 若 rows.length > maxRows
 * @throws {RpcError} 若 RPC 呼叫失敗
 */
export async function ingestPriceHistoryRpc({ 
  batchId, 
  uploadFileId, 
  rows,
  maxRows = MAX_ROWS_PER_BATCH
}) {
  // ===== 驗證參數 =====
  if (!batchId) {
    throw new Error('batchId is required');
  }
  if (!uploadFileId) {
    throw new Error('uploadFileId is required');
  }
  if (!rows || !Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }

  // ===== 檢查批次大小 =====
  if (rows.length > maxRows) {
    throw new BatchSizeError(rows.length, maxRows);
  }

  console.log(`[ingestPriceHistoryRpc] Starting RPC call for ${rows.length} rows`);
  console.log(`[ingestPriceHistoryRpc] batchId: ${batchId}, uploadFileId: ${uploadFileId}`);

  // TODO: Staging + Finalize 機制（Phase 3）

  try {
    // ===== 呼叫 Supabase RPC =====
    const { data, error } = await supabase.rpc('ingest_price_history_v1', {
      p_batch_id: batchId,
      p_upload_file_id: uploadFileId,
      p_rows: rows // 直接傳 validRows（必須是 canonical keys）
    });

    // ===== 錯誤處理 =====
    if (error) {
      console.error('[ingestPriceHistoryRpc] RPC Error:', error);
      throw new RpcError(
        `RPC 呼叫失敗: ${error.message || JSON.stringify(error)}`,
        error.code,
        error.details || error
      );
    }

    // ===== 驗證回傳資料 =====
    if (!data || typeof data !== 'object') {
      throw new RpcError(
        'RPC 回傳資料格式錯誤（預期 JSONB 物件）',
        'INVALID_RESPONSE',
        data
      );
    }

    if (!data.success) {
      throw new RpcError(
        'RPC 執行失敗（success = false）',
        'RPC_EXECUTION_FAILED',
        data
      );
    }

    console.log('[ingestPriceHistoryRpc] Success:', {
      inserted: data.inserted_count,
      suppliersCreated: data.suppliers_created,
      suppliersFound: data.suppliers_found,
      materialsUpserted: data.materials_upserted
    });

    return data;

  } catch (error) {
    // 若已是 RpcError，直接拋出
    if (error instanceof RpcError || error instanceof BatchSizeError) {
      throw error;
    }

    // 其他未預期的錯誤
    console.error('[ingestPriceHistoryRpc] Unexpected error:', error);
    throw new RpcError(
      `未預期的錯誤: ${error.message}`,
      'UNEXPECTED_ERROR',
      error
    );
  }
}

/**
 * 檢查 RPC 是否可用（健康檢查）
 * 
 * @returns {Promise<boolean>} RPC 是否可用
 */
export async function checkRpcHealth() {
  try {
    // 嘗試呼叫一個簡單的測試（空資料）
    const { error } = await supabase.rpc('ingest_goods_receipts_v1', {
      p_batch_id: '00000000-0000-0000-0000-000000000000',
      p_upload_file_id: '00000000-0000-0000-0000-000000000000',
      p_rows: []
    });

    // 若 function 不存在，error.code 會是 '42883' (undefined_function)
    if (error && error.code === '42883') {
      console.warn('[checkRpcHealth] RPC function not found (未部署或名稱錯誤)');
      return false;
    }

    // 其他錯誤（如權限問題）也視為不可用
    if (error) {
      console.warn('[checkRpcHealth] RPC health check failed:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.warn('[checkRpcHealth] Unexpected error:', error);
    return false;
  }
}

/**
 * Export 所有錯誤類型（方便前端 catch 判斷）
 */
export { MAX_ROWS_PER_BATCH };
