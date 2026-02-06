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

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'importHistoryService.js:74',message:'Before update import_batches',data:{batchId,payload,payloadKeys:Object.keys(payload)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

    const { data, error } = await supabase
      .from('import_batches')
      .update(payload)
      .eq('id', batchId)
      .select()
      .single();

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'importHistoryService.js:81',message:'After update import_batches',data:{success:!error,error:error?{message:error.message,details:error.details,hint:error.hint,code:error.code}:null,batchId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

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
   * @param {Array<string>} options.includeStatuses - 預設顯示的狀態列表
   * @returns {Promise<Array>} 批次記錄列表
   */
  async getAllBatches(userId, options = {}) {
    const { 
      limit = 100, 
      offset = 0, 
      uploadType = null, 
      status = null,
      includeStatuses = ['completed', 'failed', 'undone']  // 預設過濾掉 pending 狀態
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

    // 修改狀態篩選邏輯：如果指定了 status 則使用指定的，否則使用 includeStatuses
    if (status) {
      query = query.eq('status', status);
    } else {
      query = query.in('status', includeStatuses);
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
        
      case 'bom_explosion':
        // 查詢 component_demand（BOM explosion 的結果）
        query = supabase
          .from('component_demand')
          .select('*')
          .eq('batch_id', batchId)
          .order('material_code', { ascending: true })
          .limit(limit);
        break;
        
      case 'bom_edges':
        query = supabase
          .from('bom_edges')
          .select('*')
          .eq('batch_id', batchId)
          .order('parent_material', { ascending: true })
          .limit(limit);
        break;
        
      case 'demand_fg':
        query = supabase
          .from('demand_fg')
          .select('*')
          .eq('batch_id', batchId)
          .order('material_code', { ascending: true })
          .limit(limit);
        break;
        
      case 'po_open_lines':
        query = supabase
          .from('po_open_lines')
          .select('*')
          .eq('batch_id', batchId)
          .order('po_number', { ascending: true })
          .limit(limit);
        break;
        
      case 'inventory_snapshots':
        query = supabase
          .from('inventory_snapshots')
          .select('*')
          .eq('batch_id', batchId)
          .order('material_code', { ascending: true })
          .limit(limit);
        break;
        
      case 'fg_financials':
        query = supabase
          .from('fg_financials')
          .select('*')
          .eq('batch_id', batchId)
          .order('material_code', { ascending: true })
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
   * 查詢 component_demand_trace 資料（支援篩選和分頁）
   * @param {string} userId - 使用者 ID
   * @param {string} batchId - 批次 ID
   * @param {Object} options - 查詢選項
   * @param {Object} options.filters - 篩選條件
   * @param {number} options.limit - 限制筆數（預設 100）
   * @param {number} options.offset - 偏移量（預設 0）
   * @returns {Promise<Object>} { data, count, error }
   */
  async getComponentDemandTrace(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;
    
    try {
      let query = supabase
        .from('component_demand_trace')
        .select('*')
        .eq('user_id', userId)
        .eq('batch_id', batchId);
      
      let countQuery = supabase
        .from('component_demand_trace')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('batch_id', batchId);
      
      // Apply filters
      if (filters.component_demand_id) {
        query = query.eq('component_demand_id', filters.component_demand_id);
        countQuery = countQuery.eq('component_demand_id', filters.component_demand_id);
      }
      if (filters.fg_demand_id) {
        query = query.eq('fg_demand_id', filters.fg_demand_id);
        countQuery = countQuery.eq('fg_demand_id', filters.fg_demand_id);
      }
      if (filters.bom_level) {
        const level = parseInt(filters.bom_level, 10);
        if (!isNaN(level)) {
          query = query.eq('bom_level', level);
          countQuery = countQuery.eq('bom_level', level);
        }
      }
      // Optional: filter by material codes in trace_meta
      if (filters.component_material_code && filters.component_material_code.trim()) {
        query = query.ilike('trace_meta->>component_material_code', `%${filters.component_material_code}%`);
        countQuery = countQuery.ilike('trace_meta->>component_material_code', `%${filters.component_material_code}%`);
      }
      if (filters.fg_material_code && filters.fg_material_code.trim()) {
        query = query.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
        countQuery = countQuery.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
      }
      
      // Order by created_at
      query = query.order('created_at', { ascending: false });
      
      // Apply pagination
      query = query.range(offset, offset + limit - 1);
      
      // Execute queries
      const [dataResult, countResult] = await Promise.all([
        query,
        countQuery
      ]);
      
      if (dataResult.error) {
        return {
          data: [],
          count: 0,
          error: dataResult.error.message || dataResult.error.details || JSON.stringify(dataResult.error)
        };
      }
      
      if (countResult.error) {
        console.warn('Count query failed:', countResult.error);
      }
      
      return {
        data: dataResult.data || [],
        count: countResult.count || dataResult.data?.length || 0,
        error: null
      };
      
    } catch (error) {
      console.error('Error in getComponentDemandTrace:', error);
      return {
        data: [],
        count: 0,
        error: error.message || error.details || JSON.stringify(error)
      };
    }
  },

  /**
   * 查詢批次資料（支援篩選和分頁）
   * @param {string} userId - 使用者 ID
   * @param {string} batchId - 批次 ID
   * @param {string} targetTable - 目標表格
   * @param {Object} options - 查詢選項
   * @param {Object} options.filters - 篩選條件
   * @param {number} options.limit - 限制筆數（預設 100）
   * @param {number} options.offset - 偏移量（預設 0）
   * @param {string} options.view - 視圖類型 ('results' | 'trace')，僅用於 bom_explosion
   * @returns {Promise<Object>} { data, count, error }
   */
  async getBatchDataWithFilters(userId, batchId, targetTable, options = {}) {
    const { filters = {}, limit = 100, offset = 0, view = 'results' } = options;
    
    let query;
    let countQuery;
    
    try {
      switch (targetTable) {
        case 'goods_receipts':
          query = supabase
            .from('goods_receipts')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('goods_receipts')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.supplier_name) {
            query = query.ilike('supplier_name', `%${filters.supplier_name}%`);
            countQuery = countQuery.ilike('supplier_name', `%${filters.supplier_name}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          
          query = query.order('receipt_date', { ascending: false });
          break;
          
        case 'price_history':
          query = supabase
            .from('price_history')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('price_history')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.supplier_name) {
            query = query.ilike('supplier_name', `%${filters.supplier_name}%`);
            countQuery = countQuery.ilike('supplier_name', `%${filters.supplier_name}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          
          query = query.order('price_date', { ascending: false });
          break;
          
        case 'suppliers':
          query = supabase
            .from('suppliers')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('suppliers')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.supplier_code) {
            query = query.ilike('supplier_code', `%${filters.supplier_code}%`);
            countQuery = countQuery.ilike('supplier_code', `%${filters.supplier_code}%`);
          }
          if (filters.supplier_name) {
            query = query.ilike('supplier_name', `%${filters.supplier_name}%`);
            countQuery = countQuery.ilike('supplier_name', `%${filters.supplier_name}%`);
          }
          
          query = query.order('supplier_code', { ascending: true });
          break;
          
        case 'bom_edges':
          query = supabase
            .from('bom_edges')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('bom_edges')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.parent_material) {
            query = query.ilike('parent_material', `%${filters.parent_material}%`);
            countQuery = countQuery.ilike('parent_material', `%${filters.parent_material}%`);
          }
          if (filters.child_material) {
            query = query.ilike('child_material', `%${filters.child_material}%`);
            countQuery = countQuery.ilike('child_material', `%${filters.child_material}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          
          query = query.order('parent_material', { ascending: true });
          break;
          
        case 'demand_fg':
          query = supabase
            .from('demand_fg')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('demand_fg')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          if (filters.time_bucket) {
            query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
            countQuery = countQuery.ilike('time_bucket', `%${filters.time_bucket}%`);
          }
          
          query = query.order('time_bucket', { ascending: true });
          break;
          
        case 'bom_explosion':
          // Support view parameter: 'results' (component_demand) or 'trace' (component_demand_trace)
          if (view === 'trace') {
            // Delegate to getComponentDemandTrace method
            return await this.getComponentDemandTrace(userId, batchId, { filters, limit, offset });
          }
          
          // Default: view='results' - query component_demand
          query = supabase
            .from('component_demand')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('component_demand')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          if (filters.time_bucket) {
            query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
            countQuery = countQuery.ilike('time_bucket', `%${filters.time_bucket}%`);
          }
          
          query = query.order('material_code', { ascending: true });
          break;
          
        case 'bom_edges':
          query = supabase
            .from('bom_edges')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('bom_edges')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.parent_material) {
            query = query.ilike('parent_material', `%${filters.parent_material}%`);
            countQuery = countQuery.ilike('parent_material', `%${filters.parent_material}%`);
          }
          if (filters.child_material) {
            query = query.ilike('child_material', `%${filters.child_material}%`);
            countQuery = countQuery.ilike('child_material', `%${filters.child_material}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          
          query = query.order('parent_material', { ascending: true });
          break;
          
        case 'demand_fg':
          query = supabase
            .from('demand_fg')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('demand_fg')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          if (filters.time_bucket) {
            query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
            countQuery = countQuery.ilike('time_bucket', `%${filters.time_bucket}%`);
          }
          
          query = query.order('material_code', { ascending: true });
          break;
          
        case 'po_open_lines':
          query = supabase
            .from('po_open_lines')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('po_open_lines')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.po_number) {
            query = query.ilike('po_number', `%${filters.po_number}%`);
            countQuery = countQuery.ilike('po_number', `%${filters.po_number}%`);
          }
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          if (filters.time_bucket) {
            query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
            countQuery = countQuery.ilike('time_bucket', `%${filters.time_bucket}%`);
          }
          
          query = query.order('po_number', { ascending: true });
          break;
          
        case 'inventory_snapshots':
          query = supabase
            .from('inventory_snapshots')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('inventory_snapshots')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          if (filters.snapshot_date) {
            query = query.eq('snapshot_date', filters.snapshot_date);
            countQuery = countQuery.eq('snapshot_date', filters.snapshot_date);
          }
          
          query = query.order('material_code', { ascending: true });
          break;
          
        case 'fg_financials':
          query = supabase
            .from('fg_financials')
            .select('*')
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          countQuery = supabase
            .from('fg_financials')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('batch_id', batchId);
          
          // Apply filters
          if (filters.material_code) {
            query = query.ilike('material_code', `%${filters.material_code}%`);
            countQuery = countQuery.ilike('material_code', `%${filters.material_code}%`);
          }
          if (filters.plant_id) {
            query = query.ilike('plant_id', `%${filters.plant_id}%`);
            countQuery = countQuery.ilike('plant_id', `%${filters.plant_id}%`);
          }
          if (filters.currency) {
            query = query.eq('currency', filters.currency);
            countQuery = countQuery.eq('currency', filters.currency);
          }
          
          query = query.order('material_code', { ascending: true });
          break;
          
        default:
          return {
            data: [],
            count: 0,
            error: `Unknown target table: ${targetTable}`
          };
      }
      
      // Apply pagination
      query = query.range(offset, offset + limit - 1);
      
      // Execute queries
      const [dataResult, countResult] = await Promise.all([
        query,
        countQuery
      ]);
      
      if (dataResult.error) {
        return {
          data: [],
          count: 0,
          error: dataResult.error.message || dataResult.error.details || JSON.stringify(dataResult.error)
        };
      }
      
      if (countResult.error) {
        console.warn('Count query failed:', countResult.error);
      }
      
      return {
        data: dataResult.data || [],
        count: countResult.count || dataResult.data?.length || 0,
        error: null
      };
      
    } catch (error) {
      console.error('Error in getBatchDataWithFilters:', error);
      return {
        data: [],
        count: 0,
        error: error.message || error.details || JSON.stringify(error)
      };
    }
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
   * 批量刪除失敗的批次記錄
   * @param {string} userId - 使用者 ID
   * @returns {Promise<Object>} 刪除結果
   */
  async deleteFailedBatches(userId) {
    const { data, error } = await supabase
      .from('import_batches')
      .delete()
      .eq('user_id', userId)
      .in('status', ['failed', 'pending'])
      .select();

    if (error) throw error;
    return { success: true, deletedCount: data?.length || 0 };
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
      failedBatches: data.filter(b => b.status === 'failed').length,
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







