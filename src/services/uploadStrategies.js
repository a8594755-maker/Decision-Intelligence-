/**
 * Upload Strategies - Strategy pattern implementation
 * Each uploadType has a corresponding ingest strategy
 * 
 * Supports chunk ingest and idempotency
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
 * Generate idempotency key for a sheet ingest
 * @param {object} params
 * @returns {string} Stable idempotency key
 */
export function getIdempotencyKey({ batchId, sheetName, uploadType }) {
  return `${batchId}::${sheetName}::${uploadType}`;
}

/**
 * Goods Receipt Strategy
 * Prioritize RPC, fallback to legacy N+1 on failure
 * Supports chunk ingest and idempotency
 */
class GoodsReceiptStrategy {
  async ingest({ userId, rows, batchId, uploadFileId, _fileName, _sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[GoodsReceiptStrategy] Starting for ${rows.length} rows`);

    // ===== Try RPC first (Transaction + Bulk Upsert) =====
    try {
      console.log('[GoodsReceiptStrategy] Attempting RPC path...');
      
      setSaveProgress({
        stage: 'rpc',
        current: 0,
        total: rows.length,
        message: 'Writing via high-performance RPC...'
      });

      const result = await ingestGoodsReceiptsRpc({
        batchId,
        uploadFileId,
        rows
      });

      console.log('[GoodsReceiptStrategy] ✓ RPC Success:', result);

      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

      addNotification(
        `✓ Transactional write completed (${result.inserted_count} rows, created ${result.suppliers_created} suppliers)`,
        'success'
      );

      return { savedCount: result.inserted_count };

    } catch (rpcError) {
      // ===== RPC failed: determine error type and handle =====
      
      if (rpcError instanceof BatchSizeError) {
        console.warn('[GoodsReceiptStrategy] Batch too large for RPC, switching to legacy path:', rpcError.message);
        addNotification(
          `⚠️ Batch exceeds RPC limit (${MAX_ROWS_PER_BATCH.toLocaleString()} rows), switched to compatible mode`,
          'warning'
        );
      } else if (rpcError instanceof RpcError) {
        console.warn('[RPC_FALLBACK] RPC failed, using legacy path:', {
          code: rpcError.code,
          message: rpcError.message
        });

        addNotification(
          `⚠️ High-performance mode failed, switched to compatible mode (reason: ${rpcError.code})`,
          'warning'
        );
      } else {
        console.warn('[RPC_FALLBACK] Unexpected error, using legacy path:', rpcError);
        addNotification('⚠️ Switched to compatible mode (high-performance mode temporarily unavailable)', 'warning');
      }
    }

    // ===== Fallback: Legacy N+1 logic =====
    console.log('[GoodsReceiptStrategy] Using legacy path (fallback)...');

    const normalizeSupplierName = (name) => {
      return name.toLowerCase().trim().replace(/\s+/g, ' ');
    };

    // Step 1: Collect unique suppliers and materials
    setSaveProgress({
      stage: 'collecting',
      current: 0,
      total: rows.length,
      message: 'Analyzing data...'
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

    // Step 2: Batch Upsert Suppliers
    setSaveProgress({
      stage: 'suppliers',
      current: 0,
      total: uniqueSuppliers.size,
      message: `Processing ${uniqueSuppliers.size} suppliers...`
    });

    const supplierIdMap = await suppliersService.batchUpsertSuppliers(
      userId,
      Array.from(uniqueSuppliers.values()),
      { chunkSize: 200 }
    );

    // Step 3: Batch Upsert Materials
    setSaveProgress({
      stage: 'materials',
      current: 0,
      total: uniqueMaterials.size,
      message: `Processing ${uniqueMaterials.size} materials...`
    });

    const materialIdMap = await materialsService.batchUpsertMaterials(
      userId,
      Array.from(uniqueMaterials.values()),
      { chunkSize: 200 }
    );

    // Step 4: Assemble Goods Receipts Payload
    setSaveProgress({
      stage: 'receipts',
      current: 0,
      total: rows.length,
      message: `Preparing ${rows.length} goods receipt records...`
    });

    const receipts = rows.map(row => {
      const supplierKey = row.supplier_code || normalizeSupplierName(row.supplier_name);
      const supplierId = supplierIdMap.get(supplierKey);
      const materialId = materialIdMap.get(row.material_code);

      if (!supplierId) {
        throw new Error(`Cannot find supplier ID: ${row.supplier_name} (key: ${supplierKey})`);
      }

      if (!materialId) {
        throw new Error(`Cannot find material ID: ${row.material_code}`);
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

    // Step 5: Batch write Goods Receipts
    const result = await goodsReceiptsService.batchInsertReceipts(userId, receipts, {
      chunkSize: 500,
      onProgress: (current, total) => {
        setSaveProgress({
          stage: 'receipts',
          current,
          total,
          message: `Writing goods receipts (${current}/${total})...`
        });
      }
    });

    console.log(`[GoodsReceiptStrategy] Done! Wrote ${result.count} records`);

    setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

    return { savedCount: result.count };
  }
}

/**
 * Price History Strategy
 * Prioritize RPC, fallback to legacy N+1 on failure
 * Supports chunk ingest and idempotency
 */
class PriceHistoryStrategy {
  async ingest({ userId, rows, batchId, uploadFileId, _fileName, _sheetName, addNotification, setSaveProgress, options = {} }) {
    console.log(`[PriceHistoryStrategy] Starting for ${rows.length} rows`);

    // ===== Try RPC first =====
    try {
      console.log('[PriceHistoryStrategy] Attempting RPC path...');
      
      setSaveProgress({
        stage: 'rpc',
        current: 0,
        total: rows.length,
        message: 'Writing via high-performance RPC...'
      });

      const result = await ingestPriceHistoryRpc({
        batchId,
        uploadFileId,
        rows
      });

      console.log('[PriceHistoryStrategy] ✓ RPC Success:', result);

      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

      addNotification(
        `✓ Transactional write completed (${result.inserted_count} rows, created ${result.suppliers_created} suppliers)`,
        'success'
      );

      return { savedCount: result.inserted_count };

    } catch (rpcError) {
      if (rpcError instanceof BatchSizeError) {
        console.warn('[PriceHistoryStrategy] Batch too large for RPC, switching to legacy path:', rpcError.message);
        addNotification(
          `⚠️ Batch exceeds RPC limit (${MAX_ROWS_PER_BATCH.toLocaleString()} rows), switched to compatible mode`,
          'warning'
        );
      } else if (rpcError instanceof RpcError) {
        console.warn('[RPC_FALLBACK] RPC failed, using legacy path:', {
          code: rpcError.code,
          message: rpcError.message
        });

        addNotification(
          `⚠️ High-performance mode failed, switched to compatible mode (reason: ${rpcError.code})`,
          'warning'
        );
      } else {
        console.warn('[RPC_FALLBACK] Unexpected error, using legacy path:', rpcError);
        addNotification('⚠️ Switched to compatible mode (high-performance mode temporarily unavailable)', 'warning');
      }
    }

    // ===== Fallback: Legacy N+1 logic =====
    console.log('[PriceHistoryStrategy] Using legacy path (fallback)...');

    const normalizeSupplierName = (name) => {
      return name.toLowerCase().trim().replace(/\s+/g, ' ');
    };

    setSaveProgress({
      stage: 'collecting',
      current: 0,
      total: rows.length,
      message: 'Analyzing data...'
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
      message: `Processing ${uniqueSuppliers.size} suppliers...`
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
      message: `Processing ${uniqueMaterials.size} materials...`
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
      message: `Preparing ${rows.length} price records...`
    });

    const prices = rows.map(row => {
      const supplierKey = row.supplier_code || normalizeSupplierName(row.supplier_name);
      const supplierId = supplierIdMap.get(supplierKey);
      const materialId = materialIdMap.get(row.material_code);

      if (!supplierId) {
        throw new Error(`Cannot find supplier ID: ${row.supplier_name}`);
      }

      if (!materialId) {
        throw new Error(`Cannot find material ID: ${row.material_code}`);
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

    console.log(`[PriceHistoryStrategy] Done! Wrote ${prices.length} records`);

    setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
    
    return { savedCount: prices.length };
  }
}

/**
 * Supplier Master Strategy
 * Directly uses suppliersService.insertSuppliers, ensures batch_id is written
 * Supports chunk ingest and idempotency
 */
/**
 * Normalize supplier status to valid values
 * @param {string|null|undefined} status - Original status value
 * @returns {string} 'active' or 'inactive'
 */
const normalizeSupplierStatus = (status) => {
  if (!status || typeof status !== 'string') {
    return 'active';
  }
  
  const normalized = status.toLowerCase().trim();
  
  // Allowed values: active, inactive
  if (normalized === 'active' || normalized === 'inactive') {
    return normalized;
  }
  
  // Common variants → active
  if (normalized === 'enabled' || normalized === 'enable' || normalized === 'yes' || normalized === '1') {
    return 'active';
  }
  
  // Common variants → inactive
  if (normalized === 'disabled' || normalized === 'disable' || normalized === 'no' || normalized === '0' || normalized === 'suspended') {
    return 'inactive';
  }
  
  // Other unknown values → default active
  console.warn(`[normalizeSupplierStatus] Unknown status value "${status}", defaulting to 'active'`);
  return 'active';
};

class SupplierMasterStrategy {
  async ingest({ userId, rows, batchId, _fileName, _sheetName, _addNotification, _setSaveProgress, options = {} }) {
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

    const result = await suppliersService.insertSuppliers(userId, suppliers);
    
    console.log(`[SupplierMasterStrategy] Suppliers saved: ${result.inserted} inserted, ${result.updated} updated`);
    
    return { savedCount: result.count };
  }
}

/**
 * BOM Edge Strategy
 * Supports chunk ingest and idempotency
 */
class BomEdgeStrategy {
  async ingest({ userId, rows, batchId, _fileName, _sheetName, _addNotification, _setSaveProgress, options = {} }) {
    console.log(`[BomEdgeStrategy] Starting for ${rows.length} rows`);

    const bomEdges = rows.map(row => ({
      user_id: userId,  // ✅ Fix: add user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ Fix: add batch_id (UUID, nullable)
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

    // ✅ Fix: pass batchId (uuid string), not { batchId } (object)
    const result = await bomEdgesService.batchInsert(userId, bomEdges, batchId);
    
    console.log(`[BomEdgeStrategy] BOM edges saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * Demand FG Strategy
 * Supports chunk ingest and idempotency
 */
class DemandFgStrategy {
  async ingest({ userId, rows, batchId, _fileName, _sheetName, _addNotification, _setSaveProgress, options = {} }) {
    console.log(`[DemandFgStrategy] Starting for ${rows.length} rows`);

    const demands = rows.map(row => ({
      user_id: userId,  // ✅ Fix: add user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ Fix: add batch_id (UUID, nullable)
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

    // ✅ Fix: pass batchId (uuid string), not { batchId } (object)
    const result = await demandFgService.batchInsert(userId, demands, batchId);
    
    console.log(`[DemandFgStrategy] Demand FG saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * PO Open Lines Strategy
 * Supports chunk ingest and idempotency
 */
class PoOpenLinesStrategy {
  async ingest({ userId, rows, batchId, _fileName, _sheetName, _addNotification, _setSaveProgress, options = {} }) {
    console.log(`[PoOpenLinesStrategy] Starting for ${rows.length} rows`);

    const poLines = rows.map(row => ({
      user_id: userId,  // ✅ Fix: add user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ Fix: add batch_id (UUID, nullable)
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

    // ✅ Fix: pass batchId (uuid string), not { batchId } (object)
    const result = await poOpenLinesService.batchInsert(userId, poLines, batchId);
    
    console.log(`[PoOpenLinesStrategy] PO Open Lines saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * Inventory Snapshots Strategy
 * Supports chunk ingest and idempotency
 */
class InventorySnapshotsStrategy {
  async ingest({ userId, rows, batchId, _fileName, _sheetName, _addNotification, setSaveProgress, _options = {} }) {
    console.log(`[InventorySnapshotsStrategy] Starting for ${rows.length} rows`);

    // Update progress
    setSaveProgress({
      stage: 'inventory_snapshots',
      current: 0,
      total: rows.length,
      message: `Preparing ${rows.length} inventory snapshots...`
    });

    const snapshots = rows.map(row => ({
      user_id: userId,  // ✅ Fix: add user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ Fix: add batch_id (UUID, nullable)
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

    // ✅ Fix: pass batchId (uuid string), not { batchId } (object)
    const result = await inventorySnapshotsService.batchInsert(userId, snapshots, batchId);
    
    console.log(`[InventorySnapshotsStrategy] Inventory Snapshots saved: ${result.count} records`);
    
    // Clear progress
    setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
    
    return { savedCount: result.count };
  }
}

/**
 * FG Financials Strategy
 * Supports chunk ingest and idempotency
 */
class FgFinancialsStrategy {
  async ingest({ userId, rows, batchId, _fileName, _sheetName, _addNotification, _setSaveProgress, options = {} }) {
    console.log(`[FgFinancialsStrategy] Starting for ${rows.length} rows`);

    const financials = rows.map(row => ({
      user_id: userId,  // ✅ Fix: add user_id (UUID, NOT NULL)
      batch_id: batchId || null,  // ✅ Fix: add batch_id (UUID, nullable)
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

    // ✅ Fix: pass batchId (uuid string), not { batchId } (object)
    const result = await fgFinancialsService.batchInsert(userId, financials, batchId);
    
    console.log(`[FgFinancialsStrategy] FG Financials saved: ${result.count} records`);
    
    return { savedCount: result.count };
  }
}

/**
 * Operational Cost Strategy
 * Directly uses batchUpsertOperationalCosts for batch upsert
 * Auto-calculates derived fields (direct_labor_cost, indirect_labor_cost, total_labor_cost, cost_per_unit)
 * Supports chunk ingest and idempotency (onConflict: user_id, cost_date)
 */
class OperationalCostStrategy {
  async ingest({ userId, rows, batchId, uploadFileId, _fileName, _sheetName, _addNotification, setSaveProgress, _options = {} }) {
    console.log(`[OperationalCostStrategy] Starting for ${rows.length} rows`);

    setSaveProgress({
      stage: 'writing',
      current: 0,
      total: rows.length,
      message: `Writing ${rows.length} operational cost records...`
    });

    try {
      const result = await batchUpsertOperationalCosts(userId, rows, batchId, uploadFileId);

      console.log(`[OperationalCostStrategy] Done! Wrote ${result.count} records`);

      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });

      return { savedCount: result.count };
    } catch (error) {
      console.error('[OperationalCostStrategy] Error:', error);
      setSaveProgress({ stage: '', current: 0, total: 0, message: '' });
      throw error;
    }
  }
}

// Strategy mapping table
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
 * Get upload strategy
 * @param {string} uploadType - Upload type
 * @returns {Object} Strategy instance with ingest method
 */
export function getUploadStrategy(uploadType) {
  const strategy = strategies[uploadType];
  
  if (!strategy) {
    throw new Error(`Unsupported upload type: ${uploadType}`);
  }
  
  return strategy;
}
