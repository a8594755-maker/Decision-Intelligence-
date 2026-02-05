/**
 * Sheet Runs Service
 * 管理 ingest_sheet_runs 表（用於 idempotency 和 audit）
 */

import { supabase } from './supabaseClient';

/**
 * Check if ingest_key migration is deployed
 * @returns {Promise<boolean>}
 */
export async function checkIngestKeySupport() {
  try {
    const { data, error } = await supabase.rpc('check_ingest_key_support');
    
    if (error) {
      console.warn('[SheetRuns] Failed to check ingest_key support:', error);
      return false;
    }
    
    return data === true;
  } catch (error) {
    console.warn('[SheetRuns] check_ingest_key_support RPC not available:', error);
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
    const { data, error, count } = await supabase
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
