/**
 * Import History Service
 * 管理匯入歷史和批次撤銷功能
 */

import { supabase } from './supabaseClient';

/**
 * Import Batches Operations
 */
export const importBatchesService = {
  /**
   * 建立新的匯入批次記錄
   * @param {string} userId - 使用者 ID
   * @param {Object} batchData - 批次資料
   * @param {string} batchData.uploadType - 上傳類型
   * @param {string} batchData.filename - 檔案名稱
   * @param {string} batchData.targetTable - 目標表格
   * @param {number} batchData.totalRows - 總行數
   * @param {Object} batchData.metadata - 額外元數據
   * @returns {Promise<Object>} 建立的批次記錄
   */
  async createBatch(userId, batchData) {
    const payload = {
      user_id: userId,
      upload_type: batchData.uploadType,
      filename: batchData.filename,
      target_table: batchData.targetTable,
      total_rows: batchData.totalRows || 0,
      success_rows: 0,
      error_rows: 0,
      status: 'pending',
      metadata: batchData.metadata || {}
    };

    const { data, error } = await supabase
      .from('import_batches')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * 更新批次狀態和統計
   * @param {string} batchId - 批次 ID
   * @param {Object} updates - 更新內容
   * @param {number} updates.successRows - 成功行數
   * @param {number} updates.errorRows - 錯誤行數
   * @param {string} updates.status - 狀態
   * @returns {Promise<Object>} 更新後的批次記錄
   */
  async updateBatch(batchId, updates) {
    const payload = {};
    
    if (updates.successRows !== undefined) {
      payload.success_rows = updates.successRows;
    }
    
    if (updates.errorRows !== undefined) {
      payload.error_rows = updates.errorRows;
    }
    
    if (updates.status) {
      payload.status = updates.status;
    }

    if (updates.metadata) {
      payload.metadata = updates.metadata;
    }

    const { data, error } = await supabase
      .from('import_batches')
      .update(payload)
      .eq('id', batchId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * 獲取所有匯入歷史
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @param {number} options.limit - 限制筆數
   * @param {number} options.offset - 起始位置
   * @param {string} options.uploadType - 篩選上傳類型
   * @param {string} options.status - 篩選狀態
   * @returns {Promise<Array>} 批次記錄列表
   */
  async getAllBatches(userId, options = {}) {
    const { 
      limit = 100, 
      offset = 0, 
      uploadType = null, 
      status = null 
    } = options;

    let query = supabase
      .from('import_batches')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (uploadType) {
      query = query.eq('upload_type', uploadType);
    }

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 獲取單一批次詳情
   * @param {string} batchId - 批次 ID
   * @returns {Promise<Object>} 批次記錄
   */
  async getBatch(batchId) {
    const { data, error } = await supabase
      .from('import_batches')
      .select('*')
      .eq('id', batchId)
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * 根據批次 ID 獲取相關的資料列（預覽）
   * @param {string} batchId - 批次 ID
   * @param {string} targetTable - 目標表格名稱
   * @param {number} limit - 限制筆數（預設 50）
   * @returns {Promise<Array>} 資料列表
   */
  async getBatchData(batchId, targetTable, limit = 50) {
    // 根據不同的目標表格查詢
    let query;
    
    switch(targetTable) {
      case 'suppliers':
        query = supabase
          .from('suppliers')
          .select('*')
          .eq('batch_id', batchId)
          .limit(limit);
        break;
        
      case 'materials':
        query = supabase
          .from('materials')
          .select('*')
          .eq('batch_id', batchId)
          .limit(limit);
        break;
        
      case 'goods_receipts':
        query = supabase
          .from('goods_receipts')
          .select('*, suppliers(supplier_name), materials(material_code, material_name)')
          .eq('batch_id', batchId)
          .limit(limit);
        break;
        
      case 'price_history':
        query = supabase
          .from('price_history')
          .select('*, suppliers(supplier_name), materials(material_code, material_name)')
          .eq('batch_id', batchId)
          .limit(limit);
        break;
        
      default:
        throw new Error(`Unknown target table: ${targetTable}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 撤銷單一匯入批次
   * @param {string} batchId - 批次 ID
   * @param {string} userId - 使用者 ID
   * @returns {Promise<Object>} 撤銷結果
   */
  async undoBatch(batchId, userId) {
    const { data, error } = await supabase
      .rpc('undo_import_batch', {
        p_batch_id: batchId,
        p_user_id: userId
      });

    if (error) throw error;
    return data;
  },

  /**
   * 批量撤銷多個匯入批次
   * @param {Array<string>} batchIds - 批次 ID 陣列
   * @param {string} userId - 使用者 ID
   * @returns {Promise<Object>} 批量撤銷結果
   */
  async undoMultipleBatches(batchIds, userId) {
    const { data, error } = await supabase
      .rpc('undo_multiple_batches', {
        p_batch_ids: batchIds,
        p_user_id: userId
      });

    if (error) throw error;
    return data;
  },

  /**
   * 刪除批次記錄（僅刪除記錄，不刪除實際資料）
   * @param {string} batchId - 批次 ID
   * @returns {Promise<Object>} 成功訊息
   */
  async deleteBatch(batchId) {
    const { error } = await supabase
      .from('import_batches')
      .delete()
      .eq('id', batchId);

    if (error) throw error;
    return { success: true };
  },

  /**
   * 獲取匯入統計摘要
   * @param {string} userId - 使用者 ID
   * @param {number} days - 統計天數（預設 30 天）
   * @returns {Promise<Object>} 統計數據
   */
  async getStats(userId, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await supabase
      .from('import_batches')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    const stats = {
      totalBatches: data.length,
      completedBatches: data.filter(b => b.status === 'completed').length,
      undoneBatches: data.filter(b => b.status === 'undone').length,
      totalRowsImported: data.reduce((sum, b) => sum + (b.success_rows || 0), 0),
      totalRowsFailed: data.reduce((sum, b) => sum + (b.error_rows || 0), 0),
      byUploadType: {}
    };

    // 按上傳類型分組統計
    data.forEach(batch => {
      if (!stats.byUploadType[batch.upload_type]) {
        stats.byUploadType[batch.upload_type] = {
          count: 0,
          successRows: 0,
          errorRows: 0
        };
      }
      stats.byUploadType[batch.upload_type].count++;
      stats.byUploadType[batch.upload_type].successRows += (batch.success_rows || 0);
      stats.byUploadType[batch.upload_type].errorRows += (batch.error_rows || 0);
    });

    return stats;
  }
};

export default importBatchesService;





