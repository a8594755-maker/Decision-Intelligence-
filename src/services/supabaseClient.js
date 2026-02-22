import { createClient } from '@supabase/supabase-js';
import { ASSISTANT_NAME } from '../config/branding';
import { sendAgentLog } from '../utils/sendAgentLog';

// Supabase configuration - using environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const missingSupabaseError = new Error('Supabase configuration error: Missing environment variables');
export const SUPABASE_JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Accept': 'application/json'
});
export const RPC_JSON_OPTIONS = Object.freeze({
  headers: SUPABASE_JSON_HEADERS
});

const createDisabledQueryBuilder = () => {
  const terminalPromise = Promise.resolve({ data: null, error: missingSupabaseError, count: 0 });
  let proxy = null;

  const handler = {
    get(_target, property) {
      if (property === 'then') return terminalPromise.then.bind(terminalPromise);
      if (property === 'catch') return terminalPromise.catch.bind(terminalPromise);
      if (property === 'finally') return terminalPromise.finally.bind(terminalPromise);
      if (property === 'single' || property === 'maybeSingle') {
        return async () => ({ data: null, error: missingSupabaseError });
      }
      if (property === 'csv') {
        return async () => ({ data: '', error: missingSupabaseError });
      }
      return () => proxy;
    }
  };

  proxy = new Proxy({}, handler);
  return proxy;
};

const createDisabledSupabaseClient = () => ({
  from: () => createDisabledQueryBuilder(),
  rpc: async () => ({ data: null, error: missingSupabaseError }),
  auth: {
    getSession: async () => ({ data: { session: null }, error: missingSupabaseError }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: missingSupabaseError }),
    signUp: async () => ({ data: null, error: missingSupabaseError }),
    signOut: async () => ({ error: missingSupabaseError })
  }
});

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);
if (!isSupabaseConfigured) {
  console.error('❌ Missing Supabase environment variables!');
  console.error('Please ensure .env file exists with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseKey, {
    global: {
      headers: SUPABASE_JSON_HEADERS
    }
  })
  : createDisabledSupabaseClient();

/**
 * User Files Operations
 */
export const userFilesService = {
  // Get user's latest uploaded file
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

  // Get a specific file by id (scoped by user)
  async getFileById(userId, fileId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('*')
      .eq('user_id', userId)
      .eq('id', fileId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  // Save file to cloud
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
    return insertedData; // Return complete row with id
  },

  // Get all files
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
function normalizeSupplierStatusValue(status) {
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
  return 'active';
}

function normalizeSupplierNameValue(name) {
  return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function resolveInsertSuppliersParams(userIdOrSuppliers, maybeSuppliers) {
  if (Array.isArray(userIdOrSuppliers)) {
    const suppliers = userIdOrSuppliers;
    const inferredUserId = suppliers.find((item) => item?.user_id)?.user_id || null;
    return { userId: inferredUserId, suppliers };
  }

  return {
    userId: userIdOrSuppliers || null,
    suppliers: Array.isArray(maybeSuppliers) ? maybeSuppliers : []
  };
}

export const suppliersService = {
  // Batch insert suppliers (using upsert to avoid duplicates)
  async insertSuppliers(userIdOrSuppliers, maybeSuppliers) {
    const { userId, suppliers } = resolveInsertSuppliersParams(userIdOrSuppliers, maybeSuppliers);

    if (!suppliers || suppliers.length === 0) {
      return { success: true, count: 0, inserted: 0, updated: 0 };
    }
    if (!userId) {
      throw new Error('insertSuppliers requires userId (or suppliers[].user_id)');
    }

    // Check existing suppliers in database first
    const normalizedSuppliers = suppliers.map((supplier) => ({
      ...supplier,
      user_id: userId,
      supplier_code: supplier?.supplier_code || null,
      status: normalizeSupplierStatusValue(supplier?.status)
    }));

    const supplierNames = [...new Set(normalizedSuppliers.map((s) => s.supplier_name).filter(Boolean))];
    const supplierCodes = [...new Set(normalizedSuppliers.map((s) => s.supplier_code).filter(Boolean))];

    let existingByName = [];
    let existingByCode = [];

    if (supplierNames.length > 0) {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, supplier_name, supplier_code')
        .eq('user_id', userId)
        .in('supplier_name', supplierNames);
      if (error) {
        console.warn('Failed to check existing suppliers by name:', error);
      } else {
        existingByName = data || [];
      }
    }

    if (supplierCodes.length > 0) {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, supplier_name, supplier_code')
        .eq('user_id', userId)
        .in('supplier_code', supplierCodes);
      if (error) {
        console.warn('Failed to check existing suppliers by code:', error);
      } else {
        existingByCode = data || [];
      }
    }

    // Build Map of existing suppliers
    const existingMap = new Map();
    [...existingByName, ...existingByCode].forEach(s => {
      if (s.supplier_code) existingMap.set(`code:${s.supplier_code}`, s.id);
      if (s.supplier_name) existingMap.set(`name:${s.supplier_name}`, s.id);
    });

    // Separate new suppliers and suppliers to update
    const toInsert = [];
    const toUpdate = [];

    normalizedSuppliers.forEach(supplier => {
      const codeKey = supplier.supplier_code ? `code:${supplier.supplier_code}` : null;
      const nameKey = supplier.supplier_name ? `name:${supplier.supplier_name}` : null;
      
      const existingId = codeKey && existingMap.get(codeKey) || nameKey && existingMap.get(nameKey);
      
      if (existingId) {
        // Already exists, prepare update
        toUpdate.push({ ...supplier, id: existingId });
      } else {
        // New supplier, prepare insert
        toInsert.push(supplier);
      }
    });

    let insertedCount = 0;
    let updatedCount = 0;

    // Insert new suppliers
    if (toInsert.length > 0) {
      sendAgentLog({location:'supabaseClient.js:supplierService.upsert',message:'Before insert suppliers',data:{count:toInsert.length,firstItem:toInsert[0],columns:Object.keys(toInsert[0]||{})},sessionId:'debug-session',hypothesisId:'A,B'});
      
      const { data: insertedData, error: insertError } = await supabase
        .from('suppliers')
        .insert(toInsert)
        .select();

      sendAgentLog({location:'supabaseClient.js:supplierService.upsert',message:'After insert suppliers',data:{success:!insertError,error:insertError?{message:insertError.message,details:insertError.details,hint:insertError.hint,code:insertError.code}:null,insertedCount:insertedData?.length},sessionId:'debug-session',hypothesisId:'A,B,E'});

      if (insertError) {
        console.error('Insert error:', insertError);
        throw insertError;
      }
      insertedCount = insertedData?.length || 0;
    }

    // Update existing suppliers (merge info)
    if (toUpdate.length > 0) {
      for (const supplier of toUpdate) {
        const { id, ...updateData } = supplier;
        
        // Only update non-empty fields (preserve existing data)
        const fieldsToUpdate = {};
        Object.keys(updateData).forEach(key => {
          if (updateData[key] !== null && updateData[key] !== undefined && updateData[key] !== '') {
            fieldsToUpdate[key] = updateData[key];
          }
        });

        const { error: updateError } = await supabase
          .from('suppliers')
          .update(fieldsToUpdate)
          .eq('id', id)
          .eq('user_id', userId);

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

  // Get all suppliers
  async getAllSuppliers(userId) {
    if (!userId) {
      throw new Error('getAllSuppliers requires userId');
    }

    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // Update supplier
  async updateSupplier(userId, id, updates) {
    if (!userId) {
      throw new Error('updateSupplier requires userId');
    }

    const { data, error } = await supabase
      .from('suppliers')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select();

    if (error) throw error;
    return data[0];
  },

  // Delete supplier
  async deleteSupplier(userId, id) {
    if (!userId) {
      throw new Error('deleteSupplier requires userId');
    }

    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  },

  // Search suppliers
  async searchSuppliers(userId, searchTerm) {
    if (!userId) {
      throw new Error('searchSuppliers requires userId');
    }

    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('user_id', userId)
      .or(`supplier_name.ilike.%${searchTerm}%,supplier_code.ilike.%${searchTerm}%,notes.ilike.%${searchTerm}%`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // Find supplier by name (for deduplication during data import)
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

  // Find supplier by code
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

  // Find or create supplier (for auto-creation during import)
  async findOrCreate(userId, supplierData) {
    const { supplier_name, supplier_code } = supplierData;

    // Prioritize search by code
    if (supplier_code) {
      const existing = await this.findByCode(userId, supplier_code);
      if (existing) return existing;
    }

    // Search by name
    const existingByName = await this.findByName(userId, supplier_name);
    if (existingByName) return existingByName;

    // Create if not exists
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
   * Batch Upsert Suppliers (true batch processing)
   * @param {string} userId - User ID
   * @param {Array} suppliers - Supplier array [{supplier_name, supplier_code?, batch_id?}, ...]
   * @param {Object} options - Options
   * @param {number} options.chunkSize - Batch size (default 200)
   * @returns {Promise<Map>} Returns Map(key -> supplier_id), key is supplier_code or supplier_name_norm
   * Strategy: match/update by supplier_code first, then fallback to supplier_name_norm.
   */
  async batchUpsertSuppliers(userId, suppliers, options = {}) {
    const { chunkSize = 200 } = options;
    
    if (!userId) {
      throw new Error('batchUpsertSuppliers requires userId');
    }
    if (!suppliers || suppliers.length === 0) {
      return new Map();
    }

    console.log(`[batchUpsertSuppliers] Starting upsert for ${suppliers.length} suppliers`);

    // Prepare payload
    const payload = suppliers.map((s) => ({
      user_id: userId,
      supplier_name: s.supplier_name,
      supplier_code: s.supplier_code || null,
      supplier_name_norm: normalizeSupplierNameValue(s.supplier_name),
      status: normalizeSupplierStatusValue(s.status),
      batch_id: s.batch_id || null,
      contact_info: s.contact_info || null
    }));

    // Deduplicate input to avoid duplicate writes inside the same batch.
    const deduped = [];
    const seenKeys = new Set();
    payload.forEach((row) => {
      const key = row.supplier_code ? `code:${row.supplier_code}` : `name:${row.supplier_name_norm}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      deduped.push(row);
    });

    const supplierCodes = [...new Set(deduped.map((s) => s.supplier_code).filter(Boolean))];
    const supplierNameNorms = [...new Set(deduped.map((s) => s.supplier_name_norm).filter(Boolean))];

    const existingByCode = new Map();
    const existingByName = new Map();

    if (supplierCodes.length > 0) {
      for (let i = 0; i < supplierCodes.length; i += chunkSize) {
        const codeChunk = supplierCodes.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from('suppliers')
          .select('id, supplier_code, supplier_name_norm')
          .eq('user_id', userId)
          .in('supplier_code', codeChunk);
        if (error) {
          console.error('[batchUpsertSuppliers] Lookup by code error:', error);
          throw error;
        }
        (data || []).forEach((row) => {
          if (row.supplier_code) existingByCode.set(row.supplier_code, row);
          if (row.supplier_name_norm) existingByName.set(row.supplier_name_norm, row);
        });
      }
    }

    if (supplierNameNorms.length > 0) {
      for (let i = 0; i < supplierNameNorms.length; i += chunkSize) {
        const nameChunk = supplierNameNorms.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from('suppliers')
          .select('id, supplier_code, supplier_name_norm')
          .eq('user_id', userId)
          .in('supplier_name_norm', nameChunk);
        if (error) {
          console.error('[batchUpsertSuppliers] Lookup by name_norm error:', error);
          throw error;
        }
        (data || []).forEach((row) => {
          if (row.supplier_code) existingByCode.set(row.supplier_code, row);
          if (row.supplier_name_norm) existingByName.set(row.supplier_name_norm, row);
        });
      }
    }

    const rowsToUpdate = [];
    const rowsToInsert = [];
    deduped.forEach((row) => {
      const byCode = row.supplier_code ? existingByCode.get(row.supplier_code) : null;
      const byName = existingByName.get(row.supplier_name_norm);
      const matched = byCode || byName;
      if (matched?.id) {
        rowsToUpdate.push({ id: matched.id, row });
      } else {
        rowsToInsert.push(row);
      }
    });

    const allUpsertedIds = [];

    // Update matched records first (code match takes precedence).
    for (const { id, row } of rowsToUpdate) {
      const updatePayload = {
        supplier_name: row.supplier_name,
        supplier_name_norm: row.supplier_name_norm,
        status: row.status || 'active',
      };
      if (row.batch_id) {
        updatePayload.batch_id = row.batch_id;
      }
      if (row.supplier_code) {
        updatePayload.supplier_code = row.supplier_code;
      }
      if (row.contact_info) {
        updatePayload.contact_info = row.contact_info;
      }

      const { data, error } = await supabase
        .from('suppliers')
        .update(updatePayload)
        .eq('id', id)
        .eq('user_id', userId)
        .select('id, supplier_code, supplier_name_norm')
        .single();

      if (error) {
        console.error('[batchUpsertSuppliers] Update error:', error);
        throw new Error(`Supplier update failed: ${error.message || JSON.stringify(error)}`);
      }
      allUpsertedIds.push(data);
    }

    // Insert new records (with name_norm conflict fallback for concurrency safety).
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const chunk = rowsToInsert.slice(i, i + chunkSize);
      console.log(`[batchUpsertSuppliers] Upserting new chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(Math.max(rowsToInsert.length, 1) / chunkSize)} (${chunk.length} items)`);

      const { data: upsertedData, error: upsertError } = await supabase
        .from('suppliers')
        .upsert(chunk, {
          onConflict: 'user_id,supplier_name_norm',
          ignoreDuplicates: false
        })
        .select('id, supplier_code, supplier_name_norm');

      if (upsertError) {
        console.error('[batchUpsertSuppliers] Insert upsert error:', upsertError);
        throw new Error(`Supplier batch upsert failed: ${upsertError.message || JSON.stringify(upsertError)}`);
      }

      allUpsertedIds.push(...(upsertedData || []));
    }

    console.log(`[batchUpsertSuppliers] Upserted ${allUpsertedIds.length} suppliers`);

    // Build Map: key -> supplier_id
    // key prioritizes supplier_code, otherwise uses supplier_name_norm
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
  // Find or create material
  async findOrCreate(userId, materialData) {
    const { material_code, material_name, category, uom } = materialData;

    // Search by material_code
    const { data: existing, error: findError } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', material_code)
      .single();

    if (!findError && existing) {
      return existing;
    }

    // Create if not exists
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

  // Get all materials
  async getAll(userId) {
    const { data, error } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // Find material by code
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

  // Update material
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

  // Delete material
  async delete(materialId) {
    const { error } = await supabase
      .from('materials')
      .delete()
      .eq('id', materialId);

    if (error) throw error;
    return { success: true };
  },

  /**
   * Batch Upsert Materials (true batch processing)
   * @param {string} userId - User ID
   * @param {Array} materials - Material array [{material_code, material_name, category?, uom?, batch_id?}, ...]
   * @param {Object} options - Options
   * @param {number} options.chunkSize - Batch size (default 200)
   * @returns {Promise<Map>} Returns Map(material_code -> material_id)
   */
  async batchUpsertMaterials(userId, materials, options = {}) {
    const { chunkSize = 200 } = options;
    
    if (!materials || materials.length === 0) {
      return new Map();
    }

    console.log(`[batchUpsertMaterials] Starting upsert for ${materials.length} materials`);

    // Prepare upsert payload
    const payload = materials.map(m => ({
      user_id: userId,
      material_code: m.material_code,
      material_name: m.material_name || m.material_code,
      category: m.category || null,
      uom: m.uom || 'pcs',
      batch_id: m.batch_id || null,
      notes: m.notes || null
    }));

    // Batch upsert
    const allUpsertedIds = [];
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      
      console.log(`[batchUpsertMaterials] Upserting chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(payload.length / chunkSize)} (${chunk.length} items)`);

      // Use upsert (ON CONFLICT (user_id, material_code))
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

    // Build Map: material_code -> material_id
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
  // Batch insert goods receipts
  // Supports both old and new calling conventions:
  // - Old: batchInsert(userId, receipts, uploadFileId)
  // - New: batchInsert(userId, receipts, { uploadFileId, batchId })
  async batchInsert(userId, receipts, options = {}) {
    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0 };
    }

    // Backward compatible adapter: third param may be string (old API) or object (new API)
    let uploadFileId = null;
    let batchId = null;
    
    if (typeof options === 'string') {
      // Old API: third param is uploadFileId string
      uploadFileId = options;
    } else if (typeof options === 'object') {
      // New API: third param is { uploadFileId, batchId }
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
      batch_id: r.batch_id || batchId // Prioritize receipt's batch_id, otherwise use param
    }));

    const { data, error } = await supabase
      .from('goods_receipts')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  /**
   * Batch insert Goods Receipts (with progress callback)
   * @param {string} userId - User ID
   * @param {Array} receipts - Goods receipt array (with supplier_id/material_id)
   * @param {Object} options - Options
   * @param {number} options.chunkSize - Batch size (default 500)
   * @param {function} options.onProgress - Progress callback (current, total)
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsertReceipts(userId, receipts, options = {}) {
    const { chunkSize = 500, onProgress = null } = options;
    
    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0, data: [] };
    }

    console.log(`[batchInsertReceipts] Starting insert for ${receipts.length} receipts`);

    // Prepare payload
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

    // Batch insert
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

      // Call progress callback
      if (onProgress) {
        onProgress(insertedCount, receipts.length);
      }
    }

    console.log(`[batchInsertReceipts] Inserted ${insertedCount} receipts`);

    return { success: true, count: insertedCount, data: allInsertedData };
  },

  // Get goods receipts
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

  // Delete goods receipt
  async delete(receiptId) {
    const { error } = await supabase
      .from('goods_receipts')
      .delete()
      .eq('id', receiptId);

    if (error) throw error;
    return { success: true };
  },

  // Get statistics
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
  // Batch insert price records
  // Supports both old and new calling conventions:
  // - Old: batchInsert(userId, prices, uploadFileId)
  // - New: batchInsert(userId, prices, { uploadFileId, batchId })
  async batchInsert(userId, prices, options = {}) {
    if (!prices || prices.length === 0) {
      return { success: true, count: 0 };
    }

    // Backward compatible adapter: third param may be string (old API) or object (new API)
    let uploadFileId = null;
    let batchId = null;
    
    if (typeof options === 'string') {
      // Old API: third param is uploadFileId string
      uploadFileId = options;
    } else if (typeof options === 'object') {
      // New API: third param is { uploadFileId, batchId }
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
      batch_id: p.batch_id || batchId // Prioritize price's batch_id, otherwise use param
    }));

    const { data, error } = await supabase
      .from('price_history')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // Get price history
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

  // Delete price record
  async delete(priceId) {
    const { error } = await supabase
      .from('price_history')
      .delete()
      .eq('id', priceId);

    if (error) throw error;
    return { success: true };
  },

  // Get latest price
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
  // Get all conversations
  async getConversations(userId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // Create new conversation
  async createConversation(userId, title = 'New Conversation') {
    const newConversation = {
      id: Date.now().toString(),
      user_id: userId,
      title,
      messages: [{
        role: 'ai',
        content: `Hello! I am your ${ASSISTANT_NAME}. How can I help you today?`
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

  // Update conversation
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

  // Delete conversation
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
  // Sign in
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    return data;
  },

  // Sign up
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) throw error;
    return data;
  },

  // Sign out
  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return { success: true };
  },

  // Get current session
  async getSession() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  },

  // Listen for auth state changes
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
  }
};

/**
 * Upload Mappings Operations
 * Store and manage field mapping templates
 */
export const uploadMappingsService = {
  /**
   * Save or update field mapping template
   * @param {string} userId - User ID
   * @param {string} uploadType - Upload type
   * @param {Array} originalColumns - Original Excel column list
   * @param {Object} mappingJson - Field mapping relationships
   * @returns {Promise<Object>} Saved mapping record
   */
  async saveMapping(userId, uploadType, originalColumns, mappingJson) {
    const payload = {
      user_id: userId,
      upload_type: uploadType,
      original_columns: originalColumns,
      mapping_json: mappingJson
    };

    // Use upsert strategy: update if exists, insert if not
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
   * Get latest mapping template by user and upload type
   * @param {string} userId - User ID
   * @param {string} uploadType - Upload type
   * @returns {Promise<Object|null>} Mapping record or null
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
   * Get all mapping templates for user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Mapping record list
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
   * Delete specific mapping template
   * @param {string} userId - User ID
   * @param {string} uploadType - Upload type
   * @returns {Promise<Object>} Success message
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
   * Smart mapping: auto-apply previous mapping based on similarity
   * @param {string} userId - User ID
   * @param {string} uploadType - Upload type
   * @param {Array} currentColumns - Current Excel columns
   * @returns {Promise<Object>} Suggested mapping or empty object
   */
  async smartMapping(userId, uploadType, currentColumns) {
    const savedMapping = await this.getMapping(userId, uploadType);
    
    if (!savedMapping) {
      return {}; // No saved mapping
    }

    const { original_columns: savedColumns, mapping_json: savedMappingJson } = savedMapping;

    // Build new mapping object
    const smartMappingResult = {};

    // Iterate current columns, try to match previous mapping
    currentColumns.forEach(currentCol => {
      // Exact match
      if (savedColumns.includes(currentCol) && savedMappingJson[currentCol]) {
        smartMappingResult[currentCol] = savedMappingJson[currentCol];
      } else {
        // Fuzzy match (case-insensitive)
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
  // Batch insert BOM edges
  async batchInsert(userId, bomEdges, batchId = null) {
    if (!bomEdges || bomEdges.length === 0) {
      return { success: true, count: 0 };
    }

    // ✅ LOG 1: Print table / rows count / batchId type
    console.info("[ingest] table=bom_edges, rows=", bomEdges.length, ", batchId type=", typeof batchId, ", batchId value=", JSON.stringify(batchId).slice(0, 200));
    sendAgentLog({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG1 table/uploadType/rows/batchId',data:{tableName:'bom_edges',uploadType:'bom_edge',rows:bomEdges.length,batchIdType:typeof batchId,batchIdPreview:JSON.stringify(batchId).slice(0,200)},sessionId:'debug-session',hypothesisId:'A'});

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

    // ✅ LOG 2: Print first row keys + uuid field value types
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
    sendAgentLog({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG2 sample keys + uuid field types',data:{sampleKeys:sample?Object.keys(sample):null,uuidFieldTypes},sessionId:'debug-session',hypothesisId:'B'});

    // ✅ LOG 3: Print request body top-level structure
    console.info("[ingest] payload is array:", Array.isArray(payload), ", length=", payload.length);
    console.info("[ingest] payload preview (first 800 chars):", JSON.stringify(payload).slice(0, 800));
    sendAgentLog({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG3 request body top-level',data:{bodyIsArray:Array.isArray(payload),bodyLength:payload.length,bodyTopLevelKeys:Array.isArray(payload)?null:Object.keys(payload),bodyPreview:JSON.stringify(payload).slice(0,800)},sessionId:'debug-session',hypothesisId:'C'});

    const { data, error } = await supabase
      .from('bom_edges')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // Get BOM edges
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

  // Get BOM edges (for BOM Explosion calculation)
  // Supports filtering by plantId and timeBuckets (considering validity)
  async fetchBomEdges(userId, plantId = null, timeBuckets = []) {
    let query = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId)
      .order('parent_material', { ascending: true });

    // Plant filter: match plant_id or NULL (universal BOM)
    if (plantId) {
      query = query.or(`plant_id.eq.${plantId},plant_id.is.null`);
    }

    // Validity filter: if timeBuckets provided, need to check valid_from/valid_to
    // Note: only basic conditions filtered here, actual validity check done in calculation logic
    // Because time_bucket needs to be converted to date before comparison

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Demand FG Operations
 */
export const demandFgService = {
  // Batch insert FG demands
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

  // Get FG demands
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

  // Get FG demands (for BOM Explosion calculation)
  // Supports filtering by plantId and timeBuckets
  async fetchDemandFg(userId, plantId = null, timeBuckets = []) {
    let query = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true });

    // Plant filter
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Time bucket filter: if timeBuckets array provided, only get demands for these buckets
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Demand Forecast Service - Store forecast results with P10/P50/P90 confidence intervals
 */
export const demandForecastService = {
  // Batch insert demand forecast results
  async batchInsert(userId, forecasts) {
    if (!forecasts || forecasts.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = forecasts.map(forecast => ({
      user_id: userId,
      forecast_run_id: forecast.forecast_run_id,
      material_code: forecast.material_code,
      plant_id: forecast.plant_id,
      time_bucket: forecast.time_bucket,
      p10: forecast.p10 ?? null,
      p50: forecast.p50,
      p90: forecast.p90 ?? null,
      model_version: forecast.model_version,
      train_window_buckets: forecast.train_window_buckets ?? null,
      metrics: forecast.metrics || {}
    }));

    const { data, error } = await supabase
      .from('demand_forecast')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // Get demand forecasts by run ID
  async getForecastsByRun(userId, forecastRunId, options = {}) {
    const { materialCode, plantId, limit = 1000, offset = 0 } = options;

    let query = supabase
      .from('demand_forecast')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .order('material_code', { ascending: true })
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Get unique material codes for a forecast run
  async getMaterialsByRun(userId, forecastRunId) {
    const { data, error } = await supabase
      .from('demand_forecast')
      .select('material_code')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);

    if (error) throw error;
    return [...new Set((data || []).map(d => d.material_code))];
  },

  // Get historical demand_fg data for training the forecast model
  async getHistoricalDemandFg(userId, plantId, materialCode, endTimeBucket, windowBuckets) {
    // Get historical data up to endTimeBucket, limited to windowBuckets
    let query = supabase
      .from('demand_fg')
      .select('time_bucket, demand_qty, material_code, plant_id')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: false })
      .limit(windowBuckets);

    // Only filter by material_code if explicitly provided
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Filter to get only buckets before or equal to endTimeBucket
    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    
    // Return in ascending order (oldest first)
    return (data || []).reverse();
  },

  // Delete forecasts by run ID (for cleanup/re-runs)
  async deleteForecastsByRun(userId, forecastRunId) {
    const { error } = await supabase
      .from('demand_forecast')
      .delete()
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);

    if (error) throw error;
    return { success: true };
  }
};

/**
 * Forecast Runs - One record per BOM Explosion run, for traceability
 */
export const forecastRunsService = {
  async createRun(userId, options = {}) {
    const {
      scenarioName = 'baseline',
      parameters = {},
      kind = 'bom_explosion'
    } = options;
    const { data, error } = await supabase
      .from('forecast_runs')
      .insert({
        user_id: userId,
        scenario_name: scenarioName,
        parameters: parameters,
        kind: kind,
        status: 'pending'
      })
      .select('id, created_at, scenario_name')
      .single();
    if (error) throw error;
    return data;
  },

  async getRun(runId) {
    const { data, error } = await supabase
      .from('forecast_runs')
      .select('*')
      .eq('id', runId)
      .single();
    if (error) throw error;
    return data;
  },

  async updateRun(runId, updates) {
    const { data, error } = await supabase
      .from('forecast_runs')
      .update(updates)
      .eq('id', runId)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async listRuns(userId, options = {}) {
    const { limit = 50 } = options;
    let query = supabase
      .from('forecast_runs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Component Demand Operations
 */
export const componentDemandService = {
  // Get Component demands
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

  // Batch Upsert Component demands (for BOM Explosion calculation results)
  // Uses material_code + plant_id + time_bucket + user_id as unique key for upsert
  // Note: if recalculating same batch, should call deleteComponentOutputsByBatch first to clear old data
  async upsertComponentDemand(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // Prepare upsert data - only include fields that exist in DB schema
      const payload = rows.map((row, index) => {
        // Validate required fields
        if (!row.user_id || !row.material_code || !row.plant_id || !row.time_bucket) {
          throw new Error(`Row ${index}: Missing required fields (user_id, material_code, plant_id, or time_bucket)`);
        }
        if (row.demand_qty === undefined || row.demand_qty === null) {
          throw new Error(`Row ${index}: Missing demand_qty`);
        }

        // Build payload - with forecast_run_id (versioned)
        const record = {
          user_id: row.user_id,
          batch_id: row.batch_id || null,
          forecast_run_id: row.forecast_run_id ?? null,
          material_code: row.material_code,
          plant_id: row.plant_id,
          time_bucket: row.time_bucket,
          demand_qty: row.demand_qty,
          uom: row.uom || 'pcs',
          source_fg_material: null,
          source_fg_demand_id: null,
          bom_level: null,
          notes: row.notes || null
        };

        if (row.id) {
          record.id = row.id;
        }

        return record;
      });

      // Unique constraint: (user_id, forecast_run_id, material_code, plant_id, time_bucket)
      const { data, error } = await supabase
        .from('component_demand')
        .upsert(payload, {
          onConflict: 'user_id,forecast_run_id,material_code,plant_id,time_bucket',
          ignoreDuplicates: false
        })
        .select();

      if (error) {
        console.warn('Upsert failed, attempting fallback strategy:', {
          error: error.message,
          code: error.code,
          hint: error.hint
        });

        // Fallback: delete then insert (by user_id + forecast_run_id + dimensions)
        const userId = rows[0].user_id;
        const forecastRunId = rows[0].forecast_run_id ?? null;
        const materialCodes = [...new Set(rows.map(r => r.material_code))];
        const plantIds = [...new Set(rows.map(r => r.plant_id))];
        const timeBuckets = [...new Set(rows.map(r => r.time_bucket))];

        let existingQuery = supabase
          .from('component_demand')
          .select('id')
          .eq('user_id', userId)
          .in('material_code', materialCodes)
          .in('plant_id', plantIds)
          .in('time_bucket', timeBuckets);
        if (forecastRunId) {
          existingQuery = existingQuery.eq('forecast_run_id', forecastRunId);
        } else {
          existingQuery = existingQuery.is('forecast_run_id', null);
        }
        const { data: existingData, error: queryError } = await existingQuery;

        if (queryError) {
          const errorDetails = {
            message: queryError.message,
            code: queryError.code,
            details: queryError.details
          };
          console.error('Query existing records failed:', errorDetails);
          throw new Error(`Query failed: ${queryError.message}`);
        }

        // If existing records found, delete first
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

        // Insert new records
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
      // Catch and re-throw with clearer error
      if (error.message.includes('Missing required fields') || error.message.includes('Missing demand_qty')) {
        throw error; // Directly throw validation error
      }
      
      const enhancedError = new Error(
        `upsertComponentDemand error: ${error.message}`
      );
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

  // Delete Component demands by batch_id
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

  // Delete Component outputs (including component_demand and component_demand_trace)
  // Used to clear old data when recalculating a batch
  async deleteComponentOutputsByBatch(batchId) {
    if (!batchId) {
      return { success: true, componentDemandCount: 0, traceCount: 0 };
    }

    // Delete trace records first (due to foreign key relationship)
    const { data: traceData, error: traceError } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (traceError) throw traceError;

    // Then delete Component demands
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

  /**
   * Get component_demand for a specific forecast run (for Risk / Inventory Projection)
   * @param {string} userId
   * @param {string} forecastRunId
   * @param {{ timeBuckets?: string[], plantId?: string }} [options]
   */
  async getComponentDemandsByForecastRun(userId, forecastRunId, options = {}) {
    if (!userId || !forecastRunId) return [];
    let query = supabase
      .from('component_demand')
      .select('material_code, plant_id, time_bucket, demand_qty')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .order('time_bucket', { ascending: true });
    const { timeBuckets, plantId } = options;
    if (plantId) query = query.eq('plant_id', plantId);
    if (Array.isArray(timeBuckets) && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Get Component demands by batch_id (with filtering and pagination)
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
  // Get trace information
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
      // Need to query through component_demand table relationship
      query = query.eq('component_demand.material_code', componentMaterial);
    }

    if (timeBucket) {
      // Need to query through component_demand table relationship
      query = query.eq('component_demand.time_bucket', timeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Batch insert Component demand trace records
  // Note: per user requirements, trace uses fg_material_code/component_material_code/path_json
  // But schema uses fg_demand_id/component_demand_id/bom_edge_id
  // Implemented per schema here, but can add extra fields (if schema supports)
  async insertComponentDemandTrace(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // Prepare insert data - only include fields that exist in DB schema
      const payload = rows.map((row, index) => {
        // Validate required fields
        if (!row.user_id || !row.component_demand_id || !row.fg_demand_id) {
          throw new Error(`Row ${index}: Missing required fields (user_id, component_demand_id, or fg_demand_id)`);
        }

        return {
          user_id: row.user_id,
          batch_id: row.batch_id || null,
          forecast_run_id: row.forecast_run_id ?? null,
          component_demand_id: row.component_demand_id,
          fg_demand_id: row.fg_demand_id,
          bom_edge_id: row.bom_edge_id || null,
          qty_multiplier: row.qty_multiplier || null,
          bom_level: row.bom_level || null,
          trace_meta: row.trace_meta || {}
        };
      });

      const { data, error } = await supabase
        .from('component_demand_trace')
        .insert(payload)
        .select();

      if (error) {
        // Detailed error message
        const errorDetails = {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          sample_payload: payload.slice(0, 2) // Show first 2 payload samples
        };
        console.error('insertComponentDemandTrace failed:', errorDetails);
        throw new Error(`Database insert failed: ${error.message} (code: ${error.code})`);
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      // Catch and re-throw with clearer error
      if (error.message.includes('Missing required fields')) {
        throw error; // Directly throw validation error
      }
      
      const enhancedError = new Error(
        `insertComponentDemandTrace error: ${error.message}`
      );
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

  // Delete trace records by batch_id
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

  // Get trace records by batch_id (with filtering and pagination)
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
 * Manage purchase order open line items
 */
export const poOpenLinesService = {
  /**
   * Batch insert PO Open Lines
   * @param {string} userId - User ID
   * @param {Array} rows - PO Open Lines data array
   * @param {string} batchId - Batch ID (optional)
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

    // Use upsert to avoid duplicates (based on UNIQUE constraint)
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
   * Query PO Open Lines by conditions
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {string} options.plantId - Plant ID (null = all plants)
   * @param {Array<string>} options.timeBuckets - Time bucket array (null = all time)
   * @param {string} options.materialCode - Material code (optional)
   * @param {string} options.poNumber - PO number (optional)
   * @param {string} options.supplierId - Supplier ID (optional)
   * @param {string} options.status - Status (optional)
   * @param {number} options.limit - Row limit (default 1000)
   * @param {number} options.offset - Offset (default 0)
   * @returns {Promise<Array>} PO Open Lines data array
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

    // Plant filter (null = all plants)
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Time bucket filter (null = all time)
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    // Material code filter
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // PO number filter
    if (poNumber) {
      query = query.eq('po_number', poNumber);
    }

    // Supplier filter
    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }

    // Status filter
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * Delete PO Open Lines by batch ID (supports undo)
   * @param {string} batchId - Batch ID
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
   * Get inbound data for specified time_buckets (for Inventory Projection)
   * @param {string} userId - User ID
   * @param {string[]} timeBuckets - Time bucket array
   * @param {string|null} plantId - Plant ID (null = all plants)
   * @returns {Promise<Array<{ material_code: string, plant_id: string, time_bucket: string, open_qty: number }>>}
   */
  async getInboundByBuckets(userId, timeBuckets, plantId = null) {
    if (!userId || !Array.isArray(timeBuckets) || timeBuckets.length === 0) {
      return [];
    }

    const pickInboundQty = row => {
      const qty = Number(
        row.open_qty ??
        row.qty_open ??
        row.inbound_qty ??
        row.order_qty ??
        row.qty ??
        row.quantity ??
        0
      );
      return Number.isFinite(qty) ? qty : 0;
    };

    let query = supabase
      .from('po_open_lines')
      .select('*')
      .eq('user_id', userId)
      .in('time_bucket', timeBuckets)
      .order('time_bucket', { ascending: true });

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(row => ({
      material_code: row.material_code ?? row.item ?? null,
      plant_id: row.plant_id ?? row.factory ?? null,
      time_bucket: row.time_bucket ?? row.timeBucket ?? row.bucket ?? null,
      open_qty: pickInboundQty(row)
    }));
  },

  /**
   * Get PO Open Lines (general query method)
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} PO Open Lines data array
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
 * Manage inventory snapshot data
 */
export const inventorySnapshotsService = {
  /**
   * Batch insert Inventory Snapshots
   * @param {string} userId - User ID
   * @param {Array} rows - Inventory Snapshots data array
   * @param {string} batchId - Batch ID (optional)
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

    // Use upsert to avoid duplicates (based on UNIQUE constraint)
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
   * Query Inventory Snapshots by conditions
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {string} options.plantId - Plant ID (null = all plants)
   * @param {string} options.materialCode - Material code (optional)
   * @param {string} options.snapshotDate - Snapshot date (optional)
   * @param {string} options.startDate - Start date (optional)
   * @param {string} options.endDate - End date (optional)
   * @param {number} options.limit - Row limit (default 1000)
   * @param {number} options.offset - Offset (default 0)
   * @returns {Promise<Array>} Inventory Snapshots data array
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

    // Plant filter (null = all plants)
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Material code filter
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // Specific date filter
    if (snapshotDate) {
      query = query.eq('snapshot_date', snapshotDate);
    }

    // Date range filter
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
   * Get latest inventory snapshot per material+plant (for Inventory Projection / Risk)
   * @param {string} userId
   * @param {string|null} plantId
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<Array<{ material_code: string, plant_id: string, on_hand_qty: number, safety_stock: number, snapshot_date?: string, created_at?: string }>>}
   */
  async getLatestInventorySnapshots(userId, plantId = null, opts = {}) {
    if (!userId) return [];
    const limit = opts.limit ?? 10000;
    let query = supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .limit(limit);
    if (plantId) query = query.eq('plant_id', plantId);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data || []).map(r => ({
      ...r,
      on_hand_qty: r.on_hand_qty ?? r.onhand_qty ?? 0
    }));
    const byKey = new Map();
    for (const r of rows) {
      const key = `${(r.material_code || '').trim().toUpperCase()}|${(r.plant_id || '').trim().toUpperCase()}`;
      if (!byKey.has(key)) byKey.set(key, { ...r });
    }
    return Array.from(byKey.values());
  },

  /**
   * Delete Inventory Snapshots by batch ID (supports undo)
   * @param {string} batchId - Batch ID
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
   * Get latest inventory snapshot
   * @param {string} userId - User ID
   * @param {string} materialCode - Material code
   * @param {string} plantId - Plant ID
   * @returns {Promise<Object|null>} Latest inventory snapshot or null
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
   * Get Inventory Snapshots (general query method)
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Inventory Snapshots data array
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
 * Manage finished goods financial data (pricing and profit)
 */
export const fgFinancialsService = {
  /**
   * Batch insert FG Financials
   * @param {string} userId - User ID
   * @param {Array} rows - FG Financials data array
   * @param {string} batchId - Batch ID (optional)
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

    // Note: fg_financials uses UNIQUE INDEX with COALESCE
    // Cannot directly use onConflict with column names
    // Use query-then-decide insert/update strategy instead
    try {
      const { data, error } = await supabase
        .from('fg_financials')
        .insert(payload)
        .select();

      if (error) {
        // If unique violation, try upsert (requires DB support)
        if (error.code === '23505') { // Unique violation
          // Fallback: process upsert row by row
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
   * Query FG Financials by conditions
   * Special handling: prioritize querying specified plant_id data, fallback to global (plant_id is null) if not found
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {string} options.plantId - Plant ID (null = all plants, or used for fallback logic)
   * @param {string} options.materialCode - Material code (optional)
   * @param {string} options.currency - Currency (optional)
   * @param {string} options.validDate - Valid date (for checking valid_from/valid_to, optional)
   * @param {boolean} options.usePlantFallback - Whether to use plant fallback logic (default true)
   * @param {number} options.limit - Row limit (default 1000)
   * @param {number} options.offset - Offset (default 0)
   * @returns {Promise<Array>} FG Financials data array
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

    // If plantId specified and fallback logic enabled
    if (plantId && usePlantFallback) {
      // First query data for specified plant_id
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

      // Valid date check
      if (validDate) {
        plantQuery = plantQuery
          .or(`valid_from.is.null,valid_from.lte.${validDate}`)
          .or(`valid_to.is.null,valid_to.gte.${validDate}`);
      }

      const { data: plantData, error: plantError } = await plantQuery;
      if (plantError) throw plantError;

      // If data found, return directly
      if (plantData && plantData.length > 0) {
        return plantData;
      }

      // Not found, fallback to global (plant_id is null)
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

    // General query (without fallback)
    let query = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    // Plant filter (null = all plants)
    if (plantId) {
      query = query.eq('plant_id', plantId);
    } else if (plantId === null && !usePlantFallback) {
      // Explicitly query global pricing
      query = query.is('plant_id', null);
    }

    // Material code filter
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // Currency filter
    if (currency) {
      query = query.eq('currency', currency);
    }

    // Valid date check
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
   * Delete FG Financials by batch ID (supports undo)
   * @param {string} batchId - Batch ID
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
   * Get financial data for a specific finished good (with plant fallback)
   * @param {string} userId - User ID
   * @param {string} materialCode - Material code
   * @param {string} plantId - Plant ID (optional)
   * @param {string} currency - Currency (default USD)
   * @returns {Promise<Object|null>} FG Financial data or null
   */
  async getFgFinancial(userId, materialCode, plantId = null, currency = 'USD') {
    // First query data for specified plant_id
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

    // Fallback to global (plant_id is null)
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
   * Get FG Financials (general query method)
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} FG Financials data array
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
 * Manage import history and batch undo functionality
 */
export { importBatchesService } from './importHistoryService';
