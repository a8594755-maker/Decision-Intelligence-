/**
 * Upload Type Fingerprint Configuration
 * 定義每個 uploadType 的辨識規則（泛用、可擴充）
 * 
 * 擴充新類型時，只需在此新增一個 rule，無需修改分類邏輯
 */

export const UPLOAD_FINGERPRINTS = {
  bom_edge: {
    requiredHeaders: ['parent_material', 'qty_per'],
    requiredOneOf: [['component_material', 'child_material']],
    optionalHeaders: ['uom', 'plant_id', 'bom_version', 'scrap_rate', 'yield_rate'],
    negativeHeaders: ['supplier', 'price', 'demand', 'inventory', 'receipt'],
    strongFeatures: [
      ['parent_material', 'component_material'], // 同時存在兩個物料欄（強訊號）
      ['parent_material', 'child_material'], // 同時存在兩個物料欄（強訊號）
      'qty_per', // BOM 特有欄位
      'usage_qty' // BOM 特有欄位
    ],
    exclusiveFeatures: ['time_bucket', 'demand_qty', 'forecast_qty', 'supplier_name'], // 出現則不可能是 BOM
    fieldTypeHints: {
      qty_per: 'number',
      scrap_rate: 'number',
      yield_rate: 'number'
    },
    minConfidenceToAutoEnable: 0.75,
    description: 'BOM relationship (parent-child-quantity)'
  },

  demand_fg: {
    requiredHeaders: ['material_code', 'demand_qty'],
    requiredOneOf: [['time_bucket', 'date', 'week_bucket']],
    optionalHeaders: ['plant_id', 'uom', 'source_type', 'customer_id', 'forecast_qty'],
    negativeHeaders: ['supplier', 'price', 'parent', 'component', 'po_number', 'receipt'],
    strongFeatures: [
      'time_bucket', // Demand 強訊號（時間維度）
      'demand_qty',  // Demand 特有欄位
      'forecast_qty' // Demand 特有欄位
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'qty_per', 'usage_qty'], // 出現則不可能是 Demand
    fieldTypeHints: {
      demand_qty: 'number',
      time_bucket: 'string',
      date: 'date'
    },
    minConfidenceToAutoEnable: 0.75,
    description: 'Finished goods demand forecast'
  },

  po_open_lines: {
    requiredHeaders: ['po_number', 'material_code', 'plant_id', 'open_qty'],
    requiredOneOf: [['time_bucket', 'date', 'week_bucket']],
    optionalHeaders: ['po_line', 'supplier_id', 'delivery_date', 'uom', 'status'],
    negativeHeaders: ['parent', 'component', 'demand', 'receipt', 'price'],
    strongFeatures: [
      'po_number', // PO 強訊號
      'open_qty'   // PO 特有欄位
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'forecast_qty'],
    fieldTypeHints: {
      open_qty: 'number',
      po_number: 'string',
      date: 'date'
    },
    minConfidenceToAutoEnable: 0.75,
    description: 'Purchase order open lines'
  },

  inventory_snapshots: {
    requiredHeaders: ['material_code', 'plant_id', 'onhand_qty'],
    optionalHeaders: ['snapshot_date', 'on_hand_qty', 'available_qty', 'allocated_qty', 'safety_stock', 'uom'],
    negativeHeaders: ['supplier', 'po_number', 'parent', 'component', 'demand', 'price'],
    strongFeatures: [
      'onhand_qty',    // Inventory 強訊號
      'safety_stock',  // Inventory 特有欄位
      'available_qty'  // Inventory 特有欄位
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'po_number'],
    fieldTypeHints: {
      onhand_qty: 'number',
      safety_stock: 'number',
      snapshot_date: 'date'
    },
    minConfidenceToAutoEnable: 0.75,
    description: 'Inventory snapshot by material and plant'
  },

  fg_financials: {
    requiredHeaders: ['material_code', 'unit_margin'],
    optionalHeaders: ['plant_id', 'unit_price', 'currency', 'valid_from', 'valid_to', 'profit_per_unit'],
    negativeHeaders: ['supplier', 'po_number', 'parent', 'component', 'demand', 'inventory'],
    strongFeatures: [
      'unit_margin',      // Financials 強訊號
      'profit_per_unit',  // Financials 特有欄位
      'unit_price'        // Financials 特有欄位
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'po_number', 'supplier_name'],
    fieldTypeHints: {
      unit_margin: 'number',
      unit_price: 'number',
      valid_from: 'date',
      valid_to: 'date'
    },
    minConfidenceToAutoEnable: 0.75,
    description: 'Finished goods financial data (pricing and margin)'
  },

  supplier_master: {
    requiredHeaders: ['supplier_name'],
    optionalHeaders: ['supplier_code', 'contact_person', 'phone', 'email', 'address', 'country', 'lead_time_days', 'status'],
    negativeHeaders: ['material_code', 'demand', 'inventory', 'po_number', 'parent', 'component'],
    strongFeatures: [
      'supplier_name',   // Supplier 主鍵
      'contact_person',  // Supplier 特有欄位
      'supplier_code'    // Supplier 特有欄位
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'time_bucket', 'onhand_qty'],
    fieldTypeHints: {
      lead_time_days: 'number',
      phone: 'string',
      email: 'string'
    },
    minConfidenceToAutoEnable: 0.70, // 降低門檻，因為只有 1 個必填欄位
    description: 'Supplier master data'
  },

  goods_receipt: {
    requiredHeaders: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'],
    optionalHeaders: ['supplier_code', 'po_number', 'receipt_number', 'planned_delivery_date', 'rejected_qty', 'uom'],
    negativeHeaders: ['parent', 'component', 'demand', 'inventory', 'price_history'],
    strongFeatures: [
      'received_qty',           // GR 強訊號
      'actual_delivery_date',   // GR 特有欄位
      'receipt_number'          // GR 特有欄位
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'time_bucket'],
    fieldTypeHints: {
      received_qty: 'number',
      rejected_qty: 'number',
      actual_delivery_date: 'date',
      planned_delivery_date: 'date'
    },
    minConfidenceToAutoEnable: 0.80, // 較高門檻，因為交易性資料
    description: 'Goods receipt transactions'
  },

  operational_costs: {
    requiredHeaders: ['cost_date', 'direct_labor_hours', 'direct_labor_rate', 'production_output'],
    optionalHeaders: ['indirect_labor_hours', 'indirect_labor_rate', 'production_unit', 'material_cost', 'overhead_cost', 'notes'],
    negativeHeaders: ['supplier', 'po_number', 'parent', 'component', 'demand', 'inventory', 'receipt'],
    strongFeatures: [
      'direct_labor_hours',   // Operational cost 強訊號
      'direct_labor_rate',    // Operational cost 特有欄位
      'production_output',    // Operational cost 特有欄位
      ['cost_date', 'direct_labor_hours', 'production_output'] // 三欄同時存在（強訊號）
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'time_bucket', 'onhand_qty', 'po_number', 'supplier_name'],
    fieldTypeHints: {
      cost_date: 'date',
      direct_labor_hours: 'number',
      direct_labor_rate: 'number',
      indirect_labor_hours: 'number',
      indirect_labor_rate: 'number',
      production_output: 'number',
      material_cost: 'number',
      overhead_cost: 'number'
    },
    minConfidenceToAutoEnable: 0.75,
    description: 'Daily operational cost records (labor, material, overhead)'
  },

  price_history: {
    requiredHeaders: ['supplier_name', 'material_code', 'order_date', 'unit_price'],
    optionalHeaders: ['supplier_code', 'currency', 'quantity', 'is_contract_price'],
    negativeHeaders: ['parent', 'component', 'demand', 'inventory', 'receipt'],
    strongFeatures: [
      'unit_price',         // Price 強訊號
      'order_date',         // Price 特有欄位（交易日期）
      ['supplier_name', 'material_code', 'unit_price'] // 三欄同時存在（強訊號）
    ],
    exclusiveFeatures: ['parent_material', 'component_material', 'demand_qty', 'time_bucket', 'onhand_qty'],
    fieldTypeHints: {
      unit_price: 'number',
      quantity: 'number',
      order_date: 'date'
    },
    minConfidenceToAutoEnable: 0.80, // 較高門檻，因為交易性資料
    description: 'Price history transactions'
  }
};

/**
 * Get fingerprint rule by uploadType
 * @param {string} uploadType 
 * @returns {object|null} Fingerprint rule or null if not found
 */
export function getFingerprint(uploadType) {
  return UPLOAD_FINGERPRINTS[uploadType] || null;
}

/**
 * Get all supported uploadTypes
 * @returns {string[]} Array of uploadType keys
 */
export function getSupportedUploadTypes() {
  return Object.keys(UPLOAD_FINGERPRINTS);
}

/**
 * Check if uploadType is supported
 * @param {string} uploadType 
 * @returns {boolean}
 */
export function isSupportedUploadType(uploadType) {
  return uploadType in UPLOAD_FINGERPRINTS;
}
