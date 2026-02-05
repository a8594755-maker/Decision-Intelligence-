import { createClient } from '@supabase/supabase-js';

// Supabase configuration - using environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Validate environment variables
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase environment variables!');
  console.error('Please ensure .env file exists with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  throw new Error('Supabase configuration error: Missing environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * User Files Operations
 */
export const userFilesService = {
  // 獲取用戶最新上傳的文件
  async getLatestFile(userId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('data')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  },

  // 保存文件到雲端
  async saveFile(userId, filename, data) {
    const payload = {
      user_id: userId,
      filename,
      data: { rows: data, version: `v-${Date.now()}` }
    };

    const { data: insertedData, error } = await supabase
      .from('user_files')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;
    return insertedData; // 回傳包含 id 的完整 row
  },

  // 獲取所有文件
  async getAllFiles(userId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }
};

/**
 * Suppliers Operations
 */
export const suppliersService = {
  // 批量插入供應商（使用 upsert 避免重複）
  async insertSuppliers(suppliers) {
    if (!suppliers || suppliers.length === 0) {
      return { success: true, count: 0 };
    }

    // 先檢查資料庫中已存在的供應商
    const supplierNames = suppliers.map(s => s.supplier_name).filter(Boolean);
    const supplierCodes = suppliers.map(s => s.supplier_code).filter(Boolean);
    
    let queryBuilder = supabase
      .from('suppliers')
      .select('id, supplier_name, supplier_code');
    
    // 建立 OR 查詢條件
    const orConditions = [];
    if (supplierNames.length > 0) {
      orConditions.push(`supplier_name.in.(${supplierNames.map(n => `"${n}"`).join(',')})`);
    }
    if (supplierCodes.length > 0) {
      orConditions.push(`supplier_code.in.(${supplierCodes.map(c => `"${c}"`).join(',')})`);
    }
    
    const { data: existingSuppliers, error: queryError } = orConditions.length > 0
      ? await queryBuilder.or(orConditions.join(','))
      : { data: [], error: null };
    
    if (queryError) {
      console.warn('Failed to check existing suppliers:', queryError);
      // Continue with insert anyway
    }

    // 建立已存在供應商的 Map
    const existingMap = new Map();
    if (existingSuppliers) {
      existingSuppliers.forEach(s => {
        if (s.supplier_code) existingMap.set(`code:${s.supplier_code}`, s.id);
        if (s.supplier_name) existingMap.set(`name:${s.supplier_name}`, s.id);
      });
    }

    // 分離新供應商和需要更新的供應商
    const toInsert = [];
    const toUpdate = [];

    suppliers.forEach(supplier => {
      const codeKey = supplier.supplier_code ? `code:${supplier.supplier_code}` : null;
      const nameKey = supplier.supplier_name ? `name:${supplier.supplier_name}` : null;
      
      const existingId = codeKey && existingMap.get(codeKey) || nameKey && existingMap.get(nameKey);
      
      if (existingId) {
        // 已存在，準備更新
        toUpdate.push({ ...supplier, id: existingId });
      } else {
        // 新供應商，準備插入
        toInsert.push(supplier);
      }
    });

    let insertedCount = 0;
    let updatedCount = 0;

    // 插入新供應商
    if (toInsert.length > 0) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'supabaseClient.js:130',message:'Before insert suppliers',data:{count:toInsert.length,firstItem:toInsert[0],columns:Object.keys(toInsert[0]||{})},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
      // #endregion
      
      const { data: insertedData, error: insertError } = await supabase
        .from('suppliers')
        .insert(toInsert)
        .select();

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'supabaseClient.js:137',message:'After insert suppliers',data:{success:!insertError,error:insertError?{message:insertError.message,details:insertError.details,hint:insertError.hint,code:insertError.code}:null,insertedCount:insertedData?.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,E'})}).catch(()=>{});
      // #endregion

      if (insertError) {
        console.error('Insert error:', insertError);
        throw insertError;
      }
      insertedCount = insertedData?.length || 0;
    }

    // 更新已存在的供應商（合併資訊）
    if (toUpdate.length > 0) {
      for (const supplier of toUpdate) {
        const { id, ...updateData } = supplier;
        
        // 只更新非空欄位（保留現有資料）
        const fieldsToUpdate = {};
        Object.keys(updateData).forEach(key => {
          if (updateData[key] !== null && updateData[key] !== undefined && updateData[key] !== '') {
            fieldsToUpdate[key] = updateData[key];
          }
        });

        const { error: updateError } = await supabase
          .from('suppliers')
          .update(fieldsToUpdate)
          .eq('id', id);

        if (updateError) {
          console.error(`Failed to update supplier ${id}:`, updateError);
        } else {
          updatedCount++;
        }
      }
    }

    return { 
      success: true, 
      count: insertedCount + updatedCount,
      inserted: insertedCount,
      updated: updatedCount
    };
  },

  // 獲取所有供應商
  async getAllSuppliers() {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 更新供應商
  async updateSupplier(id, updates) {
    const { data, error } = await supabase
      .from('suppliers')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  },

  // 刪除供應商
  async deleteSupplier(id) {
    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return { success: true };
  },

  // 搜索供應商
  async searchSuppliers(searchTerm) {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .or(`supplier_name.ilike.%${searchTerm}%,supplier_code.ilike.%${searchTerm}%,notes.ilike.%${searchTerm}%`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 根據名稱查找供應商（用於數據導入時去重）
  async findByName(userId, supplierName) {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('user_id', userId)
      .eq('supplier_name', supplierName)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  },

  // 根據編碼查找供應商
  async findByCode(userId, supplierCode) {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('user_id', userId)
      .eq('supplier_code', supplierCode)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  },

  // 創建或獲取供應商（用於導入時自動創建）
  async findOrCreate(userId, supplierData) {
    const { supplier_name, supplier_code } = supplierData;

    // 優先根據編碼查找
    if (supplier_code) {
      const existing = await this.findByCode(userId, supplier_code);
      if (existing) return existing;
    }

    // 根據名稱查找
    const existingByName = await this.findByName(userId, supplier_name);
    if (existingByName) return existingByName;

    // 不存在則創建
    const newSupplier = {
      user_id: userId,
      supplier_name,
      supplier_code: supplier_code || null,
      status: 'active'
    };

    const { data, error } = await supabase
      .from('suppliers')
      .insert(newSupplier)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * 批次 Upsert Suppliers（真正的批次處理）
   * @param {string} userId - 使用者 ID
   * @param {Array} suppliers - 供應商陣列 [{supplier_name, supplier_code?, batch_id?}, ...]
   * @param {Object} options - 選項
   * @param {number} options.chunkSize - 每批大小（預設 200）
   * @returns {Promise<Map>} 回傳 Map(key -> supplier_id)，key 為 supplier_code 或 supplier_name_norm
   */
  async batchUpsertSuppliers(userId, suppliers, options = {}) {
    const { chunkSize = 200 } = options;
    
    if (!suppliers || suppliers.length === 0) {
      return new Map();
    }

    console.log(`[batchUpsertSuppliers] Starting upsert for ${suppliers.length} suppliers`);

    // 正規化 supplier_name（模擬 DB 的 normalize 邏輯）
    const normalizeSupplierName = (name) => {
      return name.toLowerCase().trim().replace(/\s+/g, ' ');
    };

    // 正規化 supplier status（確保只寫入 'active' 或 'inactive'）
    const normalizeSupplierStatus = (status) => {
      if (!status || typeof status !== 'string') {
        return 'active';
      }
      const normalized = status.toLowerCase().trim();
      if (normalized === 'active' || normalized === 'inactive') {
        return normalized;
      }
      if (normalized === 'enabled' || normalized === 'enable' || normalized === 'yes' || normalized === '1') {
        return 'active';
      }
      if (normalized === 'disabled' || normalized === 'disable' || normalized === 'no' || normalized === '0' || normalized === 'suspended') {
        return 'inactive';
      }
      return 'active'; // 預設值
    };

    // 準備 upsert payload
    const payload = suppliers.map(s => ({
      user_id: userId,
      supplier_name: s.supplier_name,
      supplier_code: s.supplier_code || null,
      supplier_name_norm: normalizeSupplierName(s.supplier_name),
      status: normalizeSupplierStatus(s.status),
      batch_id: s.batch_id || null,
      contact_info: s.contact_info || null
    }));

    // 分批 upsert
    const allUpsertedIds = [];
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      
      console.log(`[batchUpsertSuppliers] Upserting chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(payload.length / chunkSize)} (${chunk.length} items)`);

      // 使用 upsert（ON CONFLICT）
      // 策略：優先使用 supplier_code，如果沒有則使用 supplier_name_norm
      const { data: upsertedData, error: upsertError } = await supabase
        .from('suppliers')
        .upsert(chunk, {
          onConflict: 'user_id,supplier_name_norm',  // 使用 name 作為主要衝突鍵
          ignoreDuplicates: false  // 更新而不是忽略
        })
        .select('id, supplier_code, supplier_name_norm');

      if (upsertError) {
        console.error('[batchUpsertSuppliers] Upsert error:', upsertError);
        throw new Error(`Supplier batch upsert failed: ${upsertError.message || JSON.stringify(upsertError)}`);
      }

      allUpsertedIds.push(...(upsertedData || []));
    }

    console.log(`[batchUpsertSuppliers] Upserted ${allUpsertedIds.length} suppliers`);

    // 建立 Map: key -> supplier_id
    // key 優先使用 supplier_code，否則使用 supplier_name_norm
    const supplierIdMap = new Map();
    allUpsertedIds.forEach(s => {
      if (s.supplier_code) {
        supplierIdMap.set(s.supplier_code, s.id);
      }
      if (s.supplier_name_norm) {
        supplierIdMap.set(s.supplier_name_norm, s.id);
      }
    });

    console.log(`[batchUpsertSuppliers] Created map with ${supplierIdMap.size} entries`);

    return supplierIdMap;
  }
};

/**
 * Materials Operations
 */
export const materialsService = {
  // 創建或獲取物料
  async findOrCreate(userId, materialData) {
    const { material_code, material_name, category, uom } = materialData;

    // 根據 material_code 查找
    const { data: existing, error: findError } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', material_code)
      .single();

    if (!findError && existing) {
      return existing;
    }

    // 不存在則創建
    const newMaterial = {
      user_id: userId,
      material_code,
      material_name: material_name || material_code,
      category: category || null,
      uom: uom || 'pcs'
    };

    const { data, error } = await supabase
      .from('materials')
      .insert(newMaterial)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // 獲取所有物料
  async getAll(userId) {
    const { data, error } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // 根據編碼查找物料
  async findByCode(userId, materialCode) {
    const { data, error } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', materialCode)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  },

  // 更新物料
  async update(materialId, updates) {
    const { data, error } = await supabase
      .from('materials')
      .update(updates)
      .eq('id', materialId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // 刪除物料
  async delete(materialId) {
    const { error } = await supabase
      .from('materials')
      .delete()
      .eq('id', materialId);

    if (error) throw error;
    return { success: true };
  },

  /**
   * 批次 Upsert Materials（真正的批次處理）
   * @param {string} userId - 使用者 ID
   * @param {Array} materials - 物料陣列 [{material_code, material_name, category?, uom?, batch_id?}, ...]
   * @param {Object} options - 選項
   * @param {number} options.chunkSize - 每批大小（預設 200）
   * @returns {Promise<Map>} 回傳 Map(material_code -> material_id)
   */
  async batchUpsertMaterials(userId, materials, options = {}) {
    const { chunkSize = 200 } = options;
    
    if (!materials || materials.length === 0) {
      return new Map();
    }

    console.log(`[batchUpsertMaterials] Starting upsert for ${materials.length} materials`);

    // 準備 upsert payload
    const payload = materials.map(m => ({
      user_id: userId,
      material_code: m.material_code,
      material_name: m.material_name || m.material_code,
      category: m.category || null,
      uom: m.uom || 'pcs',
      batch_id: m.batch_id || null,
      notes: m.notes || null
    }));

    // 分批 upsert
    const allUpsertedIds = [];
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      
      console.log(`[batchUpsertMaterials] Upserting chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(payload.length / chunkSize)} (${chunk.length} items)`);

      // 使用 upsert（ON CONFLICT (user_id, material_code)）
      const { data: upsertedData, error: upsertError } = await supabase
        .from('materials')
        .upsert(chunk, {
          onConflict: 'user_id,material_code',
          ignoreDuplicates: false
        })
        .select('id, material_code');

      if (upsertError) {
        console.error('[batchUpsertMaterials] Upsert error:', upsertError);
        throw new Error(`Material batch upsert failed: ${upsertError.message || JSON.stringify(upsertError)}`);
      }

      allUpsertedIds.push(...(upsertedData || []));
    }

    console.log(`[batchUpsertMaterials] Upserted ${allUpsertedIds.length} materials`);

    // 建立 Map: material_code -> material_id
    const materialIdMap = new Map();
    allUpsertedIds.forEach(m => {
      materialIdMap.set(m.material_code, m.id);
    });

    console.log(`[batchUpsertMaterials] Created map with ${materialIdMap.size} entries`);

    return materialIdMap;
  }
};

/**
 * Goods Receipts Operations
 */
export const goodsReceiptsService = {
  // 批量插入收貨記錄
  // 支援新舊兩種呼叫方式：
  // - 舊: batchInsert(userId, receipts, uploadFileId)
  // - 新: batchInsert(userId, receipts, { uploadFileId, batchId })
  async batchInsert(userId, receipts, options = {}) {
    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0 };
    }

    // 向後相容 adapter：第三參數可能是字串（舊 API）或物件（新 API）
    let uploadFileId = null;
    let batchId = null;
    
    if (typeof options === 'string') {
      // 舊 API：第三參數是 uploadFileId 字串
      uploadFileId = options;
    } else if (typeof options === 'object') {
      // 新 API：第三參數是 { uploadFileId, batchId }
      uploadFileId = options.uploadFileId || null;
      batchId = options.batchId || null;
    }

    const payload = receipts.map(r => ({
      user_id: userId,
      upload_file_id: uploadFileId,
      supplier_id: r.supplier_id,
      material_id: r.material_id,
      po_number: r.po_number || null,
      receipt_number: r.receipt_number || null,
      planned_delivery_date: r.planned_delivery_date || null,
      actual_delivery_date: r.actual_delivery_date,
      receipt_date: r.receipt_date || new Date().toISOString().split('T')[0],
      received_qty: r.received_qty,
      rejected_qty: r.rejected_qty || 0,
      batch_id: r.batch_id || batchId // 優先使用 receipt 內的 batch_id，否則用參數
    }));

    const { data, error } = await supabase
      .from('goods_receipts')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  /**
   * 批次插入 Goods Receipts（支援進度回調）
   * @param {string} userId - 使用者 ID
   * @param {Array} receipts - 收貨記錄陣列（已含 supplier_id/material_id）
   * @param {Object} options - 選項
   * @param {number} options.chunkSize - 每批大小（預設 500）
   * @param {function} options.onProgress - 進度回調 (current, total)
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsertReceipts(userId, receipts, options = {}) {
    const { chunkSize = 500, onProgress = null } = options;
    
    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0, data: [] };
    }

    console.log(`[batchInsertReceipts] Starting insert for ${receipts.length} receipts`);

    // 準備 payload
    const payload = receipts.map(r => ({
      user_id: userId,
      upload_file_id: r.upload_file_id || null,
      supplier_id: r.supplier_id,
      material_id: r.material_id,
      po_number: r.po_number || null,
      receipt_number: r.receipt_number || null,
      planned_delivery_date: r.planned_delivery_date || null,
      actual_delivery_date: r.actual_delivery_date,
      receipt_date: r.receipt_date || new Date().toISOString().split('T')[0],
      received_qty: r.received_qty,
      rejected_qty: r.rejected_qty || 0,
      batch_id: r.batch_id || null
    }));

    // 分批插入
    const allInsertedData = [];
    let insertedCount = 0;

    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      
      console.log(`[batchInsertReceipts] Inserting chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(payload.length / chunkSize)} (${chunk.length} items)`);

      const { data: insertedData, error: insertError } = await supabase
        .from('goods_receipts')
        .insert(chunk)
        .select();

      if (insertError) {
        console.error('[batchInsertReceipts] Insert error:', insertError);
        throw new Error(`Goods receipts batch insert failed: ${insertError.message || JSON.stringify(insertError)}`);
      }

      allInsertedData.push(...(insertedData || []));
      insertedCount += insertedData?.length || 0;

      // 呼叫進度回調
      if (onProgress) {
        onProgress(insertedCount, receipts.length);
      }
    }

    console.log(`[batchInsertReceipts] Inserted ${insertedCount} receipts`);

    return { success: true, count: insertedCount, data: allInsertedData };
  },

  // 獲取收貨記錄
  async getReceipts(userId, options = {}) {
    const { supplierId, materialId, startDate, endDate, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('goods_receipts')
      .select('*, suppliers(supplier_name, supplier_code), materials(material_code, material_name)')
      .eq('user_id', userId)
      .order('actual_delivery_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }

    if (materialId) {
      query = query.eq('material_id', materialId);
    }

    if (startDate) {
      query = query.gte('actual_delivery_date', startDate);
    }

    if (endDate) {
      query = query.lte('actual_delivery_date', endDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 刪除收貨記錄
  async delete(receiptId) {
    const { error } = await supabase
      .from('goods_receipts')
      .delete()
      .eq('id', receiptId);

    if (error) throw error;
    return { success: true };
  },

  // 獲取統計數據
  async getStats(userId, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await supabase
      .from('goods_receipts')
      .select('received_qty, rejected_qty, defect_rate, is_on_time')
      .eq('user_id', userId)
      .gte('actual_delivery_date', startDate.toISOString().split('T')[0]);

    if (error) throw error;

    const stats = {
      totalReceipts: data.length,
      totalReceived: data.reduce((sum, r) => sum + parseFloat(r.received_qty || 0), 0),
      totalRejected: data.reduce((sum, r) => sum + parseFloat(r.rejected_qty || 0), 0),
      onTimeCount: data.filter(r => r.is_on_time === true).length,
      avgDefectRate: 0,
      onTimeRate: 0
    };

    if (stats.totalReceived > 0) {
      stats.avgDefectRate = (stats.totalRejected / stats.totalReceived * 100).toFixed(2);
    }

    if (stats.totalReceipts > 0) {
      stats.onTimeRate = (stats.onTimeCount / stats.totalReceipts * 100).toFixed(2);
    }

    return stats;
  }
};

/**
 * Price History Operations
 */
export const priceHistoryService = {
  // 批量插入價格記錄
  // 支援新舊兩種呼叫方式：
  // - 舊: batchInsert(userId, prices, uploadFileId)
  // - 新: batchInsert(userId, prices, { uploadFileId, batchId })
  async batchInsert(userId, prices, options = {}) {
    if (!prices || prices.length === 0) {
      return { success: true, count: 0 };
    }

    // 向後相容 adapter：第三參數可能是字串（舊 API）或物件（新 API）
    let uploadFileId = null;
    let batchId = null;
    
    if (typeof options === 'string') {
      // 舊 API：第三參數是 uploadFileId 字串
      uploadFileId = options;
    } else if (typeof options === 'object') {
      // 新 API：第三參數是 { uploadFileId, batchId }
      uploadFileId = options.uploadFileId || null;
      batchId = options.batchId || null;
    }

    const payload = prices.map(p => ({
      user_id: userId,
      upload_file_id: uploadFileId,
      supplier_id: p.supplier_id,
      material_id: p.material_id,
      order_date: p.order_date,
      unit_price: p.unit_price,
      currency: p.currency || 'USD',
      quantity: p.quantity || 0,
      is_contract_price: p.is_contract_price || false,
      batch_id: p.batch_id || batchId // 優先使用 price 內的 batch_id，否則用參數
    }));

    const { data, error } = await supabase
      .from('price_history')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // 獲取價格歷史
  async getPrices(userId, options = {}) {
    const { supplierId, materialId, startDate, endDate, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('price_history')
      .select('*, suppliers(supplier_name, supplier_code), materials(material_code, material_name)')
      .eq('user_id', userId)
      .order('order_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }

    if (materialId) {
      query = query.eq('material_id', materialId);
    }

    if (startDate) {
      query = query.gte('order_date', startDate);
    }

    if (endDate) {
      query = query.lte('order_date', endDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 刪除價格記錄
  async delete(priceId) {
    const { error } = await supabase
      .from('price_history')
      .delete()
      .eq('id', priceId);

    if (error) throw error;
    return { success: true };
  },

  // 獲取最新價格
  async getLatestPrice(userId, supplierId, materialId) {
    const { data, error } = await supabase
      .from('price_history')
      .select('*')
      .eq('user_id', userId)
      .eq('supplier_id', supplierId)
      .eq('material_id', materialId)
      .order('order_date', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }
};

/**
 * Conversations Operations (AI Chat)
 */
export const conversationsService = {
  // 獲取所有對話
  async getConversations(userId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 創建新對話
  async createConversation(userId, title = 'New Conversation') {
    const newConversation = {
      id: Date.now().toString(),
      user_id: userId,
      title,
      messages: [{
        role: 'ai',
        content: 'Hello! I am your SmartOps Decision Assistant. How can I help you today?'
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('conversations')
      .insert([newConversation]);

    if (error) throw error;
    return newConversation;
  },

  // 更新對話
  async updateConversation(conversationId, userId, updates) {
    const { data, error } = await supabase
      .from('conversations')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('user_id', userId)
      .select();

    if (error) throw error;
    return data[0];
  },

  // 刪除對話
  async deleteConversation(conversationId, userId) {
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  }
};

/**
 * Authentication Operations
 */
export const authService = {
  // 登入
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    return data;
  },

  // 註冊
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) throw error;
    return data;
  },

  // 登出
  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return { success: true };
  },

  // 獲取當前 session
  async getSession() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  },

  // 監聽認證狀態變化
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
  }
};

/**
 * Upload Mappings Operations
 * 儲存和管理欄位映射模板
 */
export const uploadMappingsService = {
  /**
   * 保存或更新欄位映射模板
   * @param {string} userId - 使用者 ID
   * @param {string} uploadType - 上傳類型
   * @param {Array} originalColumns - 原始 Excel 欄位列表
   * @param {Object} mappingJson - 欄位映射關係
   * @returns {Promise<Object>} 保存的 mapping 記錄
   */
  async saveMapping(userId, uploadType, originalColumns, mappingJson) {
    const payload = {
      user_id: userId,
      upload_type: uploadType,
      original_columns: originalColumns,
      mapping_json: mappingJson
    };

    // 使用 upsert 策略：如果已存在則更新，不存在則插入
    const { data, error } = await supabase
      .from('upload_mappings')
      .upsert(payload, {
        onConflict: 'user_id,upload_type',
        returning: 'representation'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * 根據使用者和上傳類型獲取最新的映射模板
   * @param {string} userId - 使用者 ID
   * @param {string} uploadType - 上傳類型
   * @returns {Promise<Object|null>} 映射記錄或 null
   */
  async getMapping(userId, uploadType) {
    const { data, error } = await supabase
      .from('upload_mappings')
      .select('*')
      .eq('user_id', userId)
      .eq('upload_type', uploadType)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  },

  /**
   * 獲取使用者的所有映射模板
   * @param {string} userId - 使用者 ID
   * @returns {Promise<Array>} 映射記錄列表
   */
  async getAllMappings(userId) {
    const { data, error } = await supabase
      .from('upload_mappings')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  /**
   * 刪除特定的映射模板
   * @param {string} userId - 使用者 ID
   * @param {string} uploadType - 上傳類型
   * @returns {Promise<Object>} 成功訊息
   */
  async deleteMapping(userId, uploadType) {
    const { error } = await supabase
      .from('upload_mappings')
      .delete()
      .eq('user_id', userId)
      .eq('upload_type', uploadType);

    if (error) throw error;
    return { success: true };
  },

  /**
   * 智能映射：根據相似度自動套用之前的 mapping
   * @param {string} userId - 使用者 ID
   * @param {string} uploadType - 上傳類型
   * @param {Array} currentColumns - 當前 Excel 欄位
   * @returns {Promise<Object>} 建議的映射或空物件
   */
  async smartMapping(userId, uploadType, currentColumns) {
    const savedMapping = await this.getMapping(userId, uploadType);
    
    if (!savedMapping) {
      return {}; // 沒有保存的映射
    }

    const { original_columns: savedColumns, mapping_json: savedMappingJson } = savedMapping;

    // 建立新的映射物件
    const smartMappingResult = {};

    // 遍歷當前欄位，嘗試匹配之前的映射
    currentColumns.forEach(currentCol => {
      // 完全匹配
      if (savedColumns.includes(currentCol) && savedMappingJson[currentCol]) {
        smartMappingResult[currentCol] = savedMappingJson[currentCol];
      } else {
        // 模糊匹配（大小寫不敏感）
        const lowerCurrentCol = currentCol.toLowerCase();
        const matchedCol = savedColumns.find(
          savedCol => savedCol.toLowerCase() === lowerCurrentCol
        );
        
        if (matchedCol && savedMappingJson[matchedCol]) {
          smartMappingResult[currentCol] = savedMappingJson[matchedCol];
        }
      }
    });

    return smartMappingResult;
  }
};

/**
 * BOM Edges Operations
 */
export const bomEdgesService = {
  // 批量插入 BOM 關係
  async batchInsert(userId, bomEdges, batchId = null) {
    if (!bomEdges || bomEdges.length === 0) {
      return { success: true, count: 0 };
    }

    // ✅ LOG 1: 印出 table / rows count / batchId type
    console.info("[ingest] table=bom_edges, rows=", bomEdges.length, ", batchId type=", typeof batchId, ", batchId value=", JSON.stringify(batchId).slice(0, 200));
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG1 table/uploadType/rows/batchId',data:{tableName:'bom_edges',uploadType:'bom_edge',rows:bomEdges.length,batchIdType:typeof batchId,batchIdPreview:JSON.stringify(batchId).slice(0,200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    const payload = bomEdges.map(edge => ({
      user_id: userId,
      batch_id: batchId,
      parent_material: edge.parent_material,
      child_material: edge.child_material,
      qty_per: edge.qty_per,
      uom: edge.uom || 'pcs',
      plant_id: edge.plant_id || null,
      bom_version: edge.bom_version || null,
      valid_from: edge.valid_from || null,
      valid_to: edge.valid_to || null,
      scrap_rate: edge.scrap_rate || null,
      yield_rate: edge.yield_rate || null,
      alt_group: edge.alt_group || null,
      priority: edge.priority || null,
      mix_ratio: edge.mix_ratio || null,
      ecn_number: edge.ecn_number || null,
      ecn_effective_date: edge.ecn_effective_date || null,
      routing_id: edge.routing_id || null,
      notes: edge.notes || null
    }));

    // ✅ LOG 2: 印出第一筆 row 的 keys + uuid 欄位值型態
    const sample = payload[0];
    const uuidFieldTypes = {};
    if (sample) {
      console.info("[ingest] sample keys=", Object.keys(sample));
      const uuidFields = ['user_id', 'batch_id', 'batchId', 'sheet_run_id', 'sheetRunId', 'ingest_key', 'ingestKey'];
      uuidFields.forEach(field => {
        if (sample.hasOwnProperty(field)) {
          const value = sample[field];
          const valueType = typeof value;
          const valuePreview = JSON.stringify(value).slice(0, 200);
          console.info(`[ingest] ${field}: type=${valueType}, value=${valuePreview}`);
          uuidFieldTypes[field] = { type: valueType, preview: valuePreview };
          if (valueType === 'object' && value !== null) {
            console.error(`❌ [ingest] CRITICAL: ${field} is object, not uuid string! This will cause uuid cast error!`);
          }
        }
      });
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG2 sample keys + uuid field types',data:{sampleKeys:sample?Object.keys(sample):null,uuidFieldTypes},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
    // #endregion

    // ✅ LOG 3: 印出 request body top-level structure
    console.info("[ingest] payload is array:", Array.isArray(payload), ", length=", payload.length);
    console.info("[ingest] payload preview (first 800 chars):", JSON.stringify(payload).slice(0, 800));
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG3 request body top-level',data:{bodyIsArray:Array.isArray(payload),bodyLength:payload.length,bodyTopLevelKeys:Array.isArray(payload)?null:Object.keys(payload),bodyPreview:JSON.stringify(payload).slice(0,800)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    const { data, error } = await supabase
      .from('bom_edges')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // 獲取 BOM 關係
  async getBomEdges(userId, options = {}) {
    const { parentMaterial, childMaterial, plantId, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId)
      .order('parent_material', { ascending: true })
      .range(offset, offset + limit - 1);

    if (parentMaterial) {
      query = query.eq('parent_material', parentMaterial);
    }

    if (childMaterial) {
      query = query.eq('child_material', childMaterial);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 獲取 BOM 關係（用於 BOM Explosion 計算）
  // 支援根據 plantId 和 timeBuckets 過濾（考慮時效性）
  async fetchBomEdges(userId, plantId = null, timeBuckets = []) {
    let query = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId)
      .order('parent_material', { ascending: true });

    // 工廠過濾：plant_id 匹配或為 NULL（通用 BOM）
    if (plantId) {
      query = query.or(`plant_id.eq.${plantId},plant_id.is.null`);
    }

    // 時效性過濾：如果提供 timeBuckets，需要檢查 valid_from/valid_to
    // 注意：這裡只過濾基本條件，實際的時效性檢查在計算邏輯中進行
    // 因為需要將 time_bucket 轉換為日期後再比較

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Demand FG Operations
 */
export const demandFgService = {
  // 批量插入 FG 需求
  async batchInsert(userId, demands, batchId = null) {
    if (!demands || demands.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = demands.map(demand => ({
      user_id: userId,
      batch_id: batchId,
      material_code: demand.material_code,
      plant_id: demand.plant_id,
      time_bucket: demand.time_bucket,
      week_bucket: demand.week_bucket || null,
      date: demand.date || null,
      demand_qty: demand.demand_qty,
      uom: demand.uom || 'pcs',
      source_type: demand.source_type || null,
      source_id: demand.source_id || null,
      customer_id: demand.customer_id || null,
      project_id: demand.project_id || null,
      priority: demand.priority || null,
      status: demand.status || 'confirmed',
      notes: demand.notes || null
    }));

    const { data, error } = await supabase
      .from('demand_fg')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // 獲取 FG 需求
  async getDemands(userId, options = {}) {
    const { materialCode, plantId, startTimeBucket, endTimeBucket, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (startTimeBucket) {
      query = query.gte('time_bucket', startTimeBucket);
    }

    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 獲取 FG 需求（用於 BOM Explosion 計算）
  // 支援根據 plantId 和 timeBuckets 過濾
  async fetchDemandFg(userId, plantId = null, timeBuckets = []) {
    let query = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true });

    // 工廠過濾
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // 時間桶過濾：如果提供 timeBuckets 陣列，只取得這些時間桶的需求
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Component Demand Operations
 */
export const componentDemandService = {
  // 獲取 Component 需求
  async getComponentDemands(userId, options = {}) {
    const { materialCode, plantId, timeBucket, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (timeBucket) {
      query = query.eq('time_bucket', timeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 批量 Upsert Component 需求（用於 BOM Explosion 計算結果）
  // 根據 material_code + plant_id + time_bucket + user_id 作為唯一鍵進行 upsert
  // 注意：如果同一批次重新計算，應該先調用 deleteComponentOutputsByBatch 清除舊資料
  async upsertComponentDemand(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // 準備 upsert 資料 - 只包含 DB schema 中存在的欄位
      const payload = rows.map((row, index) => {
        // 驗證必要欄位
        if (!row.user_id || !row.material_code || !row.plant_id || !row.time_bucket) {
          throw new Error(`Row ${index}: Missing required fields (user_id, material_code, plant_id, or time_bucket)`);
        }
        if (row.demand_qty === undefined || row.demand_qty === null) {
          throw new Error(`Row ${index}: Missing demand_qty`);
        }

        // 構造 payload - 只有當 id 存在時才包含 id 欄位
        const record = {
          user_id: row.user_id,
          batch_id: row.batch_id || null,
          material_code: row.material_code,
          plant_id: row.plant_id,
          time_bucket: row.time_bucket,
          demand_qty: row.demand_qty,
          uom: row.uom || 'pcs',
          // 注意：根據用戶要求，component_demand 不使用 source_fg_material/bom_level
          // 但 schema 中有這些欄位，我們設為 null
          source_fg_material: null,
          source_fg_demand_id: null,
          bom_level: null,
          notes: row.notes || null
        };

        // 只有當 row.id 存在時才包含 id（用於 update）
        if (row.id) {
          record.id = row.id;
        }

        return record;
      });

      // 嘗試使用 upsert
      // 如果資料庫有 UNIQUE 約束 (user_id, material_code, plant_id, time_bucket)，會自動處理衝突
      const { data, error } = await supabase
        .from('component_demand')
        .upsert(payload, {
          onConflict: 'user_id,material_code,plant_id,time_bucket',
          ignoreDuplicates: false
        })
        .select();

      if (error) {
        console.warn('Upsert failed, attempting fallback strategy:', {
          error: error.message,
          code: error.code,
          hint: error.hint
        });

        // 如果 upsert 失敗（可能沒有唯一約束），使用先刪除再插入的策略
        const userId = rows[0].user_id;
        const materialCodes = [...new Set(rows.map(r => r.material_code))];
        const plantIds = [...new Set(rows.map(r => r.plant_id))];
        const timeBuckets = [...new Set(rows.map(r => r.time_bucket))];

        // 查詢現有記錄
        const { data: existingData, error: queryError } = await supabase
          .from('component_demand')
          .select('id')
          .eq('user_id', userId)
          .in('material_code', materialCodes)
          .in('plant_id', plantIds)
          .in('time_bucket', timeBuckets);

        if (queryError) {
          const errorDetails = {
            message: queryError.message,
            code: queryError.code,
            details: queryError.details
          };
          console.error('Query existing records failed:', errorDetails);
          throw new Error(`Query failed: ${queryError.message}`);
        }

        // 如果有現有記錄，先刪除
        if (existingData && existingData.length > 0) {
          const existingIds = existingData.map(r => r.id);
          const { error: deleteError } = await supabase
            .from('component_demand')
            .delete()
            .in('id', existingIds);

          if (deleteError) {
            const errorDetails = {
              message: deleteError.message,
              code: deleteError.code,
              details: deleteError.details,
              deletedIds: existingIds.slice(0, 5)
            };
            console.error('Delete existing records failed:', errorDetails);
            throw new Error(`Delete failed: ${deleteError.message}`);
          }
        }

        // 插入新記錄
        const { data: insertData, error: insertError } = await supabase
          .from('component_demand')
          .insert(payload)
          .select();

        if (insertError) {
          const errorDetails = {
            message: insertError.message,
            code: insertError.code,
            details: insertError.details,
            hint: insertError.hint,
            sample_payload: payload.slice(0, 2)
          };
          console.error('Insert new records failed:', errorDetails);
          throw new Error(`Insert failed: ${insertError.message} (code: ${insertError.code})`);
        }

        return { success: true, count: insertData.length, data: insertData };
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      // 捕捉並重新拋出更清楚的錯誤
      if (error.message.includes('Missing required fields') || error.message.includes('Missing demand_qty')) {
        throw error; // 直接拋出驗證錯誤
      }
      
      const enhancedError = new Error(
        `upsertComponentDemand error: ${error.message}`
      );
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

  // 根據 batch_id 刪除 Component 需求
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('component_demand')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  // 刪除 Component 輸出（包含 component_demand 和 component_demand_trace）
  // 用於批次重新計算時清除舊資料
  async deleteComponentOutputsByBatch(batchId) {
    if (!batchId) {
      return { success: true, componentDemandCount: 0, traceCount: 0 };
    }

    // 先刪除追溯記錄（因為有外鍵關聯）
    const { data: traceData, error: traceError } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (traceError) throw traceError;

    // 再刪除 Component 需求
    const { data: demandData, error: demandError } = await supabase
      .from('component_demand')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (demandError) throw demandError;

    return {
      success: true,
      componentDemandCount: demandData?.length || 0,
      traceCount: traceData?.length || 0
    };
  },

  // 根據 batch_id 獲取 Component 需求（支援篩選和分頁）
  async getComponentDemandsByBatch(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (filters.material_code) {
      query = query.ilike('material_code', `%${filters.material_code}%`);
    }
    if (filters.plant_id) {
      query = query.ilike('plant_id', `%${filters.plant_id}%`);
    }
    if (filters.time_bucket) {
      query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
    }

    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return {
      data: data || [],
      count: count || 0
    };
  }
};

/**
 * Component Demand Trace Operations
 */
export const componentDemandTraceService = {
  // 獲取追溯資訊
  async getTrace(userId, componentMaterial, timeBucket) {
    let query = supabase
      .from('component_demand_trace')
      .select(`
        *,
        component_demand:component_demand_id(*),
        fg_demand:fg_demand_id(*),
        bom_edge:bom_edge_id(*)
      `)
      .eq('user_id', userId);

    if (componentMaterial) {
      // 需要通過 component_demand 表關聯查詢
      query = query.eq('component_demand.material_code', componentMaterial);
    }

    if (timeBucket) {
      // 需要通過 component_demand 表關聯查詢
      query = query.eq('component_demand.time_bucket', timeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 批量插入 Component 需求追溯記錄
  // 注意：根據用戶要求，trace 使用 fg_material_code/component_material_code/path_json
  // 但 schema 中使用的是 fg_demand_id/component_demand_id/bom_edge_id
  // 這裡按照 schema 實作，但可以添加額外欄位（如果 schema 支援）
  async insertComponentDemandTrace(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // 準備插入資料 - 只包含 DB schema 中存在的欄位
      const payload = rows.map((row, index) => {
        // 驗證必要欄位
        if (!row.user_id || !row.component_demand_id || !row.fg_demand_id) {
          throw new Error(`Row ${index}: Missing required fields (user_id, component_demand_id, or fg_demand_id)`);
        }

        return {
          user_id: row.user_id,
          batch_id: row.batch_id || null,
          component_demand_id: row.component_demand_id,
          fg_demand_id: row.fg_demand_id,
          bom_edge_id: row.bom_edge_id || null,
          qty_multiplier: row.qty_multiplier || null,
          bom_level: row.bom_level || null,
          // trace_meta: 額外的追溯信息（JSONB）
          // 包含 path（JSON array）、material codes、source info 等
          trace_meta: row.trace_meta || {}
        };
      });

      const { data, error } = await supabase
        .from('component_demand_trace')
        .insert(payload)
        .select();

      if (error) {
        // 詳細的錯誤訊息
        const errorDetails = {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          sample_payload: payload.slice(0, 2) // 顯示前 2 筆 payload 範例
        };
        console.error('insertComponentDemandTrace failed:', errorDetails);
        throw new Error(`Database insert failed: ${error.message} (code: ${error.code})`);
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      // 捕捉並重新拋出更清楚的錯誤
      if (error.message.includes('Missing required fields')) {
        throw error; // 直接拋出驗證錯誤
      }
      
      const enhancedError = new Error(
        `insertComponentDemandTrace error: ${error.message}`
      );
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

  // 根據 batch_id 刪除追溯記錄
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  // 根據 batch_id 獲取追溯記錄（支援篩選和分頁）
  async getTracesByBatch(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand_trace')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters (using trace_meta JSONB column)
    if (filters.bom_level) {
      query = query.eq('bom_level', parseInt(filters.bom_level));
    }
    if (filters.fg_material_code) {
      // Filter by trace_meta->>'fg_material_code'
      query = query.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
    }
    if (filters.component_material_code) {
      // Filter by trace_meta->>'component_material_code'
      query = query.ilike('trace_meta->>component_material_code', `%${filters.component_material_code}%`);
    }
    if (filters.component_demand_id) {
      query = query.eq('component_demand_id', filters.component_demand_id);
    }
    if (filters.fg_demand_id) {
      query = query.eq('fg_demand_id', filters.fg_demand_id);
    }

    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return {
      data: data || [],
      count: count || 0
    };
  }
};

/**
 * PO Open Lines Operations
 * 管理採購訂單未交貨明細
 */
export const poOpenLinesService = {
  /**
   * 批量插入 PO Open Lines
   * @param {string} userId - 使用者 ID
   * @param {Array} rows - PO Open Lines 資料陣列
   * @param {string} batchId - 批次 ID（可選）
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map(row => ({
      user_id: userId,
      batch_id: batchId,
      po_number: row.po_number,
      po_line: row.po_line,
      material_code: row.material_code,
      plant_id: row.plant_id,
      time_bucket: row.time_bucket,
      open_qty: row.open_qty,
      uom: row.uom || 'pcs',
      supplier_id: row.supplier_id || null,
      status: row.status || 'open',
      notes: row.notes || null
    }));

    // 使用 upsert 避免重複（根據 UNIQUE 約束）
    const { data, error } = await supabase
      .from('po_open_lines')
      .upsert(payload, {
        onConflict: 'user_id,po_number,po_line,time_bucket',
        ignoreDuplicates: false
      })
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  /**
   * 根據條件查詢 PO Open Lines
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @param {string} options.plantId - 工廠 ID（null = all plants）
   * @param {Array<string>} options.timeBuckets - 時間桶陣列（null = all time）
   * @param {string} options.materialCode - 物料代碼（可選）
   * @param {string} options.poNumber - 採購訂單號碼（可選）
   * @param {string} options.supplierId - 供應商 ID（可選）
   * @param {string} options.status - 狀態（可選）
   * @param {number} options.limit - 限制筆數（預設 1000）
   * @param {number} options.offset - 偏移量（預設 0）
   * @returns {Promise<Array>} PO Open Lines 資料陣列
   */
  async fetchByFilters(userId, options = {}) {
    const { 
      plantId = null, 
      timeBuckets = null, 
      materialCode = null,
      poNumber = null,
      supplierId = null,
      status = null,
      limit = 1000, 
      offset = 0 
    } = options;

    let query = supabase
      .from('po_open_lines')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    // 工廠過濾（null = all plants）
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // 時間桶過濾（null = all time）
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    // 物料代碼過濾
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // 採購訂單號碼過濾
    if (poNumber) {
      query = query.eq('po_number', poNumber);
    }

    // 供應商過濾
    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }

    // 狀態過濾
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 根據批次 ID 刪除 PO Open Lines（支援 undo）
   * @param {string} batchId - 批次 ID
   * @returns {Promise<Object>} { success, count }
   */
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('po_open_lines')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  /**
   * 獲取 PO Open Lines（通用查詢方法）
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @returns {Promise<Array>} PO Open Lines 資料陣列
   */
  async getPoOpenLines(userId, options = {}) {
    const { 
      plantId, 
      materialCode, 
      startTimeBucket, 
      endTimeBucket, 
      limit = 100, 
      offset = 0 
    } = options;

    let query = supabase
      .from('po_open_lines')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (startTimeBucket) {
      query = query.gte('time_bucket', startTimeBucket);
    }

    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Inventory Snapshots Operations
 * 管理庫存快照資料
 */
export const inventorySnapshotsService = {
  /**
   * 批量插入 Inventory Snapshots
   * @param {string} userId - 使用者 ID
   * @param {Array} rows - Inventory Snapshots 資料陣列
   * @param {string} batchId - 批次 ID（可選）
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map(row => ({
      user_id: userId,
      batch_id: batchId,
      material_code: row.material_code,
      plant_id: row.plant_id,
      snapshot_date: row.snapshot_date,
      onhand_qty: row.onhand_qty,
      allocated_qty: row.allocated_qty !== null && row.allocated_qty !== undefined ? row.allocated_qty : 0,
      safety_stock: row.safety_stock !== null && row.safety_stock !== undefined ? row.safety_stock : 0,
      uom: row.uom || 'pcs',
      notes: row.notes || null
    }));

    // 使用 upsert 避免重複（根據 UNIQUE 約束）
    const { data, error } = await supabase
      .from('inventory_snapshots')
      .upsert(payload, {
        onConflict: 'user_id,material_code,plant_id,snapshot_date',
        ignoreDuplicates: false
      })
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  /**
   * 根據條件查詢 Inventory Snapshots
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @param {string} options.plantId - 工廠 ID（null = all plants）
   * @param {string} options.materialCode - 物料代碼（可選）
   * @param {string} options.snapshotDate - 快照日期（可選）
   * @param {string} options.startDate - 起始日期（可選）
   * @param {string} options.endDate - 結束日期（可選）
   * @param {number} options.limit - 限制筆數（預設 1000）
   * @param {number} options.offset - 偏移量（預設 0）
   * @returns {Promise<Array>} Inventory Snapshots 資料陣列
   */
  async fetchByFilters(userId, options = {}) {
    const { 
      plantId = null, 
      materialCode = null,
      snapshotDate = null,
      startDate = null,
      endDate = null,
      limit = 1000, 
      offset = 0 
    } = options;

    let query = supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .range(offset, offset + limit - 1);

    // 工廠過濾（null = all plants）
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // 物料代碼過濾
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // 特定日期過濾
    if (snapshotDate) {
      query = query.eq('snapshot_date', snapshotDate);
    }

    // 日期範圍過濾
    if (startDate) {
      query = query.gte('snapshot_date', startDate);
    }

    if (endDate) {
      query = query.lte('snapshot_date', endDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 根據批次 ID 刪除 Inventory Snapshots（支援 undo）
   * @param {string} batchId - 批次 ID
   * @returns {Promise<Object>} { success, count }
   */
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('inventory_snapshots')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  /**
   * 獲取最新的庫存快照
   * @param {string} userId - 使用者 ID
   * @param {string} materialCode - 物料代碼
   * @param {string} plantId - 工廠 ID
   * @returns {Promise<Object|null>} 最新的庫存快照或 null
   */
  async getLatestSnapshot(userId, materialCode, plantId) {
    const { data, error } = await supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', materialCode)
      .eq('plant_id', plantId)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  },

  /**
   * 獲取 Inventory Snapshots（通用查詢方法）
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @returns {Promise<Array>} Inventory Snapshots 資料陣列
   */
  async getInventorySnapshots(userId, options = {}) {
    const { 
      plantId, 
      materialCode, 
      snapshotDate,
      limit = 100, 
      offset = 0 
    } = options;

    let query = supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (snapshotDate) {
      query = query.eq('snapshot_date', snapshotDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * FG Financials Operations
 * 管理成品財務資料（定價與利潤）
 */
export const fgFinancialsService = {
  /**
   * 批量插入 FG Financials
   * @param {string} userId - 使用者 ID
   * @param {Array} rows - FG Financials 資料陣列
   * @param {string} batchId - 批次 ID（可選）
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map(row => ({
      user_id: userId,
      batch_id: batchId,
      material_code: row.material_code,
      unit_margin: row.unit_margin,
      plant_id: row.plant_id || null, // null = global pricing
      unit_price: row.unit_price !== null && row.unit_price !== undefined ? row.unit_price : null,
      currency: row.currency || 'USD',
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
      notes: row.notes || null
    }));

    // 注意：fg_financials 使用 UNIQUE INDEX with COALESCE
    // 無法直接使用 onConflict with column names
    // 改用先查詢再決定 insert/update 的策略
    try {
      const { data, error } = await supabase
        .from('fg_financials')
        .insert(payload)
        .select();

      if (error) {
        // 如果是唯一性衝突，嘗試使用 upsert（需要 DB 支援）
        if (error.code === '23505') { // Unique violation
          // Fallback: 逐筆處理 upsert
          const results = [];
          for (const row of payload) {
            const { data: upsertData, error: upsertError } = await supabase
              .from('fg_financials')
              .upsert(row, {
                ignoreDuplicates: false
              })
              .select();
            
            if (upsertError) throw upsertError;
            results.push(...(upsertData || []));
          }
          return { success: true, count: results.length, data: results };
        }
        throw error;
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      console.error('batchInsert fg_financials error:', error);
      throw error;
    }
  },

  /**
   * 根據條件查詢 FG Financials
   * 特殊處理：優先查詢指定 plant_id 的資料，找不到則 fallback 到 global (plant_id is null)
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @param {string} options.plantId - 工廠 ID（null = all plants，或用於 fallback 邏輯）
   * @param {string} options.materialCode - 物料代碼（可選）
   * @param {string} options.currency - 幣別（可選）
   * @param {string} options.validDate - 有效日期（用於檢查 valid_from/valid_to，可選）
   * @param {boolean} options.usePlantFallback - 是否使用 plant fallback 邏輯（預設 true）
   * @param {number} options.limit - 限制筆數（預設 1000）
   * @param {number} options.offset - 偏移量（預設 0）
   * @returns {Promise<Array>} FG Financials 資料陣列
   */
  async fetchByFilters(userId, options = {}) {
    const { 
      plantId = null, 
      materialCode = null,
      currency = null,
      validDate = null,
      usePlantFallback = true,
      limit = 1000, 
      offset = 0 
    } = options;

    // 如果指定 plantId 且啟用 fallback 邏輯
    if (plantId && usePlantFallback) {
      // 先查詢指定 plant_id 的資料
      let plantQuery = supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', userId)
        .eq('plant_id', plantId)
        .order('material_code', { ascending: true })
        .range(offset, offset + limit - 1);

      if (materialCode) {
        plantQuery = plantQuery.eq('material_code', materialCode);
      }

      if (currency) {
        plantQuery = plantQuery.eq('currency', currency);
      }

      // 有效日期檢查
      if (validDate) {
        plantQuery = plantQuery
          .or(`valid_from.is.null,valid_from.lte.${validDate}`)
          .or(`valid_to.is.null,valid_to.gte.${validDate}`);
      }

      const { data: plantData, error: plantError } = await plantQuery;
      if (plantError) throw plantError;

      // 如果找到資料，直接返回
      if (plantData && plantData.length > 0) {
        return plantData;
      }

      // 找不到，fallback 到 global (plant_id is null)
      let globalQuery = supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', userId)
        .is('plant_id', null)
        .order('material_code', { ascending: true })
        .range(offset, offset + limit - 1);

      if (materialCode) {
        globalQuery = globalQuery.eq('material_code', materialCode);
      }

      if (currency) {
        globalQuery = globalQuery.eq('currency', currency);
      }

      if (validDate) {
        globalQuery = globalQuery
          .or(`valid_from.is.null,valid_from.lte.${validDate}`)
          .or(`valid_to.is.null,valid_to.gte.${validDate}`);
      }

      const { data: globalData, error: globalError } = await globalQuery;
      if (globalError) throw globalError;

      return globalData || [];
    }

    // 一般查詢（不使用 fallback）
    let query = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    // 工廠過濾（null = all plants）
    if (plantId) {
      query = query.eq('plant_id', plantId);
    } else if (plantId === null && !usePlantFallback) {
      // 明確查詢 global pricing
      query = query.is('plant_id', null);
    }

    // 物料代碼過濾
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // 幣別過濾
    if (currency) {
      query = query.eq('currency', currency);
    }

    // 有效日期檢查
    if (validDate) {
      query = query
        .or(`valid_from.is.null,valid_from.lte.${validDate}`)
        .or(`valid_to.is.null,valid_to.gte.${validDate}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 根據批次 ID 刪除 FG Financials（支援 undo）
   * @param {string} batchId - 批次 ID
   * @returns {Promise<Object>} { success, count }
   */
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('fg_financials')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  /**
   * 獲取特定成品的財務資料（含 plant fallback）
   * @param {string} userId - 使用者 ID
   * @param {string} materialCode - 物料代碼
   * @param {string} plantId - 工廠 ID（可選）
   * @param {string} currency - 幣別（預設 USD）
   * @returns {Promise<Object|null>} FG Financial 資料或 null
   */
  async getFgFinancial(userId, materialCode, plantId = null, currency = 'USD') {
    // 先查詢指定 plant_id 的資料
    if (plantId) {
      const { data: plantData, error: plantError } = await supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', userId)
        .eq('material_code', materialCode)
        .eq('plant_id', plantId)
        .eq('currency', currency)
        .order('valid_from', { ascending: false, nullsFirst: false })
        .limit(1)
        .single();

      if (!plantError && plantData) {
        return plantData;
      }
    }

    // Fallback 到 global (plant_id is null)
    const { data, error } = await supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', materialCode)
      .is('plant_id', null)
      .eq('currency', currency)
      .order('valid_from', { ascending: false, nullsFirst: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  },

  /**
   * 獲取 FG Financials（通用查詢方法）
   * @param {string} userId - 使用者 ID
   * @param {Object} options - 查詢選項
   * @returns {Promise<Array>} FG Financials 資料陣列
   */
  async getFgFinancials(userId, options = {}) {
    const { 
      plantId, 
      materialCode, 
      currency,
      limit = 100, 
      offset = 0 
    } = options;

    let query = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    if (plantId !== undefined) {
      if (plantId === null) {
        query = query.is('plant_id', null);
      } else {
        query = query.eq('plant_id', plantId);
      }
    }

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (currency) {
      query = query.eq('currency', currency);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Import Batches Operations
 * 管理匯入歷史和批次撤銷功能
 */
export { importBatchesService } from './importHistoryService';
