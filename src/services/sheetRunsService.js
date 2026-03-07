/**
 * Sheet Runs Service
 * Manages ingest_sheet_runs table (for idempotency and audit)
 */

import { supabase, RPC_JSON_OPTIONS } from './supabaseClient';

// Cache for ingest key support check (avoid repeated slow RPCs)
let _ingestKeySupportCache = null;
let _ingestKeySupportCacheTime = 0;
const INGEST_KEY_CACHE_TTL = 60_000; // 1 minute
const INGEST_KEY_CHECK_TIMEOUT = 3_000; // 3 seconds max

/**
 * Check if ingest_key migration is deployed
 * Uses cache + fast timeout to avoid blocking import flow
 * @returns {Promise<boolean>}
 */
export async function checkIngestKeySupport() {
  // Return cached result if fresh
  if (_ingestKeySupportCache !== null && Date.now() - _ingestKeySupportCacheTime < INGEST_KEY_CACHE_TTL) {
    return _ingestKeySupportCache;
  }

  try {
    const result = await Promise.race([
      supabase.rpc('check_ingest_key_support', {}, RPC_JSON_OPTIONS),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), INGEST_KEY_CHECK_TIMEOUT))
    ]);

    if (result.error) {
      console.warn('[SheetRuns] Failed to check ingest_key support:', result.error);
      _ingestKeySupportCache = false;
      _ingestKeySupportCacheTime = Date.now();
      return false;
    }

    _ingestKeySupportCache = result.data === true;
    _ingestKeySupportCacheTime = Date.now();
    return _ingestKeySupportCache;
  } catch (error) {
    console.warn('[SheetRuns] check_ingest_key_support RPC not available:', error.message);
    _ingestKeySupportCache = false;
    _ingestKeySupportCacheTime = Date.now();
    return false;
  }
}

/**
 * Create or update a sheet run
 * @param {object} params
 * @returns {Promise<object>} Sheet run record
 */
export async function upsertSheetRun({
  userId,
  batchId,
  sheetName,
  uploadType,
  idempotencyKey,
  status = 'running',
  totalRows = 0,
  chunksTotal = 0
}) {
  const payload = {
    user_id: userId,
    batch_id: batchId,
    sheet_name: sheetName,
    upload_type: uploadType,
    idempotency_key: idempotencyKey,
    status,
    started_at: new Date().toISOString(),
    total_rows: totalRows,
    chunks_total: chunksTotal
  };
  
  const { data, error } = await supabase
    .from('ingest_sheet_runs')
    .upsert(payload, {
      onConflict: 'user_id,idempotency_key',
      ignoreDuplicates: false
    })
    .select()
    .single();
  
  if (error) {
    console.error('[SheetRuns] Failed to upsert sheet run:', error);
    throw error;
  }
  
  return data;
}

/**
 * Update sheet run status
 * @param {string} idempotencyKey 
 * @param {object} updates 
 * @returns {Promise<object>}
 */
export async function updateSheetRun(userId, idempotencyKey, updates) {
  const { data, error } = await supabase
    .from('ingest_sheet_runs')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .eq('idempotency_key', idempotencyKey)
    .select()
    .single();
  
  if (error) {
    console.error('[SheetRuns] Failed to update sheet run:', error);
    throw error;
  }
  
  return data;
}

/**
 * Check if a sheet has already been successfully imported
 * @param {string} userId 
 * @param {string} idempotencyKey 
 * @returns {Promise<object|null>} Existing run or null
 */
export async function findSucceededRun(userId, idempotencyKey) {
  const { data, error } = await supabase
    .from('ingest_sheet_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('idempotency_key', idempotencyKey)
    .eq('status', 'succeeded')
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') {
      // Not found (normal case)
      return null;
    }
    console.error('[SheetRuns] Failed to find succeeded run:', error);
    return null;
  }
  
  return data;
}

/**
 * Delete previous data by ingest_key (for idempotent re-import)
 * @param {string} userId 
 * @param {string} ingestKey 
 * @param {string} uploadType 
 * @returns {Promise<number>} Number of rows deleted
 */
export async function deletePreviousDataByIngestKey(userId, ingestKey, uploadType) {
  const tableMap = {
    'goods_receipt': 'goods_receipts',
    'price_history': 'price_history',
    'supplier_master': 'suppliers',
    'bom_edge': 'bom_edges',
    'demand_fg': 'demand_fg',
    'po_open_lines': 'po_open_lines',
    'inventory_snapshots': 'inventory_snapshots',
    'fg_financials': 'fg_financials'
  };
  
  const tableName = tableMap[uploadType];
  if (!tableName) {
    console.warn(`[SheetRuns] Unknown table for uploadType: ${uploadType}`);
    return 0;
  }
  
  try {
    const { data: _data, error, count } = await supabase
      .from(tableName)
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('ingest_key', ingestKey);
    
    if (error) {
      console.error(`[SheetRuns] Failed to delete previous data from ${tableName}:`, error);
      throw error;
    }
    
    console.log(`[SheetRuns] Deleted ${count || 0} rows from ${tableName} with ingest_key: ${ingestKey}`);
    return count || 0;
    
  } catch (error) {
    // If ingest_key column doesn't exist, fail gracefully
    if (error.message?.includes('column') && error.message?.includes('does not exist')) {
      console.warn(`[SheetRuns] ingest_key column not found in ${tableName}, skipping delete`);
      return 0;
    }
    throw error;
  }
}

/**
 * Get sheet run history
 * @param {string} userId 
 * @param {number} limit 
 * @returns {Promise<object[]>}
 */
export async function getSheetRunHistory(userId, limit = 50) {
  const { data, error } = await supabase
    .from('ingest_sheet_runs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  
  if (error) {
    console.error('[SheetRuns] Failed to get history:', error);
    return [];
  }
  
  return data || [];
}
