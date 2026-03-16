import { supabase } from './core.js';

export const goodsReceiptsService = {
  async batchInsert(userId, receipts, options = {}) {
    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0 };
    }

    let uploadFileId = null;
    let batchId = null;

    if (typeof options === 'string') {
      uploadFileId = options;
    } else if (typeof options === 'object') {
      uploadFileId = options.uploadFileId || null;
      batchId = options.batchId || null;
    }

    const payload = receipts.map((receipt) => ({
      user_id: userId,
      upload_file_id: uploadFileId,
      supplier_id: receipt.supplier_id,
      material_id: receipt.material_id,
      po_number: receipt.po_number || null,
      receipt_number: receipt.receipt_number || null,
      planned_delivery_date: receipt.planned_delivery_date || null,
      actual_delivery_date: receipt.actual_delivery_date,
      receipt_date: receipt.receipt_date || new Date().toISOString().split('T')[0],
      received_qty: receipt.received_qty,
      rejected_qty: receipt.rejected_qty || 0,
      batch_id: receipt.batch_id || batchId,
    }));

    const { data, error } = await supabase
      .from('goods_receipts')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  async batchInsertReceipts(userId, receipts, options = {}) {
    const { chunkSize = 500, onProgress = null } = options;

    if (!receipts || receipts.length === 0) {
      return { success: true, count: 0, data: [] };
    }

    console.log(`[batchInsertReceipts] Starting insert for ${receipts.length} receipts`);

    const payload = receipts.map((receipt) => ({
      user_id: userId,
      upload_file_id: receipt.upload_file_id || null,
      supplier_id: receipt.supplier_id,
      material_id: receipt.material_id,
      po_number: receipt.po_number || null,
      receipt_number: receipt.receipt_number || null,
      planned_delivery_date: receipt.planned_delivery_date || null,
      actual_delivery_date: receipt.actual_delivery_date,
      receipt_date: receipt.receipt_date || new Date().toISOString().split('T')[0],
      received_qty: receipt.received_qty,
      rejected_qty: receipt.rejected_qty || 0,
      batch_id: receipt.batch_id || null,
    }));

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

      if (onProgress) {
        onProgress(insertedCount, receipts.length);
      }
    }

    console.log(`[batchInsertReceipts] Inserted ${insertedCount} receipts`);

    return { success: true, count: insertedCount, data: allInsertedData };
  },

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

  async delete(receiptId) {
    const { error } = await supabase
      .from('goods_receipts')
      .delete()
      .eq('id', receiptId);

    if (error) throw error;
    return { success: true };
  },

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
      totalReceived: data.reduce((sum, receipt) => sum + parseFloat(receipt.received_qty || 0), 0),
      totalRejected: data.reduce((sum, receipt) => sum + parseFloat(receipt.rejected_qty || 0), 0),
      onTimeCount: data.filter((receipt) => receipt.is_on_time === true).length,
      avgDefectRate: 0,
      onTimeRate: 0,
    };

    if (stats.totalReceived > 0) {
      stats.avgDefectRate = (stats.totalRejected / stats.totalReceived * 100).toFixed(2);
    }

    if (stats.totalReceipts > 0) {
      stats.onTimeRate = (stats.onTimeCount / stats.totalReceipts * 100).toFixed(2);
    }

    return stats;
  },
};

export const priceHistoryService = {
  async batchInsert(userId, prices, options = {}) {
    if (!prices || prices.length === 0) {
      return { success: true, count: 0 };
    }

    let uploadFileId = null;
    let batchId = null;

    if (typeof options === 'string') {
      uploadFileId = options;
    } else if (typeof options === 'object') {
      uploadFileId = options.uploadFileId || null;
      batchId = options.batchId || null;
    }

    const payload = prices.map((price) => ({
      user_id: userId,
      upload_file_id: uploadFileId,
      supplier_id: price.supplier_id,
      material_id: price.material_id,
      order_date: price.order_date,
      unit_price: price.unit_price,
      currency: price.currency || 'USD',
      quantity: price.quantity || 0,
      is_contract_price: price.is_contract_price || false,
      batch_id: price.batch_id || batchId,
    }));

    const { data, error } = await supabase
      .from('price_history')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

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

  async delete(priceId) {
    const { error } = await supabase
      .from('price_history')
      .delete()
      .eq('id', priceId);

    if (error) throw error;
    return { success: true };
  },

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
  },
};

