import { sendAgentLog } from '../../utils/sendAgentLog';
import { supabase } from './core.js';

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
    suppliers: Array.isArray(maybeSuppliers) ? maybeSuppliers : [],
  };
}

export const suppliersService = {
  async insertSuppliers(userIdOrSuppliers, maybeSuppliers) {
    const { userId, suppliers } = resolveInsertSuppliersParams(userIdOrSuppliers, maybeSuppliers);

    if (!suppliers || suppliers.length === 0) {
      return { success: true, count: 0, inserted: 0, updated: 0 };
    }
    if (!userId) {
      throw new Error('insertSuppliers requires userId (or suppliers[].user_id)');
    }

    const normalizedSuppliers = suppliers.map((supplier) => ({
      ...supplier,
      user_id: userId,
      supplier_code: supplier?.supplier_code || null,
      status: normalizeSupplierStatusValue(supplier?.status),
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

    const existingMap = new Map();
    [...existingByName, ...existingByCode].forEach((supplier) => {
      if (supplier.supplier_code) existingMap.set(`code:${supplier.supplier_code}`, supplier.id);
      if (supplier.supplier_name) existingMap.set(`name:${supplier.supplier_name}`, supplier.id);
    });

    const toInsert = [];
    const toUpdate = [];

    normalizedSuppliers.forEach((supplier) => {
      const codeKey = supplier.supplier_code ? `code:${supplier.supplier_code}` : null;
      const nameKey = supplier.supplier_name ? `name:${supplier.supplier_name}` : null;
      const existingId = (codeKey && existingMap.get(codeKey)) || (nameKey && existingMap.get(nameKey));

      if (existingId) {
        toUpdate.push({ ...supplier, id: existingId });
      } else {
        toInsert.push(supplier);
      }
    });

    let insertedCount = 0;
    let updatedCount = 0;

    if (toInsert.length > 0) {
      sendAgentLog({
        location: 'supabase/masterDataService.js:suppliersService.insertSuppliers',
        message: 'Before insert suppliers',
        data: { count: toInsert.length, firstItem: toInsert[0], columns: Object.keys(toInsert[0] || {}) },
        sessionId: 'debug-session',
        hypothesisId: 'A,B',
      });

      const { data: insertedData, error: insertError } = await supabase
        .from('suppliers')
        .insert(toInsert)
        .select();

      sendAgentLog({
        location: 'supabase/masterDataService.js:suppliersService.insertSuppliers',
        message: 'After insert suppliers',
        data: {
          success: !insertError,
          error: insertError ? {
            message: insertError.message,
            details: insertError.details,
            hint: insertError.hint,
            code: insertError.code,
          } : null,
          insertedCount: insertedData?.length,
        },
        sessionId: 'debug-session',
        hypothesisId: 'A,B,E',
      });

      if (insertError) {
        console.error('Insert error:', insertError);
        throw insertError;
      }
      insertedCount = insertedData?.length || 0;
    }

    if (toUpdate.length > 0) {
      for (const supplier of toUpdate) {
        const { id, ...updateData } = supplier;
        const fieldsToUpdate = {};
        Object.keys(updateData).forEach((key) => {
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
      updated: updatedCount,
    };
  },

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

  async searchSuppliers(userId, searchTerm) {
    if (!userId) {
      throw new Error('searchSuppliers requires userId');
    }

    // Sanitize to prevent PostgREST filter injection
    const safe = String(searchTerm).replace(/[,.()"\\]/g, '');
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('user_id', userId)
      .or(`supplier_name.ilike.%${safe}%,supplier_code.ilike.%${safe}%,notes.ilike.%${safe}%`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  async findByName(userId, supplierName) {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('user_id', userId)
      .eq('supplier_name', supplierName)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  },

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

  async findOrCreate(userId, supplierData) {
    const { supplier_name, supplier_code } = supplierData;

    if (supplier_code) {
      const existing = await this.findByCode(userId, supplier_code);
      if (existing) return existing;
    }

    const existingByName = await this.findByName(userId, supplier_name);
    if (existingByName) return existingByName;

    const newSupplier = {
      user_id: userId,
      supplier_name,
      supplier_code: supplier_code || null,
      status: 'active',
    };

    const { data, error } = await supabase
      .from('suppliers')
      .insert(newSupplier)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async batchUpsertSuppliers(userId, suppliers, options = {}) {
    const { chunkSize = 200 } = options;

    if (!userId) {
      throw new Error('batchUpsertSuppliers requires userId');
    }
    if (!suppliers || suppliers.length === 0) {
      return new Map();
    }

    console.log(`[batchUpsertSuppliers] Starting upsert for ${suppliers.length} suppliers`);

    const payload = suppliers.map((supplier) => ({
      user_id: userId,
      supplier_name: supplier.supplier_name,
      supplier_code: supplier.supplier_code || null,
      supplier_name_norm: normalizeSupplierNameValue(supplier.supplier_name),
      status: normalizeSupplierStatusValue(supplier.status),
      batch_id: supplier.batch_id || null,
      contact_info: supplier.contact_info || null,
    }));

    const deduped = [];
    const seenKeys = new Set();
    payload.forEach((row) => {
      const key = row.supplier_code ? `code:${row.supplier_code}` : `name:${row.supplier_name_norm}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      deduped.push(row);
    });

    const supplierCodes = [...new Set(deduped.map((supplier) => supplier.supplier_code).filter(Boolean))];
    const supplierNameNorms = [...new Set(deduped.map((supplier) => supplier.supplier_name_norm).filter(Boolean))];

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

    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const chunk = rowsToInsert.slice(i, i + chunkSize);
      console.log(`[batchUpsertSuppliers] Upserting new chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(Math.max(rowsToInsert.length, 1) / chunkSize)} (${chunk.length} items)`);

      const { data: upsertedData, error: upsertError } = await supabase
        .from('suppliers')
        .upsert(chunk, {
          onConflict: 'user_id,supplier_name_norm',
          ignoreDuplicates: false,
        })
        .select('id, supplier_code, supplier_name_norm');

      if (upsertError) {
        console.error('[batchUpsertSuppliers] Insert upsert error:', upsertError);
        throw new Error(`Supplier batch upsert failed: ${upsertError.message || JSON.stringify(upsertError)}`);
      }

      allUpsertedIds.push(...(upsertedData || []));
    }

    console.log(`[batchUpsertSuppliers] Upserted ${allUpsertedIds.length} suppliers`);

    const supplierIdMap = new Map();
    allUpsertedIds.forEach((supplier) => {
      if (supplier.supplier_code) {
        supplierIdMap.set(supplier.supplier_code, supplier.id);
      }
      if (supplier.supplier_name_norm) {
        supplierIdMap.set(supplier.supplier_name_norm, supplier.id);
      }
    });

    console.log(`[batchUpsertSuppliers] Created map with ${supplierIdMap.size} entries`);

    return supplierIdMap;
  },
};

export const materialsService = {
  async findOrCreate(userId, materialData) {
    const { material_code, material_name, category, uom } = materialData;

    const { data: existing, error: findError } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', material_code)
      .single();

    if (!findError && existing) {
      return existing;
    }

    const newMaterial = {
      user_id: userId,
      material_code,
      material_name: material_name || material_code,
      category: category || null,
      uom: uom || 'pcs',
    };

    const { data, error } = await supabase
      .from('materials')
      .insert(newMaterial)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getAll(userId) {
    const { data, error } = await supabase
      .from('materials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true });

    if (error) throw error;
    return data || [];
  },

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

  async update(userId, materialId, updates) {
    if (!userId) throw new Error('materials.update requires userId');
    const { data, error } = await supabase
      .from('materials')
      .update(updates)
      .eq('id', materialId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(userId, materialId) {
    if (!userId) throw new Error('materials.delete requires userId');
    const { error } = await supabase
      .from('materials')
      .delete()
      .eq('id', materialId)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  },

  async batchUpsertMaterials(userId, materials, options = {}) {
    const { chunkSize = 200 } = options;

    if (!materials || materials.length === 0) {
      return new Map();
    }

    console.log(`[batchUpsertMaterials] Starting upsert for ${materials.length} materials`);

    const payload = materials.map((material) => ({
      user_id: userId,
      material_code: material.material_code,
      material_name: material.material_name || material.material_code,
      category: material.category || null,
      uom: material.uom || 'pcs',
      batch_id: material.batch_id || null,
      notes: material.notes || null,
    }));

    const allUpsertedIds = [];
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      console.log(`[batchUpsertMaterials] Upserting chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(payload.length / chunkSize)} (${chunk.length} items)`);

      const { data: upsertedData, error: upsertError } = await supabase
        .from('materials')
        .upsert(chunk, {
          onConflict: 'user_id,material_code',
          ignoreDuplicates: false,
        })
        .select('id, material_code');

      if (upsertError) {
        console.error('[batchUpsertMaterials] Upsert error:', upsertError);
        throw new Error(`Material batch upsert failed: ${upsertError.message || JSON.stringify(upsertError)}`);
      }

      allUpsertedIds.push(...(upsertedData || []));
    }

    console.log(`[batchUpsertMaterials] Upserted ${allUpsertedIds.length} materials`);

    const materialIdMap = new Map();
    allUpsertedIds.forEach((material) => {
      materialIdMap.set(material.material_code, material.id);
    });

    console.log(`[batchUpsertMaterials] Created map with ${materialIdMap.size} entries`);

    return materialIdMap;
  },
};

