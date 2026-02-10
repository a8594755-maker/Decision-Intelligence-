/**
 * Import History Service
 * Manage import history and batch undo functionality
 */

import { supabase } from './supabaseClient';

/**
 * Import Batches Operations
 */
export const importBatchesService = {
  /**
   * Create new import batch record
   * @param {string} userId - User ID
   * @param {Object} batchData - Batch data
   * @param {string} batchData.uploadType - Upload type
   * @param {string} batchData.filename - Filename
   * @param {string} batchData.targetTable - Target table
   * @param {number} batchData.totalRows - Total rows
   * @param {Object} batchData.metadata - Additional metadata
   * @returns {Promise<Object>} Created batch record
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
   * Update batch status and statistics
   * @param {string} batchId - Batch ID
   * @param {Object} updates - Update content
   * @param {number} updates.successRows - Success row count
   * @param {number} updates.errorRows - Error row count
   * @param {string} updates.status - Status
   * @returns {Promise<Object>} Updated batch record
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
   * Get all import history
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {number} options.limit - Row limit
   * @param {number} options.offset - Start position
   * @param {string} options.uploadType - Filter by upload type
   * @param {string} options.status - Filter by status
   * @param {Array<string>} options.includeStatuses - Default status list to display
   * @returns {Promise<Array>} Batch record list
   */
  async getAllBatches(userId, options = {}) {
    const { 
      limit = 100, 
      offset = 0, 
      uploadType = null, 
      status = null,
      includeStatuses = ['completed', 'failed', 'undone']  // Default: filter out pending status
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

    // Status filter logic: use specified status if provided, otherwise use includeStatuses
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
   * Get single batch details
   * @param {string} batchId - Batch ID
   * @returns {Promise<Object>} Batch record
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
   * Get related data rows by batch ID (preview)
   * @param {string} batchId - Batch ID
   * @param {string} targetTable - Target table name
   * @param {number} limit - Row limit (default 50)
   * @returns {Promise<Array>} Data list
   */
  async getBatchData(batchId, targetTable, limit = 50) {
    // Query based on different target tables
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
        // Query component_demand (BOM explosion results)
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
   * Query component_demand_trace data (with filtering and pagination)
   * @param {string} userId - User ID
   * @param {string} batchId - Batch ID
   * @param {Object} options - Query options
   * @param {Object} options.filters - Filter conditions
   * @param {number} options.limit - Row limit (default 100)
   * @param {number} options.offset - Offset (default 0)
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
   * Query batch data (with filtering and pagination)
   * @param {string} userId - User ID
   * @param {string} batchId - Batch ID
   * @param {string} targetTable - Target table
   * @param {Object} options - Query options
   * @param {Object} options.filters - Filter conditions
   * @param {number} options.limit - Row limit (default 100)
   * @param {number} options.offset - Offset (default 0)
   * @param {string} options.view - View type ('results' | 'trace'), only for bom_explosion
   * @returns {Promise<Object>} { data, count, error }
   */
  async getBatchDataWithFilters(userId, batchId, targetTable, options = {}) {
    const { filters = {}, limit = 100, offset = 0, view = 'results', dataSource = 'local' } = options;
    
    let query;
    let countQuery;
    
    // Helper function to apply base filters based on data source
    const applyBaseFilters = (baseQuery) => {
      baseQuery = baseQuery.eq('user_id', userId);
      if (dataSource === 'local') {
        // Local data: filter by batch_id
        baseQuery = baseQuery.eq('batch_id', batchId);
      } else if (dataSource === 'sap') {
        // SAP data: filter by source = 'sap_sync'
        baseQuery = baseQuery.eq('source', 'sap_sync');
      }
      return baseQuery;
    };
    
    // Debug log
    console.log(`[getBatchDataWithFilters] targetTable=${targetTable}, dataSource=${dataSource}, batchId=${batchId?.slice(0, 8)}`);
    
    try {
      switch (targetTable) {
        case 'goods_receipts':
          query = applyBaseFilters(supabase.from('goods_receipts').select('*'));
          countQuery = applyBaseFilters(supabase.from('goods_receipts').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('price_history').select('*'));
          countQuery = applyBaseFilters(supabase.from('price_history').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('suppliers').select('*'));
          countQuery = applyBaseFilters(supabase.from('suppliers').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('bom_edges').select('*'));
          countQuery = applyBaseFilters(supabase.from('bom_edges').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('demand_fg').select('*'));
          countQuery = applyBaseFilters(supabase.from('demand_fg').select('*', { count: 'exact', head: true }));
          
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
            return await this.getComponentDemandTrace(userId, batchId, { filters, limit, offset, dataSource });
          }
          
          // Default: view='results' - query component_demand
          query = applyBaseFilters(supabase.from('component_demand').select('*'));
          countQuery = applyBaseFilters(supabase.from('component_demand').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('po_open_lines').select('*'));
          countQuery = applyBaseFilters(supabase.from('po_open_lines').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('inventory_snapshots').select('*'));
          countQuery = applyBaseFilters(supabase.from('inventory_snapshots').select('*', { count: 'exact', head: true }));
          
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
          query = applyBaseFilters(supabase.from('fg_financials').select('*'));
          countQuery = applyBaseFilters(supabase.from('fg_financials').select('*', { count: 'exact', head: true }));
          
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
   * Undo single import batch
   * @param {string} batchId - Batch ID
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Undo result
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
   * Batch undo multiple import batches
   * @param {Array<string>} batchIds - Batch ID array
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Batch undo result
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
   * Delete batch record (only deletes record, not actual data)
   * @param {string} batchId - Batch ID
   * @returns {Promise<Object>} Success message
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
   * Batch delete failed batch records
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Delete result
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
   * Get import statistics summary
   * @param {string} userId - User ID
   * @param {number} days - Statistics period in days (default 30)
   * @returns {Promise<Object>} Statistics data
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

    // Group statistics by upload type
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







