import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = "https://cbxvqqqulwytdblivtoe.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNieHZxcXF1bHd5dGRibGl2dG9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NjQzNjUsImV4cCI6MjA4MDA0MDM2NX0.3PeFtqJAkoxrosFeAiXbOklRCDxaQjH2VjXWwEiFyYI";

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

    const { error } = await supabase
      .from('user_files')
      .insert([payload]);

    if (error) throw error;
    return payload;
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
  // 批量插入供應商
  async insertSuppliers(suppliers) {
    if (!suppliers || suppliers.length === 0) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('suppliers')
      .insert(suppliers)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
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
  }
};

/**
 * Goods Receipts Operations
 */
export const goodsReceiptsService = {
  // 批量插入收貨記錄
  async batchInsert(userId, receipts, uploadFileId = null) {
    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0 };
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
      rejected_qty: r.rejected_qty || 0
    }));

    const { data, error } = await supabase
      .from('goods_receipts')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
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
  async batchInsert(userId, prices, uploadFileId = null) {
    if (!prices || prices.length === 0) {
      return { success: true, count: 0 };
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
      is_contract_price: p.is_contract_price || false
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
 * Import Batches Operations
 * 管理匯入歷史和批次撤銷功能
 */
export { importBatchesService } from './importHistoryService';
