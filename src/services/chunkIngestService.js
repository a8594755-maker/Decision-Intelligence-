/**
 * Chunk Ingest Service
 * 處理大量資料的分批寫入，支援 abort 和詳細進度回報
 */

export const DEFAULT_CHUNK_SIZE = 500;
export const RPC_MAX_CHUNK_SIZE = 800; // RPC 有 1000 限制，保留 buffer

/**
 * Extract detailed error information from Supabase/Postgres error
 * ✅ 改進：能準確定位哪個欄位、哪筆資料、什麼錯誤
 * @param {Error} error - Original error object
 * @param {string} uploadType - Upload type (for field hints)
 * @param {number} chunkIndex - Current chunk index
 * @param {object[]} chunk - Current chunk data (for row inspection)
 * @returns {object} { message, code, details, hint, column, firstFailedRow }
 */
function extractErrorDetails(error, uploadType, chunkIndex, chunk) {
  // Default structure
  const result = {
    message: error.message || 'Unknown error',
    code: null,
    details: null,
    hint: null,
    column: null,
    firstFailedRow: null
  };

  // Supabase/Postgres error 結構：error.code, error.details, error.hint
  if (error.code) {
    result.code = error.code;
    
    // Postgres error codes 翻譯
    const postgresErrors = {
      '22P02': 'Invalid UUID format',
      '23502': 'NOT NULL constraint violation',
      '23503': 'Foreign key constraint violation',
      '23505': 'Unique constraint violation',
      '23514': 'Check constraint violation',
      '42703': 'Undefined column',
      '42P01': 'Undefined table',
      'PGRST116': 'Row level security policy violation'
    };
    
    const errorType = postgresErrors[error.code] || `Database error (${error.code})`;
    result.message = `${errorType}: ${error.message}`;
  }

  // Extract column name from error message
  if (error.details) {
    result.details = error.details;
    
    // Pattern: "column_name" violates constraint
    // Pattern: invalid input syntax for type uuid: "value"
    const columnMatch = error.details.match(/column "([^"]+)"/i) || 
                        error.message.match(/column "([^"]+)"/i);
    if (columnMatch) {
      result.column = columnMatch[1];
    }
  }

  if (error.hint) {
    result.hint = error.hint;
  }

  // 嘗試找出第一筆失敗的資料（用於 debug）
  if (result.column && chunk && chunk.length > 0) {
    // 找第一筆該欄位有問題的資料
    const failedRow = chunk.find(row => {
      const value = row[result.column];
      
      // UUID 欄位檢查
      if (['user_id', 'batch_id', 'supplier_id', 'material_id'].includes(result.column)) {
        return value && !isValidUUID(value);
      }
      
      // NOT NULL 檢查
      if (result.code === '23502') {
        return value === null || value === undefined || value === '';
      }
      
      return false;
    });

    if (failedRow) {
      result.firstFailedRow = {
        [result.column]: failedRow[result.column],
        material_code: failedRow.material_code,
        po_number: failedRow.po_number,
        supplier_name: failedRow.supplier_name
      };
    }
  }

  // 加入 chunk 資訊
  result.message = `[Chunk ${chunkIndex}] ${result.message}`;
  if (result.column) {
    result.message += ` (column: ${result.column})`;
  }

  return result;
}

/**
 * Validate UUID format
 * @param {string} value 
 * @returns {boolean}
 */
function isValidUUID(value) {
  if (!value || typeof value !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Split rows into chunks
 * @param {object[]} rows - Data rows
 * @param {number} chunkSize - Chunk size
 * @returns {object[][]} Array of row chunks
 */
export function chunkRows(rows, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!rows || rows.length === 0) return [];
  
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Detect if strategy uses RPC (based on strategy class name or method)
 * @param {object} strategy 
 * @returns {boolean}
 */
function isRpcStrategy(strategy) {
  // Check if strategy constructor name contains "GoodsReceipt" or "PriceHistory"
  const constructorName = strategy.constructor.name;
  return constructorName === 'GoodsReceiptStrategy' || constructorName === 'PriceHistoryStrategy';
}

/**
 * Ingest data in chunks
 * 支援 >1000 rows，自動分批，支援 abort
 * 
 * @param {object} params
 * @param {object} params.strategy - Upload strategy (from getUploadStrategy)
 * @param {string} params.userId - User ID
 * @param {string} params.uploadType - Upload type
 * @param {object[]} params.rows - Data rows (can be >1000)
 * @param {string} params.batchId - Batch ID
 * @param {string} params.uploadFileId - Upload file ID
 * @param {string} params.fileName - File name
 * @param {string} params.sheetName - Sheet name
 * @param {number} params.chunkSize - Chunk size (default 500)
 * @param {function} params.onProgress - Progress callback
 * @param {AbortSignal} params.signal - Abort signal (optional)
 * @param {object} params.options - Additional options (e.g., idempotencyKey)
 * @returns {Promise<object>} { savedCount, chunks, warnings }
 */
export async function ingestInChunks({
  strategy,
  userId,
  uploadType,
  rows,
  batchId,
  uploadFileId,
  fileName,
  sheetName,
  chunkSize = DEFAULT_CHUNK_SIZE,
  onProgress = () => {},
  signal = null,
  options = {}
}) {
  // Detect if strategy uses RPC and adjust chunk size
  const useRpc = isRpcStrategy(strategy);
  const effectiveChunkSize = useRpc ? Math.min(chunkSize, RPC_MAX_CHUNK_SIZE) : chunkSize;
  
  // Split into chunks
  const chunks = chunkRows(rows, effectiveChunkSize);
  const totalChunks = chunks.length;
  
  console.log(`[ChunkIngest] Sheet "${sheetName}" (${uploadType}): ${rows.length} rows → ${totalChunks} chunks (size: ${effectiveChunkSize})`);
  
  const chunkResults = [];
  const warnings = [];
  let totalSavedCount = 0;
  
  // Process chunks sequentially
  for (let i = 0; i < chunks.length; i++) {
    // Check abort signal
    if (signal?.aborted) {
      console.log(`[ChunkIngest] Aborted at chunk ${i + 1}/${totalChunks}`);
      throw new Error('ABORTED');
    }
    
    const chunk = chunks[i];
    const chunkIndex = i + 1;
    
    // Progress callback
    onProgress({
      phase: 'ingesting',
      sheetName,
      uploadType,
      chunkIndex,
      totalChunks,
      savedSoFar: totalSavedCount
    });
    
    try {
      // Call strategy.ingest for this chunk
      const result = await strategy.ingest({
        userId,
        rows: chunk,
        batchId,
        uploadFileId,
        fileName: `${fileName} (chunk ${chunkIndex}/${totalChunks})`,
        sheetName,
        addNotification: () => {}, // Suppress individual notifications
        setSaveProgress: () => {},  // Suppress individual progress
        options: {
          ...options,
          chunkIndex,
          totalChunks,
          isChunked: totalChunks > 1
        }
      });
      
      const savedCount = result.savedCount || 0;
      totalSavedCount += savedCount;
      
      chunkResults.push({
        chunkIndex,
        status: 'success',
        savedCount,
        rowsInChunk: chunk.length
      });
      
      console.log(`[ChunkIngest] Chunk ${chunkIndex}/${totalChunks} succeeded: ${savedCount} saved`);
      
    } catch (chunkError) {
      console.error(`[ChunkIngest] Chunk ${chunkIndex}/${totalChunks} failed:`, chunkError);
      
      // ✅ 改進：提取詳細錯誤資訊（Supabase error structure）
      const errorDetails = extractErrorDetails(chunkError, uploadType, chunkIndex, chunk);
      
      chunkResults.push({
        chunkIndex,
        status: 'failed',
        savedCount: 0,
        rowsInChunk: chunk.length,
        error: errorDetails.message,
        errorCode: errorDetails.code,
        errorDetails: errorDetails.details,
        firstFailedRow: errorDetails.firstFailedRow
      });
      
      warnings.push({
        chunkIndex,
        message: `Chunk ${chunkIndex} failed: ${errorDetails.message}`,
        details: errorDetails.details,
        hint: errorDetails.hint,
        severity: 'error'
      });
      
      // 若 chunk 失敗，記錄但繼續下一個 chunk（除非 aborted）
      // 最後會讓整個 sheet 標記為 partial_success 或 failed
    }
  }
  
  // Check if all chunks failed
  const successfulChunks = chunkResults.filter(c => c.status === 'success').length;
  if (successfulChunks === 0 && chunkResults.length > 0) {
    throw new Error(`All ${totalChunks} chunks failed. Check chunk errors for details.`);
  }
  
  return {
    savedCount: totalSavedCount,
    chunks: chunkResults,
    warnings
  };
}
