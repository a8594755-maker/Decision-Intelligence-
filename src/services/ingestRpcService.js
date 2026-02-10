/**
 * Ingest RPC Service
 * Provides high-performance, transactional batch data write API (via Supabase RPC)
 * 
 * Features:
 * - Transaction guarantee (all succeed or all rollback)
 * - Idempotency (based on batch_id)
 * - Auto supplier/material lookup or creation
 * - Fallback mechanism (falls back to legacy API if RPC fails)
 */

import { supabase } from './supabaseClient';

/**
 * Batch data size limit
 * - Recommended 500-1000 rows per RPC call
 * - Supabase RPC default payload limit: 1-2 MB
 */
const MAX_ROWS_PER_BATCH = 50000;

/**
 * RPC call error type
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
 * Batch data too large error
 */
export class BatchSizeError extends Error {
  constructor(rowCount, maxRows = MAX_ROWS_PER_BATCH) {
    super(`Batch data too large: ${rowCount} rows (limit ${maxRows} rows). Please split the file or contact system administrator.`);
    this.name = 'BatchSizeError';
    this.rowCount = rowCount;
    this.maxRows = maxRows;
  }
}

/**
 * Batch write Goods Receipts
 * 
 * @param {Object} params - Parameter object
 * @param {string} params.batchId - Batch ID (UUID)
 * @param {string} params.uploadFileId - Upload file ID (UUID)
 * @param {Array<Object>} params.rows - Data array (canonical keys)
 * @param {Object} params.rows[].material_code - Material code (required)
 * @param {Object} params.rows[].supplier_name - Supplier name (required if no supplier_code)
 * @param {Object} params.rows[].actual_delivery_date - Actual delivery date (required)
 * @param {Object} params.rows[].received_qty - Received quantity (required)
 * @param {number} params.maxRows - Max row limit (default 1000)
 * 
 * @returns {Promise<Object>} RPC return result
 * @returns {boolean} .success - Whether successful
 * @returns {number} .inserted_count - Number of inserted records
 * @returns {number} .suppliers_created - Number of newly created suppliers
 * @returns {number} .suppliers_found - Number of existing suppliers found
 * @returns {number} .materials_upserted - Number of upserted materials
 * @returns {string} .batch_id - Batch ID
 * @returns {string} .upload_file_id - Upload file ID
 * 
 * @throws {BatchSizeError} If rows.length > maxRows
 * @throws {RpcError} If RPC call fails
 * 
 * @example
 * try {
 *   const result = await ingestGoodsReceiptsRpc({
 *     batchId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
 *     uploadFileId: '11111111-2222-3333-4444-555555555555',
 *     rows: validationResult.validRows
 *   });
 *   console.log(`Successfully inserted ${result.inserted_count} records`);
 * } catch (error) {
 *   if (error instanceof BatchSizeError) {
 *     // Prompt user to split file upload
 *   } else if (error instanceof RpcError) {
 *     // Fallback to legacy API
 *   }
 * }
 */
export async function ingestGoodsReceiptsRpc({ 
  batchId, 
  uploadFileId, 
  rows,
  maxRows = MAX_ROWS_PER_BATCH
}) {
  // ===== Validate parameters =====
  if (!batchId) {
    throw new Error('batchId is required');
  }
  if (!uploadFileId) {
    throw new Error('uploadFileId is required');
  }
  if (!rows || !Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }

  // ===== Check batch size =====
  if (rows.length > maxRows) {
    throw new BatchSizeError(rows.length, maxRows);
  }

  console.log(`[ingestGoodsReceiptsRpc] Starting RPC call for ${rows.length} rows`);
  console.log(`[ingestGoodsReceiptsRpc] batchId: ${batchId}, uploadFileId: ${uploadFileId}`);

  // TODO: Staging + Finalize mechanism (Phase 3)
  // If need to handle > 1000 rows:
  // 1. Write to staging table in batches
  // 2. Call finalize RPC to complete transaction

  try {
    // ===== Call Supabase RPC =====
    const { data, error } = await supabase.rpc('ingest_goods_receipts_v1', {
      p_batch_id: batchId,
      p_upload_file_id: uploadFileId,
      p_rows: rows // Pass validRows directly (must be canonical keys)
    });

    // ===== Error handling =====
    if (error) {
      console.error('[ingestGoodsReceiptsRpc] RPC Error:', error);
      throw new RpcError(
        `RPC call failed: ${error.message || JSON.stringify(error)}`,
        error.code,
        error.details || error
      );
    }

    // ===== Validate response data =====
    if (!data || typeof data !== 'object') {
      throw new RpcError(
        'RPC response format error (expected JSONB object)',
        'INVALID_RESPONSE',
        data
      );
    }

    if (!data.success) {
      throw new RpcError(
        'RPC execution failed (success = false)',
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
    // If already RpcError, throw directly
    if (error instanceof RpcError || error instanceof BatchSizeError) {
      throw error;
    }

    // Other unexpected errors
    console.error('[ingestGoodsReceiptsRpc] Unexpected error:', error);
    throw new RpcError(
      `Unexpected error: ${error.message}`,
      'UNEXPECTED_ERROR',
      error
    );
  }
}

/**
 * Batch write Price History
 * 
 * @param {Object} params - Parameter object
 * @param {string} params.batchId - Batch ID (UUID)
 * @param {string} params.uploadFileId - Upload file ID (UUID)
 * @param {Array<Object>} params.rows - Data array (canonical keys)
 * @param {Object} params.rows[].material_code - Material code (required)
 * @param {Object} params.rows[].supplier_name - Supplier name (required if no supplier_code)
 * @param {Object} params.rows[].order_date - Order date (required)
 * @param {Object} params.rows[].unit_price - Unit price (required)
 * @param {number} params.maxRows - Max row limit (default 1000)
 * 
 * @returns {Promise<Object>} RPC return result (same as ingestGoodsReceiptsRpc)
 * @throws {BatchSizeError} If rows.length > maxRows
 * @throws {RpcError} If RPC call fails
 */
export async function ingestPriceHistoryRpc({ 
  batchId, 
  uploadFileId, 
  rows,
  maxRows = MAX_ROWS_PER_BATCH
}) {
  // ===== Validate parameters =====
  if (!batchId) {
    throw new Error('batchId is required');
  }
  if (!uploadFileId) {
    throw new Error('uploadFileId is required');
  }
  if (!rows || !Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }

  // ===== Check batch size =====
  if (rows.length > maxRows) {
    throw new BatchSizeError(rows.length, maxRows);
  }

  console.log(`[ingestPriceHistoryRpc] Starting RPC call for ${rows.length} rows`);
  console.log(`[ingestPriceHistoryRpc] batchId: ${batchId}, uploadFileId: ${uploadFileId}`);

  // TODO: Staging + Finalize mechanism (Phase 3)

  try {
    // ===== Call Supabase RPC =====
    const { data, error } = await supabase.rpc('ingest_price_history_v1', {
      p_batch_id: batchId,
      p_upload_file_id: uploadFileId,
      p_rows: rows // Pass validRows directly (must be canonical keys)
    });

    // ===== Error handling =====
    if (error) {
      console.error('[ingestPriceHistoryRpc] RPC Error:', error);
      throw new RpcError(
        `RPC call failed: ${error.message || JSON.stringify(error)}`,
        error.code,
        error.details || error
      );
    }

    // ===== Validate response data =====
    if (!data || typeof data !== 'object') {
      throw new RpcError(
        'RPC response format error (expected JSONB object)',
        'INVALID_RESPONSE',
        data
      );
    }

    if (!data.success) {
      throw new RpcError(
        'RPC execution failed (success = false)',
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
    // If already RpcError, throw directly
    if (error instanceof RpcError || error instanceof BatchSizeError) {
      throw error;
    }

    // Other unexpected errors
    console.error('[ingestPriceHistoryRpc] Unexpected error:', error);
    throw new RpcError(
      `Unexpected error: ${error.message}`,
      'UNEXPECTED_ERROR',
      error
    );
  }
}

/**
 * Check if RPC is available (health check)
 * 
 * @returns {Promise<boolean>} Whether RPC is available
 */
export async function checkRpcHealth() {
  try {
    // Try calling a simple test (empty data)
    const { error } = await supabase.rpc('ingest_goods_receipts_v1', {
      p_batch_id: '00000000-0000-0000-0000-000000000000',
      p_upload_file_id: '00000000-0000-0000-0000-000000000000',
      p_rows: []
    });

    // If function doesn't exist, error.code will be '42883' (undefined_function)
    if (error && error.code === '42883') {
      console.warn('[checkRpcHealth] RPC function not found (not deployed or wrong name)');
      return false;
    }

    // Other errors (e.g. permission issues) also treated as unavailable
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
 * Export all error types (for frontend catch handling)
 */
export { MAX_ROWS_PER_BATCH };
