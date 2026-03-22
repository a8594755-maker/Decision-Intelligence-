/**
 * sapDataQueryService.js
 *
 * Unified in-memory SQL query engine for all enterprise data.
 * Loads data from two sources:
 *   1. CSV files (Olist dataset) from public/data/sap/
 *   2. Supabase tables (suppliers, materials, inventory, POs)
 *
 * Uses AlaSQL to execute real SQL on in-memory arrays.
 * Only SELECT queries are allowed (read-only).
 */

import alasql from 'alasql';
import Papa from 'papaparse';

// ── SAP Table Registry ────────────────────────────────────────────────────────

export const SAP_TABLE_REGISTRY = {
  // ── CSV-based tables (Olist dataset) ──────────────────────────────────────
  customers: {
    source: 'csv',
    file: 'olist_customers_dataset.csv',
    sapEquivalent: 'KNA1 (Customer Master)',
    description: 'Customer master data with location info',
    columns: ['customer_id', 'customer_unique_id', 'customer_zip_code_prefix', 'customer_city', 'customer_state'],
  },
  orders: {
    source: 'csv',
    file: 'olist_orders_dataset.csv',
    sapEquivalent: 'VBAK (Sales Order Header)',
    description: 'Sales order headers with status and timestamps',
    columns: ['order_id', 'customer_id', 'order_status', 'order_purchase_timestamp', 'order_approved_at', 'order_delivered_carrier_date', 'order_delivered_customer_date', 'order_estimated_delivery_date'],
  },
  order_items: {
    source: 'csv',
    file: 'olist_order_items_dataset.csv',
    sapEquivalent: 'VBAP (Sales Order Items)',
    description: 'Order line items with product, seller, price, and freight',
    columns: ['order_id', 'order_item_id', 'product_id', 'seller_id', 'shipping_limit_date', 'price', 'freight_value'],
  },
  payments: {
    source: 'csv',
    file: 'olist_order_payments_dataset.csv',
    sapEquivalent: 'BSEG (Payment Documents)',
    description: 'Payment records per order (type, installments, value)',
    columns: ['order_id', 'payment_sequential', 'payment_type', 'payment_installments', 'payment_value'],
  },
  reviews: {
    source: 'csv',
    file: 'olist_order_reviews_dataset.csv',
    sapEquivalent: 'QM (Quality Feedback)',
    description: 'Customer reviews with scores and comments',
    columns: ['review_id', 'order_id', 'review_score', 'review_comment_title', 'review_comment_message', 'review_creation_date', 'review_answer_timestamp'],
  },
  products: {
    source: 'csv',
    file: 'olist_products_dataset.csv',
    sapEquivalent: 'MARA (Material Master)',
    description: 'Product catalog with category, dimensions, weight',
    columns: ['product_id', 'product_category_name', 'product_name_lenght', 'product_description_lenght', 'product_photos_qty', 'product_weight_g', 'product_length_cm', 'product_height_cm', 'product_width_cm'],
  },
  sellers: {
    source: 'csv',
    file: 'olist_sellers_dataset.csv',
    sapEquivalent: 'LFA1 (Vendor Master)',
    description: 'Seller/vendor master data with location',
    columns: ['seller_id', 'seller_zip_code_prefix', 'seller_city', 'seller_state'],
  },
  geolocation: {
    source: 'csv',
    file: 'olist_geolocation_dataset.csv',
    sapEquivalent: 'ADRC (Address)',
    description: 'Geolocation data by zip code (lat/lng, city, state). ~1M rows, may take a few seconds to load.',
    columns: ['geolocation_zip_code_prefix', 'geolocation_lat', 'geolocation_lng', 'geolocation_city', 'geolocation_state'],
  },
  category_translation: {
    source: 'csv',
    file: 'product_category_name_translation.csv',
    sapEquivalent: 'T023T (Material Group Text)',
    description: 'Product category name translation (Portuguese → English)',
    columns: ['product_category_name', 'product_category_name_english'],
  },

  // ── Supabase-based tables (existing operational data) ─────────────────────
  suppliers: {
    source: 'supabase',
    table: 'suppliers',
    sapEquivalent: 'LFA1 (Vendor Master — operational)',
    description: 'Operational supplier records (code, name, status, contact)',
    columns: ['id', 'supplier_code', 'supplier_name', 'status', 'contact_info', 'created_at'],
  },
  materials: {
    source: 'supabase',
    table: 'materials',
    sapEquivalent: 'MARA (Material Master — operational)',
    description: 'Operational material records (code, name, category, UOM)',
    columns: ['id', 'material_code', 'material_name', 'category', 'uom', 'created_at'],
  },
  inventory_snapshots: {
    source: 'supabase',
    table: 'inventory_snapshots',
    sapEquivalent: 'MARD (Inventory)',
    description: 'Inventory snapshots (material, plant, onhand qty, safety stock)',
    columns: ['id', 'material_code', 'plant_id', 'snapshot_date', 'onhand_qty', 'safety_stock', 'uom'],
  },
  po_open_lines: {
    source: 'supabase',
    table: 'po_open_lines',
    sapEquivalent: 'EKPO (Purchase Order Items)',
    description: 'Open purchase order lines (PO number, material, qty, status)',
    columns: ['id', 'po_number', 'po_line', 'material_code', 'plant_id', 'time_bucket', 'open_qty', 'status'],
  },
  goods_receipts: {
    source: 'supabase',
    table: 'goods_receipts',
    sapEquivalent: 'MKPF (Goods Receipt)',
    description: 'Goods receipt records (supplier, material, qty, delivery dates)',
    columns: ['id', 'supplier_name', 'material_code', 'receipt_date', 'qty', 'is_on_time', 'actual_delivery_date'],
  },
};

// ── Internal State ────────────────────────────────────────────────────────────

const _loadedTables = new Set();
const _tableRowCounts = {};
const MAX_RESULT_ROWS = 5000;

// Forbidden SQL keywords (only SELECT allowed)
const FORBIDDEN_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|REPLACE|EXEC|EXECUTE|GRANT|REVOKE)\b/i;

// ── CSV Loader ────────────────────────────────────────────────────────────────

async function fetchAndParseCsv(filename) {
  const url = `${window.location.origin}/data/sap/${filename}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${filename}: ${response.status}`);
  const text = await response.text();

  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

// ── Supabase Loader ───────────────────────────────────────────────────────────

async function fetchFromSupabase(supabaseTable) {
  // Dynamic import to avoid circular dependency
  const { supabase } = await import('./supabaseClient.js');
  const { data, error } = await supabase
    .from(supabaseTable)
    .select('*')
    .limit(10000);

  if (error) throw new Error(`Supabase query failed for ${supabaseTable}: ${error.message}`);
  return data || [];
}

// ── Table Loader ──────────────────────────────────────────────────────────────

function registerInAlasql(tableName, rows) {
  alasql(`DROP TABLE IF EXISTS [${tableName}]`);
  alasql(`CREATE TABLE [${tableName}]`);
  alasql.tables[tableName].data = rows;
  _tableRowCounts[tableName] = rows.length;
  _loadedTables.add(tableName);
}

/**
 * Load a single table into AlaSQL if not already loaded.
 */
async function ensureTableLoaded(tableName) {
  if (_loadedTables.has(tableName)) return;

  const entry = SAP_TABLE_REGISTRY[tableName];
  if (!entry) throw new Error(`Unknown table: ${tableName}. Available: ${Object.keys(SAP_TABLE_REGISTRY).join(', ')}`);

  let rows;
  if (entry.source === 'csv') {
    rows = await fetchAndParseCsv(entry.file);
  } else if (entry.source === 'supabase') {
    rows = await fetchFromSupabase(entry.table);
  } else {
    throw new Error(`Unknown source type for table ${tableName}: ${entry.source}`);
  }

  registerInAlasql(tableName, rows);
}

/**
 * Extract table names referenced in a SQL query.
 */
function extractTableNames(sql) {
  const tables = new Set();
  // Match FROM/JOIN followed by table name (with optional alias)
  const pattern = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1].toLowerCase();
    if (SAP_TABLE_REGISTRY[name]) {
      tables.add(name);
    }
  }
  return [...tables];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a SQL query against SAP master data tables.
 * Only SELECT statements are allowed. Results capped at 500 rows.
 *
 * @param {object} params
 * @param {string} params.sql - SQL query string
 * @returns {{ success: boolean, rows: object[], rowCount: number, truncated: boolean, error?: string }}
 */
export async function executeQuery({ sql }) {
  if (!sql || typeof sql !== 'string') {
    return { success: false, rows: [], rowCount: 0, truncated: false, error: 'Missing or invalid sql parameter' };
  }

  const trimmed = sql.trim();

  // Security: only SELECT allowed
  if (FORBIDDEN_PATTERN.test(trimmed)) {
    return { success: false, rows: [], rowCount: 0, truncated: false, error: 'Only SELECT queries are allowed. INSERT/UPDATE/DELETE/DROP are forbidden.' };
  }

  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return { success: false, rows: [], rowCount: 0, truncated: false, error: 'Only SELECT queries are allowed.' };
  }

  try {
    // Auto-load referenced tables
    const tables = extractTableNames(trimmed);
    if (tables.length > 0) {
      await Promise.all(tables.map(ensureTableLoaded));
    }

    // Execute SQL
    const result = alasql(trimmed);
    const rows = Array.isArray(result) ? result : [];
    const truncated = rows.length > MAX_RESULT_ROWS;
    const limited = truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows;

    return {
      success: true,
      rows: limited,
      rowCount: rows.length,
      truncated,
      ...(truncated ? { note: `Result truncated to ${MAX_RESULT_ROWS} rows (total: ${rows.length})` } : {}),
    };
  } catch (err) {
    return { success: false, rows: [], rowCount: 0, truncated: false, error: `SQL error: ${err.message}` };
  }
}

/**
 * Get schema information for all SAP master data tables.
 *
 * @returns {{ success: boolean, tables: object[] }}
 */
export async function getSchema() {
  const tables = Object.entries(SAP_TABLE_REGISTRY).map(([name, entry]) => ({
    table_name: name,
    source: entry.source,
    sap_equivalent: entry.sapEquivalent,
    description: entry.description,
    columns: entry.columns,
    row_count: _tableRowCounts[name] ?? '(not loaded yet — will load on first query)',
    loaded: _loadedTables.has(name),
  }));

  return {
    success: true,
    tables,
    usage: 'Use query_sap_data with SQL like: SELECT customer_state, COUNT(*) as cnt FROM customers GROUP BY customer_state ORDER BY cnt DESC LIMIT 10',
  };
}
