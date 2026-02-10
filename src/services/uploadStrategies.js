/**
 * Upload Strategies - 策略模式實作
 * 每個 uploadType 都有對應的 ingest 策略
 * 
 * 支援 chunk ingest 和 idempotency
 */

import {
  suppliersService,
  materialsService,
  goodsReceiptsService,
  priceHistoryService,
  bomEdgesService,
  demandFgService,
  poOpenLinesService,
  inventorySnapshotsService,
  fgFinancialsService
} from './supabaseClient';
import {
  ingestGoodsReceiptsRpc,
  ingestPriceHistoryRpc,
  RpcError,
  BatchSizeError,
  MAX_ROWS_PER_BATCH
} from './ingestRpcService';
import { batchUpsertOperationalCosts } from './costAnalysisService';

/**
 * Generate a UUID v4 using crypto API or fallback
 * @returns {string} UUID string
 */
function generateUUID() {
  // 优先使用 crypto.randomUUID() 如果可用
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback: 手动生成
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, function(c) {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Chunk an array into smaller arrays of specified size
 * @param {Array} array - The array to chunk
 * @param {number} chunkSize - Size of each chunk
 * @returns {Array<Array>} Array of chunked arrays
 */
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Generate idempotency key for a sheet ingest
 * @param {object} params
 * @returns {string} Stable idempotency key
 */
export function getIdempotencyKey({ batchId, sheetName, uploadType }) {
  return `${batchId}::${sheetName}::${uploadType}`;
}

/**
 * Goods Receipt Strategy
 * 優先使用 RPC，失敗則 fallback 到 N+1 舊版
 * 支援 chunk ingest 和 idempotency
 */
class GoodsReceiptStrategy {
  async ingest({ userId, rows, batchId, uploadFileId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[GoodsReceiptStrategy] Starting for ${rows.length} rows`);

    // ===== 優先嘗試 RPC（Transaction + Bulk Upsert） =====
    try {
      console.log('[GoodsReceiptStrategy] Attempting RPC path...');
      
      setSaveProgress({
        stage: 'rpc',
        current: 0,
        total: rows.length,
        message: '使用高效能 RPC 寫入...'
      });

      const result = await ingestGoodsReceiptsRpc({
        batchId,
        uploadFileId,
        rows
      });

      console.log('[GoodsReceiptStrategy] ✓ RPC Success:', result);

      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

      addNotification(
        `✓ 使用交易性寫入完成（${result.inserted_count} 筆，建立 ${result.suppliers_created} 個供應商）`,
        'success'
      );

      return { savedCount: result.inserted_count };

    } catch (rpcError) {
      // ===== RPC 失敗：判斷錯誤類型並處理 =====
      
      if (rpcError instanceof BatchSizeError) {
        console.warn('[GoodsReceiptStrategy] Batch too large, auto-chunking:', rpcError.message);
        
        // 自動分批處理 - 每個 chunk 使用唯一的 batch_id 避免 idempotency 刪除問題
        const chunks = chunkArray(rows, MAX_ROWS_PER_BATCH);
        let totalInserted = 0;
        let totalSuppliersCreated = 0;
        
        setSaveProgress({
          stage: 'chunking',
          current: 0,
          total: chunks.length,
          message: `自動分批處理中 (${chunks.length} 批次)...`
        });

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // 為每個 chunk 生成唯一的 UUID 作為 batch_id
          const chunkBatchId = generateUUID();
          
          try {
            setSaveProgress({
              stage: 'chunking',
              current: i + 1,
              total: chunks.length,
              message: `處理第 ${i + 1}/${chunks.length} 批次 (${chunk.length} 筆)...`
            });

            const result = await ingestGoodsReceiptsRpc({
              batchId: chunkBatchId,
              uploadFileId,
              rows: chunk
            });

            totalInserted += result.inserted_count;
            totalSuppliersCreated += result.suppliers_created || 0;
            
            console.log(`[GoodsReceiptStrategy] Chunk ${i + 1}/${chunks.length} completed`);
            
          } catch (chunkError) {
            console.error(`[GoodsReceiptStrategy] Chunk ${i + 1} failed:`, chunkError);
            
            // 清理進度並拋出錯誤
            setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
            throw new Error(
              `批次處理失敗：第 ${i + 1}/${chunks.length} 批次無法處理。\n` +
              `錯誤詳情：${chunkError.message}\n\n` +
              `已成功處理 ${i} 個批次，共 ${totalInserted} 筆記錄。` +
              `建議：請檢查失敗批次的資料品質或聯繫系統管理員。`
            );
          }
        }

        // 所有批次成功完成
        setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
        
        addNotification(
          `✓ 自動分批完成（共 ${totalInserted} 筆，分 ${chunks.length} 批次處理，建立 ${totalSuppliersCreated} 個供應商）`,
          'success'
        );

        return { savedCount: totalInserted };
      }

      if (rpcError instanceof RpcError) {
        console.warn('[RPC_FALLBACK] RPC failed, using legacy path:', {
          code: rpcError.code,
          message: rpcError.message
        });

        addNotification(
          `⚠️ 高效能模式失敗，已切換到相容模式（原因：${rpcError.code}）`,
          'warning'
        );
      } else {
        console.warn('[RPC_FALLBACK] Unexpected error, using legacy path:', rpcError);
        addNotification('⚠️ 已切換到相容模式（高效能模式暫時無法使用）', 'warning');
      }
    }

    // ===== Fallback: 舊版 N+1 邏輯 =====
    console.log('[GoodsReceiptStrategy] Using legacy path (fallback)...');

    const normalizeSupplierName = (name) => {
      return name.toLowerCase().trim().replace(/\s+/g, ' ');
    };

    // Step 1: 收集唯一的 suppliers 和 materials
    setSaveProgress({
      stage: 'collecting',
      current: 0,
      total: rows.length,
      message: '正在分析資料...'
    });

    const uniqueSuppliers = new Map();
    const uniqueMaterials = new Map();

    rows.forEach(row => {
      const supplierKey = row.supplier_code || normalizeSupplierName(row.supplier_name);
      if (!uniqueSuppliers.has(supplierKey)) {
        uniqueSuppliers.set(supplierKey, {
          supplier_name: row.supplier_name,
          supplier_code: row.supplier_code || null,
          batch_id: batchId
        });
      }

      if (!uniqueMaterials.has(row.material_code)) {
        uniqueMaterials.set(row.material_code, {
          material_code: row.material_code,
          material_name: row.material_name || row.material_code,
          category: row.category || null,
          uom: row.uom || 'pcs',
          batch_id: batchId
        });
      }
    });

    console.log(`[GoodsReceiptStrategy] Found ${uniqueSuppliers.size} unique suppliers, ${uniqueMaterials.size} unique materials`);

    // Step 2: 批次 Upsert Suppliers
    setSaveProgress({
      stage: 'suppliers',
      current: 0,
      total: uniqueSuppliers.size,
      message: `正在處理 ${uniqueSuppliers.size} 個供應商...`
    });

    const supplierIdMap = await suppliersService.batchUpsertSuppliers(
      userId,
      Array.from(uniqueSuppliers.values()),
      { chunkSize: 200 }
    );

    // Step 3: 批次 Upsert Materials
    setSaveProgress({
      stage: 'materials',
      current: 0,
      total: uniqueMaterials.size,
      message: `正在處理 ${uniqueMaterials.size} 個物料...`
    });

    const materialIdMap = await materialsService.batchUpsertMaterials(
      userId,
      Array.from(uniqueMaterials.values()),
      { chunkSize: 200 }
    );

    // Step 4: 組裝 Goods Receipts Payload
    setSaveProgress({
      stage: 'receipts',
      current: 0,
      total: rows.length,
      message: `正在準備 ${rows.length} 筆收貨記錄...`
    });

    const receipts = rows.map(row => {
      const supplierKey = row.supplier_code || normalizeSupplierName(row.supplier_name);
      const supplierId = supplierIdMap.get(supplierKey);
      const materialId = materialIdMap.get(row.material_code);

      if (!supplierId) {
        throw new Error(`無法找到供應商 ID: ${row.supplier_name} (key: ${supplierKey})`);
      }

      if (!materialId) {
        throw new Error(`無法找到物料 ID: ${row.material_code}`);
      }

      return {
        user_id: userId,
        supplier_id: supplierId,
        material_id: materialId,
        po_number: row.po_number || null,
        receipt_number: row.receipt_number || null,
        planned_delivery_date: row.planned_delivery_date || null,
        actual_delivery_date: row.actual_delivery_date,
        receipt_date: row.receipt_date || row.actual_delivery_date,
        received_qty: row.received_qty,
        rejected_qty: row.rejected_qty || 0,
        upload_file_id: uploadFileId,
        batch_id: batchId,
        ingest_key: options.idempotencyKey || null
      };
    });

    // Step 5: 批次寫入 Goods Receipts
    const result = await goodsReceiptsService.batchInsertReceipts(userId, receipts, {
      chunkSize: 500,
      onProgress: (current, total) => {
        setSaveProgress({
          stage: 'receipts',
          current,
          total,
          message: `正在寫入收貨記錄 (${current}/${total})...`
        });
      }
    });

    console.log(`[GoodsReceiptStrategy] 完成！共寫入 ${result.count} 筆記錄`);

    setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

    return { savedCount: result.count };
  }
}

/**
 * Price History Strategy
 * 優先使用 RPC，失敗則 fallback 到 N+1 舊版
 * 支援 chunk ingest 和 idempotency
 */
class PriceHistoryStrategy {
  async ingest({ userId, rows, batchId, uploadFileId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[PriceHistoryStrategy] Starting for ${rows.length} rows`);

    // ===== 優先嘗試 RPC =====
    try {
      console.log('[PriceHistoryStrategy] Attempting RPC path...');
      
      setSaveProgress({
        stage: 'rpc',
        current: 0,
        total: rows.length,
        message: '使用高效能 RPC 寫入...'
      });

      const result = await ingestPriceHistoryRpc({
        batchId,
        uploadFileId,
        rows
      });

      console.log('[PriceHistoryStrategy] ✓ RPC Success:', result);

      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

      addNotification(
        `✓ 使用交易性寫入完成（${result.inserted_count} 筆，建立 ${result.suppliers_created} 個供應商）`,
        'success'
      );

      return { savedCount: result.inserted_count };

    } catch (rpcError) {
      if (rpcError instanceof BatchSizeError) {
        console.warn('[PriceHistoryStrategy] Batch too large, auto-chunking:', rpcError.message);
        
        // 自動分批處理 - 每個 chunk 使用唯一的 batch_id 避免 idempotency 刪除問題
        const chunks = chunkArray(rows, MAX_ROWS_PER_BATCH);
        let totalInserted = 0;
        let totalSuppliersCreated = 0;
        
        setSaveProgress({
          stage: 'chunking',
          current: 0,
          total: chunks.length,
          message: `自動分批處理中 (${chunks.length} 批次)...`
        });

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // 為每個 chunk 生成唯一的 UUID 作為 batch_id
          const chunkBatchId = generateUUID();
          
          try {
            setSaveProgress({
              stage: 'chunking',
              current: i + 1,
              total: chunks.length,
              message: `處理第 ${i + 1}/${chunks.length} 批次 (${chunk.length} 筆)...`
            });

            const result = await ingestPriceHistoryRpc({
              batchId: chunkBatchId,
              uploadFileId,
              rows: chunk
            });

            totalInserted += result.inserted_count;
            totalSuppliersCreated += result.suppliers_created || 0;
            
            console.log(`[PriceHistoryStrategy] Chunk ${i + 1}/${chunks.length} completed`);
            
          } catch (chunkError) {
            console.error(`[PriceHistoryStrategy] Chunk ${i + 1} failed:`, chunkError);
            
            // 清理進度並拋出錯誤
            setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
            throw new Error(
              `批次處理失敗：第 ${i + 1}/${chunks.length} 批次無法處理。\n` +
              `錯誤詳情：${chunkError.message}\n\n` +
              `已成功處理 ${i} 個批次，共 ${totalInserted} 筆記錄。` +
              `建議：請檢查失敗批次的資料品質或聯繫系統管理員。`
            );
          }
        }

        // 所有批次成功完成
        setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
        
        addNotification(
          `✓ 自動分批完成（共 ${totalInserted} 筆，分 ${chunks.length} 批次處理，建立 ${totalSuppliersCreated} 個供應商）`,
          'success'
        );

        return { savedCount: totalInserted };
      }

      if (rpcError instanceof RpcError) {
        console.warn('[RPC_FALLBACK] RPC failed, using legacy path:', {
          code: rpcError.code,
          message: rpcError.message
        });

        addNotification(
          `⚠️ 高效能模式失敗，已切換到相容模式（原因：${rpcError.code}）`,
          'warning'
        );
      } else {
        console.warn('[RPC_FALLBACK] Unexpected error, using legacy path:', rpcError);
        addNotification('⚠️ 已切換到相容模式（高效能模式暫時無法使用）', 'warning');
      }
    }

    // ===== Fallback: 舊版 N+1 邏輯 =====
    console.log('[PriceHistoryStrategy] Using legacy path (fallback)...');

    const normalizeSupplierName = (name) => {
      return name.toLowerCase().trim().replace(/\s+/g, ' ');
    };

    setSaveProgress({
      stage: 'collecting',
      current: 0,
      total: rows.length,
      message: '正在分析資料...'
    });

    const uniqueSuppliers = new Map();
    const uniqueMaterials = new Map();

    rows.forEach(row => {
      const supplierKey = row.supplier_code || normalizeSupplierName(row.supplier_name);
      if (!uniqueSuppliers.has(supplierKey)) {
        uniqueSuppliers.set(supplierKey, {
          supplier_name: row.supplier_name,
          supplier_code: row.supplier_code || null,
          batch_id: batchId
        });
      }

      if (!uniqueMaterials.has(row.material_code)) {
        uniqueMaterials.set(row.material_code, {
          material_code: row.material_code,
          material_name: row.material_name || row.material_code,
          batch_id: batchId
        });
      }
    });

    console.log(`[PriceHistoryStrategy] Found ${uniqueSuppliers.size} unique suppliers, ${uniqueMaterials.size} unique materials`);

    setSaveProgress({
      stage: 'suppliers',
      current: 0,
      total: uniqueSuppliers.size,
      message: `正在處理 ${uniqueSuppliers.size} 個供應商...`
    });

    const supplierIdMap = await suppliersService.batchUpsertSuppliers(
      userId,
      Array.from(uniqueSuppliers.values()),
      { chunkSize: 200 }
    );

    setSaveProgress({
      stage: 'materials',
      current: 0,
      total: uniqueMaterials.size,
      message: `正在處理 ${uniqueMaterials.size} 個物料...`
    });

    const materialIdMap = await materialsService.batchUpsertMaterials(
      userId,
      Array.from(uniqueMaterials.values()),
      { chunkSize: 200 }
    );

    setSaveProgress({
      stage: 'receipts',
      current: 0,
      total: rows.length,
      message: `正在準備 ${rows.length} 筆價格記錄...`
    });

    const prices = rows.map(row => {
      const supplierKey = row.supplier_code || normalizeSupplierName(row.supplier_name);
      const supplierId = supplierIdMap.get(supplierKey);
      const materialId = materialIdMap.get(row.material_code);

      if (!supplierId) {
        throw new Error(`無法找到供應商 ID: ${row.supplier_name}`);
      }

      if (!materialId) {
        throw new Error(`無法找到物料 ID: ${row.material_code}`);
      }

      return {
        user_id: userId,
        supplier_id: supplierId,
        material_id: materialId,
        order_date: row.order_date,
        unit_price: row.unit_price,
        currency: row.currency || 'USD',
        quantity: row.quantity || 0,
        is_contract_price: row.is_contract_price || false,
        upload_file_id: uploadFileId,
        batch_id: batchId,
        ingest_key: options.idempotencyKey || null
      };
    });

    await priceHistoryService.batchInsert(userId, prices, { uploadFileId, batchId });

    console.log(`[PriceHistoryStrategy] 完成！共寫入 ${prices.length} 筆記錄`);

    setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
    
    return { savedCount: prices.length };
  }
}

/**
 * Supplier Master Strategy
 * 直接使用 suppliersService.insertSuppliers，確保 batch_id 寫入
 * 支援 chunk ingest 和 idempotency
 */
/**
 * 正規化 supplier status 為合法值
 * @param {string|null|undefined} status - 原始 status 值
 * @returns {string} 'active' 或 'inactive'
 */
const normalizeSupplierStatus = (status) => {
  if (!status || typeof status !== 'string') {
    return 'active';
  }
  
  const normalized = status.toLowerCase().trim();
  
  // 允許的值：active, inactive
  if (normalized === 'active' || normalized === 'inactive') {
    return normalized;
  }
  
  // 常見變體 → active
  if (normalized === 'enabled' || normalized === 'enable' || normalized === 'yes' || normalized === '1') {
    return 'active';
  }
  
  // 常見變體 → inactive
  if (normalized === 'disabled' || normalized === 'disable' || normalized === 'no' || normalized === '0' || normalized === 'suspended') {
    return 'inactive';
  }
  
  // 其他未知值 → 預設 active
  console.warn(`[normalizeSupplierStatus] Unknown status value "${status}", defaulting to 'active'`);
  return 'active';
};

class SupplierMasterStrategy {
  async ingest({ userId, rows, batchId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[SupplierMasterStrategy] Starting for ${rows.length} rows`);

    const suppliers = rows.map(row => ({
      user_id: userId,
      supplier_name: row.supplier_name,
      supplier_code: row.supplier_code || null,
      contact_info: {
        contact_person: row.contact_person || null,
        phone: row.phone || null,
        email: row.email || null,
        address: row.address || null,
        product_category: row.product_category || null,
        payment_terms: row.payment_terms || null,
        delivery_time: row.delivery_time || null
      },
      status: normalizeSupplierStatus(row.status),
      batch_id: batchId,
      ingest_key: options.idempotencyKey || null
    }));

    const result = await suppliersService.insertSuppliers(suppliers);
    
    console.log(`[SupplierMasterStrategy] Suppliers saved: ${result.inserted} inserted, ${result.updated} updated`);
    
    return { savedCount: result.count };
  }
}

/**
 * BOM Edge Strategy
 * 支援 chunk ingest 和 idempotency
 */
class BomEdgeStrategy {
  async ingest({ userId, rows, batchId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[BomEdgeStrategy] Starting for ${rows.length} rows`);

    const bomEdges = rows.map(row => ({
      user_id: userId,  // ✅ 修復：加入 user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ 修復：加入 batch_id (UUID, nullable)
      parent_material: row.parent_material,
      child_material: row.child_material,
      qty_per: row.qty_per,
      uom: row.uom || 'pcs',
      plant_id: row.plant_id || null,
      bom_version: row.bom_version || null,
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
      scrap_rate: row.scrap_rate || null,
      yield_rate: row.yield_rate || null,
      alt_group: row.alt_group || null,
      priority: row.priority || null,
      mix_ratio: row.mix_ratio || null,
      ecn_number: row.ecn_number || null,
      ecn_effective_date: row.ecn_effective_date || null,
      routing_id: row.routing_id || null,
      notes: row.notes || null,
      ingest_key: options.idempotencyKey || null
    }));

    // ✅ 修正：傳入 batchId（uuid 字串），而不是 { batchId }（object）
    const result = await bomEdgesService.batchInsert(userId, bomEdges, batchId);
    
    console.log(`[BomEdgeStrategy] BOM edges saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * Demand FG Strategy
 * 支援 chunk ingest 和 idempotency
 */
class DemandFgStrategy {
  async ingest({ userId, rows, batchId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[DemandFgStrategy] Starting for ${rows.length} rows`);

    const demands = rows.map(row => ({
      user_id: userId,  // ✅ 修復：加入 user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ 修復：加入 batch_id (UUID, nullable)
      material_code: row.material_code,
      plant_id: row.plant_id,
      time_bucket: row.time_bucket,
      week_bucket: row.week_bucket || null,
      date: row.date || null,
      demand_qty: row.demand_qty,
      uom: row.uom || 'pcs',
      source_type: row.source_type || null,
      source_id: row.source_id || null,
      customer_id: row.customer_id || null,
      project_id: row.project_id || null,
      priority: row.priority || null,
      status: row.status || 'confirmed',
      notes: row.notes || null,
      ingest_key: options.idempotencyKey || null
    }));

    // ✅ 修正：傳入 batchId（uuid 字串），而不是 { batchId }（object）
    const result = await demandFgService.batchInsert(userId, demands, batchId);
    
    console.log(`[DemandFgStrategy] Demand FG saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * PO Open Lines Strategy
 * 支援 chunk ingest 和 idempotency
 */
class PoOpenLinesStrategy {
  async ingest({ userId, rows, batchId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[PoOpenLinesStrategy] Starting for ${rows.length} rows`);

    const poLines = rows.map(row => ({
      user_id: userId,  // ✅ 修復：加入 user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ 修復：加入 batch_id (UUID, nullable)
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
      ingest_key: options.idempotencyKey || null
    }));

    // ✅ 修正：傳入 batchId（uuid 字串），而不是 { batchId }（object）
    const result = await poOpenLinesService.batchInsert(userId, poLines, batchId);
    
    console.log(`[PoOpenLinesStrategy] PO Open Lines saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * Inventory Snapshots Strategy
 * 支援 chunk ingest 和 idempotency
 */
class InventorySnapshotsStrategy {
  async ingest({ userId, rows, batchId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[InventorySnapshotsStrategy] Starting for ${rows.length} rows`);

    // Update progress
    setSaveProgress({
      stage: 'inventory_snapshots',
      current: 0,
      total: rows.length,
      message: `Preparing ${rows.length} inventory snapshots...`
    });

    const snapshots = rows.map(row => ({
      user_id: userId,  // ✅ 修復：加入 user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ 修復：加入 batch_id (UUID, nullable)
      material_code: row.material_code,
      plant_id: row.plant_id,
      snapshot_date: row.snapshot_date,
      onhand_qty: row.onhand_qty,
      allocated_qty: row.allocated_qty !== null && row.allocated_qty !== undefined ? row.allocated_qty : 0,
      safety_stock: row.safety_stock !== null && row.safety_stock !== undefined ? row.safety_stock : 0,
      shortage_qty: row.shortage_qty !== null && row.shortage_qty !== undefined ? row.shortage_qty : 0,
      uom: row.uom || 'pcs',
      notes: row.notes || null
    }));

    // Update progress before insert
    setSaveProgress({
      stage: 'inventory_snapshots',
      current: rows.length,
      total: rows.length,
      message: 'Saving to database...'
    });

    // ✅ 修正：傳入 batchId（uuid 字串），而不是 { batchId }（object）
    const result = await inventorySnapshotsService.batchInsert(userId, snapshots, batchId);
    
    console.log(`[InventorySnapshotsStrategy] Inventory Snapshots saved: ${result.count} records`);
    
    // Clear progress
    setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
    
    return { savedCount: result.count };
  }
}

/**
 * FG Financials Strategy
 * 支援 chunk ingest 和 idempotency
 */
class FgFinancialsStrategy {
  async ingest({ userId, rows, batchId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[FgFinancialsStrategy] Starting for ${rows.length} rows`);

    const financials = rows.map(row => ({
      user_id: userId,  // ✅ 修復：加入 user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ 修復：加入 batch_id (UUID, nullable)
      material_code: row.material_code,
      unit_margin: row.unit_margin,
      plant_id: row.plant_id || null,
      unit_price: row.unit_price !== null && row.unit_price !== undefined ? row.unit_price : null,
      currency: row.currency || 'USD',
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
      notes: row.notes || null,
      ingest_key: options.idempotencyKey || null
    }));

    // ✅ 修正：傳入 batchId（uuid 字串），而不是 { batchId }（object）
    const result = await fgFinancialsService.batchInsert(userId, financials, batchId);
    
    console.log(`[FgFinancialsStrategy] FG Financials saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * Operational Cost Strategy
 * 直接使用 batchUpsertOperationalCosts 批次 upsert
 * 自動計算衍生欄位（direct_labor_cost, indirect_labor_cost, total_labor_cost, cost_per_unit）
 * 支援 chunk ingest 和 idempotency（onConflict: user_id, cost_date）
 */
class OperationalCostStrategy {
  async ingest({ userId, rows, batchId, uploadFileId, fileName, sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[OperationalCostStrategy] Starting for ${rows.length} rows`);

    setSaveProgress({
      stage: 'writing',
      current: 0,
      total: rows.length,
      message: `正在寫入 ${rows.length} 筆營運成本記錄...`
    });

    try {
      const result = await batchUpsertOperationalCosts(userId, rows, batchId, uploadFileId);

      console.log(`[OperationalCostStrategy] 完成！共寫入 ${result.count} 筆記錄`);

      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

      return { savedCount: result.count };
    } catch (error) {
      console.error('[OperationalCostStrategy] Error:', error);
      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
      throw error;
    }
  }
}

// 策略映射表
const strategies = {
  goods_receipt: new GoodsReceiptStrategy(),
  price_history: new PriceHistoryStrategy(),
  supplier_master: new SupplierMasterStrategy(),
  bom_edge: new BomEdgeStrategy(),
  demand_fg: new DemandFgStrategy(),
  po_open_lines: new PoOpenLinesStrategy(),
  inventory_snapshots: new InventorySnapshotsStrategy(),
  fg_financials: new FgFinancialsStrategy(),
  operational_costs: new OperationalCostStrategy()
};

/**
 * 獲取上傳策略
 * @param {string} uploadType - 上傳類型
 * @returns {Object} Strategy instance with ingest method
 */
export function getUploadStrategy(uploadType) {
  const strategy = strategies[uploadType];
  
  if (!strategy) {
    throw new Error(`Unsupported upload type: ${uploadType}`);
  }
  
  return strategy;
}
