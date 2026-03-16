import { supabase } from './core.js';

export const poOpenLinesService = {
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map((row) => ({
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
      notes: row.notes || null,
    }));

    const { data, error } = await supabase
      .from('po_open_lines')
      .upsert(payload, {
        onConflict: 'user_id,po_number,po_line,time_bucket',
        ignoreDuplicates: false,
      })
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  async fetchByFilters(userId, options = {}) {
    const {
      plantId = null,
      timeBuckets = null,
      materialCode = null,
      poNumber = null,
      supplierId = null,
      status = null,
      limit = 1000,
      offset = 0,
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
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }
    if (poNumber) {
      query = query.eq('po_number', poNumber);
    }
    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

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

  async getInboundByBuckets(userId, timeBuckets, plantId = null) {
    if (!userId || !Array.isArray(timeBuckets) || timeBuckets.length === 0) {
      return [];
    }

    const pickInboundQty = (row) => {
      const qty = Number(
        row.open_qty ??
        row.qty_open ??
        row.inbound_qty ??
        row.order_qty ??
        row.qty ??
        row.quantity ??
        0,
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
    return (data || []).map((row) => ({
      material_code: row.material_code ?? row.item ?? null,
      plant_id: row.plant_id ?? row.factory ?? null,
      time_bucket: row.time_bucket ?? row.timeBucket ?? row.bucket ?? null,
      open_qty: pickInboundQty(row),
    }));
  },

  async getPoOpenLines(userId, options = {}) {
    const {
      plantId,
      materialCode,
      startTimeBucket,
      endTimeBucket,
      limit = 100,
      offset = 0,
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
  },
};

export const inventorySnapshotsService = {
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map((row) => ({
      user_id: userId,
      batch_id: batchId,
      material_code: row.material_code,
      plant_id: row.plant_id,
      snapshot_date: row.snapshot_date,
      onhand_qty: row.onhand_qty,
      allocated_qty: row.allocated_qty !== null && row.allocated_qty !== undefined ? row.allocated_qty : 0,
      safety_stock: row.safety_stock !== null && row.safety_stock !== undefined ? row.safety_stock : 0,
      uom: row.uom || 'pcs',
      notes: row.notes || null,
    }));

    const { data, error } = await supabase
      .from('inventory_snapshots')
      .upsert(payload, {
        onConflict: 'user_id,material_code,plant_id,snapshot_date',
        ignoreDuplicates: false,
      })
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  async fetchByFilters(userId, options = {}) {
    const {
      plantId = null,
      materialCode = null,
      snapshotDate = null,
      startDate = null,
      endDate = null,
      limit = 1000,
      offset = 0,
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
    const rows = (data || []).map((row) => ({
      ...row,
      on_hand_qty: row.on_hand_qty ?? row.onhand_qty ?? 0,
    }));
    const byKey = new Map();
    for (const row of rows) {
      const key = `${(row.material_code || '').trim().toUpperCase()}|${(row.plant_id || '').trim().toUpperCase()}`;
      if (!byKey.has(key)) byKey.set(key, { ...row });
    }
    return Array.from(byKey.values());
  },

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
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  },

  async getInventorySnapshots(userId, options = {}) {
    const {
      plantId,
      materialCode,
      snapshotDate,
      limit = 100,
      offset = 0,
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
  },
};

export const fgFinancialsService = {
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map((row) => ({
      user_id: userId,
      batch_id: batchId,
      material_code: row.material_code,
      unit_margin: row.unit_margin,
      plant_id: row.plant_id || null,
      unit_price: row.unit_price !== null && row.unit_price !== undefined ? row.unit_price : null,
      currency: row.currency || 'USD',
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
      notes: row.notes || null,
    }));

    try {
      const { data, error } = await supabase
        .from('fg_financials')
        .insert(payload)
        .select();

      if (error) {
        if (error.code === '23505') {
          const results = [];
          for (const row of payload) {
            const { data: upsertData, error: upsertError } = await supabase
              .from('fg_financials')
              .upsert(row, {
                ignoreDuplicates: false,
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

  async fetchByFilters(userId, options = {}) {
    const {
      plantId = null,
      materialCode = null,
      currency = null,
      validDate = null,
      usePlantFallback = true,
      limit = 1000,
      offset = 0,
    } = options;

    if (plantId && usePlantFallback) {
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
      if (validDate) {
        plantQuery = plantQuery
          .or(`valid_from.is.null,valid_from.lte.${validDate}`)
          .or(`valid_to.is.null,valid_to.gte.${validDate}`);
      }

      const { data: plantData, error: plantError } = await plantQuery;
      if (plantError) throw plantError;
      if (plantData && plantData.length > 0) {
        return plantData;
      }

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

    let query = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    if (plantId) {
      query = query.eq('plant_id', plantId);
    } else if (plantId === null && !usePlantFallback) {
      query = query.is('plant_id', null);
    }
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }
    if (currency) {
      query = query.eq('currency', currency);
    }
    if (validDate) {
      query = query
        .or(`valid_from.is.null,valid_from.lte.${validDate}`)
        .or(`valid_to.is.null,valid_to.gte.${validDate}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

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

  async getFgFinancial(userId, materialCode, plantId = null, currency = 'USD') {
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
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  },

  async getFgFinancials(userId, options = {}) {
    const {
      plantId,
      materialCode,
      currency,
      limit = 100,
      offset = 0,
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
  },
};

