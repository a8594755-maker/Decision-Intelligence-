/**
 * Header Synonym Dictionary
 * 定義欄位名稱的同義字映射（可擴充）
 * 
 * TODO: 未來可改為從資料庫載入，允許使用者自訂 synonyms
 */

// Lazy reference to inferFieldFromValues — set via setInferenceFn() to avoid circular imports
let _inferFn = null;

/**
 * Register the pattern inference function. Called once at app startup.
 * @param {Function} fn – inferFieldFromValues from fieldPatternInference.js
 */
export function setInferenceFn(fn) {
  _inferFn = fn;
}

export const HEADER_SYNONYMS = {
  // Material / Part Number
  'material_code': ['part_no', 'part_number', 'item', 'item_code', 'item_id', 'part', 'sku', 'sku_id', 'product_code', 'product_id', 'article', 'pn', 'material_no'],
  'material_name': ['part_name', 'item_name', 'product_name', 'description', 'material_desc'],
  
  // Parent/Child (BOM)
  'parent_material': ['parent', 'parent_part', 'parent_item', 'assembly', 'finished_good', 'fg'],
  'component_material': ['component', 'child', 'child_part', 'child_item', 'raw_material', 'rm'],
  'child_material': ['component', 'child', 'child_part', 'child_item'],
  
  // Quantity
  'qty': ['quantity', 'amount', 'volume'],
  'qty_per': ['usage', 'usage_qty', 'unit_qty', 'consumption', 'per_unit'],
  'demand_qty': ['demand', 'forecast', 'requirement', 'need', 'units_sold', 'unit_sold', 'sold_units', 'sales_units'],
  'open_qty': ['open', 'outstanding', 'remaining', 'balance'],
  'onhand_qty': ['onhand', 'on_hand', 'on_hand_start', 'on_hand_end_units', 'stock', 'inventory', 'oh_qty', 'available'],
  'received_qty': ['received', 'receipt_qty', 'gr_qty', 'goods_received'],
  'rejected_qty': ['rejected', 'reject_qty', 'ng_qty', 'defect_qty'],
  
  // Plant / Location
  'plant_id': ['plant', 'site', 'location', 'factory', 'warehouse', 'plant_code', 'store', 'store_id', 'store_code', 'dc', 'dc_id'],
  
  // Time / Date
  'time_bucket': ['week', 'bucket', 'period', 'time_period', 'week_start', 'week_end', 'wm_yr_wk'],
  'week_bucket': ['week', 'week_no', 'calendar_week', 'wk', 'wm_yr_wk'],
  'date': ['delivery_date', 'ship_date', 'due_date', 'schedule_date'],
  'snapshot_date': ['date', 'snapshot', 'as_of_date', 'stock_date'],
  'actual_delivery_date': ['actual_date', 'delivered_date', 'gr_date'],
  'planned_delivery_date': ['planned_date', 'scheduled_date', 'eta', 'target_date'],
  'order_date': ['po_date', 'purchase_date', 'order_time'],
  
  // Financial
  'unit_price': ['price', 'cost', 'unit_cost', 'piece_price', 'sell_price'],
  'unit_margin': ['margin', 'profit', 'profit_per_unit', 'contribution_margin'],
  'currency': ['curr', 'currency_code', 'ccy'],

  // Operational Cost
  'cost_date': ['record_date', 'report_date', 'cost_day', 'costdate'],
  'direct_labor_hours': ['dl_hours', 'direct_hours', 'labor_hours', 'directlaborhours'],
  'direct_labor_rate': ['dl_rate', 'hourly_rate', 'labor_rate', 'directlaborrate'],
  'indirect_labor_hours': ['idl_hours', 'indirect_hours', 'overhead_hours', 'indirectlaborhours'],
  'indirect_labor_rate': ['idl_rate', 'indirect_rate', 'indirectlaborrate'],
  'production_output': ['output', 'output_qty', 'production_qty', 'produced_qty', 'productionoutput'],
  'production_unit': ['output_unit', 'prod_unit', 'productionunit'],
  'material_cost': ['mat_cost', 'raw_material_cost', 'materialcost'],
  'overhead_cost': ['oh_cost', 'factory_overhead', 'overheadcost'],
  
  // Supplier
  'supplier_name': ['vendor', 'supplier', 'vendor_name', 'manufacturer'],
  'supplier_code': ['vendor_code', 'supplier_id', 'vendor_id', 'vendor_no'],
  
  // PO
  'po_number': ['po', 'purchase_order', 'order_no', 'po_no', 'order_number'],
  'po_line': ['line', 'line_no', 'item_no', 'position'],
  'receipt_number': ['gr_no', 'receipt_no', 'goods_receipt', 'grn'],
  
  // Inventory
  'safety_stock': ['ss', 'min_stock', 'buffer_stock', 'safety_stock_units'],
  'allocated_qty': ['allocated', 'reserved', 'committed'],
  'available_qty': ['available', 'free_stock', 'unreserved'],
  
  // Unit of Measure
  'uom': ['unit', 'um', 'measure', 'unit_of_measure'],
  
  // Status
  'status': ['state', 'condition', 'flag'],
  
  // Contact
  'contact_person': ['contact', 'contact_name', 'representative', 'buyer'],
  'phone': ['telephone', 'tel', 'mobile', 'contact_no'],
  'email': ['e_mail', 'mail', 'email_address'],
  
  // Other
  'lead_time_days': ['lead_time', 'lt', 'delivery_time', 'leadtime'],
  'country': ['nation', 'country_code'],
  'address': ['addr', 'location', 'site_address']
};

/**
 * Normalize header string
 * - Convert to lowercase
 * - Replace spaces/dashes with underscores
 * - Trim whitespace
 * - Collapse multiple underscores
 * 
 * @param {string} header - Raw header string
 * @returns {string} Normalized header
 */
export function normalizeHeader(header) {
  if (!header || typeof header !== 'string') return '';
  
  return header
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')  // camelCase/PascalCase to snake_case
    .toLowerCase()
    .replace(/[\s-]+/g, '_')  // spaces and dashes to underscore
    .replace(/_+/g, '_')        // collapse multiple underscores
    .replace(/^_|_$/g, '');     // remove leading/trailing underscores
}

/**
 * Map raw header to canonical field name using synonyms
 * 
 * @param {string} rawHeader - Raw header from Excel
 * @returns {string|null} Canonical field name or null if no match
 */
export function mapHeaderToCanonical(rawHeader) {
  const normalized = normalizeHeader(rawHeader);
  
  // Check if it's already canonical
  if (normalized in HEADER_SYNONYMS) {
    return normalized;
  }
  
  // Search through synonyms
  for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    const normalizedSynonyms = synonyms.map(s => normalizeHeader(s));
    if (normalizedSynonyms.includes(normalized)) {
      return canonical;
    }
  }
  
  return null;
}

/**
 * Batch map multiple headers to canonical names
 * 
 * @param {string[]} headers - Array of raw headers
 * @returns {Map<string, string>} Map from raw header to canonical name
 */
export function batchMapHeaders(headers) {
  const mapping = new Map();
  
  for (const header of headers) {
    const canonical = mapHeaderToCanonical(header);
    if (canonical) {
      mapping.set(header, canonical);
    }
  }
  
  return mapping;
}

/**
 * Get all possible synonyms for a canonical field (for fuzzy search)
 * 
 * @param {string} canonicalField 
 * @returns {string[]} Array of synonyms (including canonical name)
 */
export function getSynonymsFor(canonicalField) {
  const synonyms = HEADER_SYNONYMS[canonicalField] || [];
  return [canonicalField, ...synonyms];
}

/**
 * Map a raw header to a canonical field name with confidence scoring.
 * Chains: exact match → synonym match → value-based pattern inference.
 *
 * @param {string}   rawHeader       – Raw header from Excel
 * @param {any[]}    [sampleValues]  – Sample values from the column (for inference)
 * @param {string[]} [candidateFields] – Canonical fields still unmapped (narrows inference)
 * @returns {{ canonical: string|null, confidence: number, matchType: 'exact'|'synonym'|'inference'|'none' }}
 */
export function mapHeaderWithInference(rawHeader, sampleValues = [], candidateFields = []) {
  const normalized = normalizeHeader(rawHeader);

  // Layer 1: exact canonical match
  if (normalized in HEADER_SYNONYMS) {
    return { canonical: normalized, confidence: 1.0, matchType: 'exact' };
  }

  // Layer 2: synonym dictionary match
  for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    const normalizedSynonyms = synonyms.map(s => normalizeHeader(s));
    if (normalizedSynonyms.includes(normalized)) {
      return { canonical, confidence: 0.9, matchType: 'synonym' };
    }
  }

  // Layer 3: value-based pattern inference
  // Uses _inferFn which is lazily set via setInferenceFn() to avoid circular deps
  if (sampleValues && sampleValues.length > 0 && _inferFn) {
    const inference = _inferFn(sampleValues, candidateFields);
    if (inference) {
      return {
        canonical: inference.field,
        confidence: inference.confidence,
        matchType: 'inference',
      };
    }
  }

  return { canonical: null, confidence: 0, matchType: 'none' };
}

/**
 * Batch map headers with inference support.
 * Returns enriched mapping results with confidence for each header.
 *
 * @param {string[]}  headers        – Raw headers
 * @param {object[]}  [sampleRows]   – Sample rows for inference
 * @returns {Map<string, { canonical: string, confidence: number, matchType: string }>}
 */
export function batchMapHeadersWithInference(headers, sampleRows = []) {
  const mapping = new Map();
  const alreadyMapped = new Set();

  // First pass: exact + synonym matches (high confidence)
  for (const header of headers) {
    const result = mapHeaderWithInference(header);
    if (result.canonical && !alreadyMapped.has(result.canonical)) {
      mapping.set(header, result);
      alreadyMapped.add(result.canonical);
    }
  }

  // Second pass: inference for unmapped headers
  if (sampleRows.length > 0) {
    const unmapped = headers.filter(h => !mapping.has(h));
    for (const header of unmapped) {
      const values = sampleRows.map(row => row[header]).filter(v => v !== undefined && v !== null);
      const candidates = [...new Set(
        Object.keys(HEADER_SYNONYMS).filter(f => !alreadyMapped.has(f))
      )];
      const result = mapHeaderWithInference(header, values, candidates);
      if (result.canonical && !alreadyMapped.has(result.canonical)) {
        mapping.set(header, result);
        alreadyMapped.add(result.canonical);
      }
    }
  }

  return mapping;
}

/**
 * TODO: 擴充點 - 允許使用者自訂 synonyms
 *
 * 未來可實作：
 * - loadCustomSynonyms(userId): 從 DB 載入使用者自訂 synonyms
 * - saveCustomSynonym(userId, canonical, synonym): 儲存新的 synonym
 * - mergeWithCustomSynonyms(customSynonyms): 合併系統與自訂 synonyms
 */
