/**
 * sapDataQueryService.js
 *
 * Unified in-memory SQL query engine for all enterprise data.
 * Loads data from two sources:
 *   1. CSV files (Olist dataset) from public/data/sap/
 *   2. Supabase tables (suppliers, materials, inventory, POs)
 *
 * Uses DuckDB-WASM (in-browser columnar analytics engine) to execute SQL.
 * Supports CTEs, window functions, QUANTILE_CONT (NOT PERCENTILE_CONT), MEDIAN, date functions, etc.
 * Only SELECT queries are allowed (read-only).
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';

// ── SAP Table Registry ────────────────────────────────────────────────────────

export const SAP_DATASET_INFO = Object.freeze({
  olist: {
    key: 'olist',
    label: 'Dataset A: Olist E-Commerce',
    scope: 'builtin_csv',
    availability: 'Built-in and always available in this app.',
  },
  di_ops: {
    key: 'di_ops',
    label: 'Dataset B: DI Operations',
    scope: 'current_user_scoped',
    availability: 'Depends on the current user/session having imported or synced DI operations data.',
  },
});

export const SAP_TABLE_REGISTRY = {
  // ── CSV-based tables (Olist dataset) ──────────────────────────────────────
  customers: {
    source: 'csv',
    file: 'olist_customers_dataset.csv',
    sapEquivalent: 'KNA1 (Customer Master)',
    description: 'Customer master data with location info',
    columns: ['customer_id', 'customer_unique_id', 'customer_zip_code_prefix', 'customer_city', 'customer_state'],
    columnDescriptions: {
      customer_id: 'Per-order customer key. NOT unique across orders — one real customer can have multiple customer_ids. Do NOT use COUNT(DISTINCT customer_id) for unique customers.',
      customer_unique_id: 'Actual unique customer identifier. USE THIS for counting unique customers, repeat purchase analysis, and customer segmentation.',
    },
  },
  orders: {
    source: 'csv',
    file: 'olist_orders_dataset.csv',
    sapEquivalent: 'VBAK (Sales Order Header)',
    description: 'Sales order headers with status and timestamps',
    columns: ['order_id', 'customer_id', 'order_status', 'order_purchase_timestamp', 'order_approved_at', 'order_delivered_carrier_date', 'order_delivered_customer_date', 'order_estimated_delivery_date'],
    columnDescriptions: {
      order_status: 'Order lifecycle status: delivered, shipped, canceled, unavailable, processing, created, approved, invoiced.',
      order_purchase_timestamp: 'ISO timestamp string (e.g. "2017-05-22 10:15:46"). NOT a unix epoch. Use ::TIMESTAMP to cast for date functions.',
      order_delivered_customer_date: 'Actual delivery timestamp. Compare with order_estimated_delivery_date: if actual < estimated → EARLY delivery (good). If actual > estimated → LATE delivery (bad).',
      order_estimated_delivery_date: 'Promised delivery timestamp. Delivery variance = estimated - actual. Positive = early (good), negative = late (bad). Early deliveries correlate with HIGHER review scores.',
    },
  },
  order_items: {
    source: 'csv',
    file: 'olist_order_items_dataset.csv',
    sapEquivalent: 'VBAP (Sales Order Items)',
    description: 'Order line items with product, seller, price, and freight',
    columns: ['order_id', 'order_item_id', 'product_id', 'seller_id', 'shipping_limit_date', 'price', 'freight_value'],
    columnDescriptions: {
      order_item_id: 'Sequential line-item number within an order (1, 2, 3…). NOT a quantity — do not use in SUM or arithmetic.',
      price: 'Unit price of this line item in BRL. Use SUM(price) for total revenue.',
      freight_value: 'Per-item shipping cost in BRL.',
      shipping_limit_date: 'Deadline by which the seller must ship this item.',
    },
  },
  payments: {
    source: 'csv',
    file: 'olist_order_payments_dataset.csv',
    sapEquivalent: 'BSEG (Payment Documents)',
    description: 'Payment records per order (type, installments, value)',
    columns: ['order_id', 'payment_sequential', 'payment_type', 'payment_installments', 'payment_value'],
    columnDescriptions: {
      payment_sequential: 'Sequential payment number within an order (1, 2, 3…). NOT a monetary value.',
      payment_value: 'Total monetary value of this payment in BRL. For share/percentage calculations, use SUM(payment_value) as the denominator — NOT COUNT(*).',
    },
  },
  reviews: {
    source: 'csv',
    file: 'olist_order_reviews_dataset.csv',
    sapEquivalent: 'QM (Quality Feedback)',
    description: 'Customer reviews with scores and comments',
    columns: ['review_id', 'order_id', 'review_score', 'review_comment_title', 'review_comment_message', 'review_creation_date', 'review_answer_timestamp'],
    columnDescriptions: {
      review_score: 'Customer satisfaction score from 1 (worst) to 5 (best). Early/on-time deliveries typically get HIGHER scores; late deliveries get LOWER scores.',
    },
  },
  products: {
    source: 'csv',
    file: 'olist_products_dataset.csv',
    sapEquivalent: 'MARA (Material Master)',
    description: 'Product catalog with category, dimensions, weight',
    columns: ['product_id', 'product_category_name', 'product_name_lenght', 'product_description_lenght', 'product_photos_qty', 'product_weight_g', 'product_length_cm', 'product_height_cm', 'product_width_cm'],
    columnDescriptions: {
      product_name_lenght: 'Character count of product name (not the name itself). Typo in original dataset.',
      product_description_lenght: 'Character count of product description (not the description itself). Typo in original dataset.',
      product_photos_qty: 'Number of photos for this product listing.',
      product_weight_g: 'Product weight in grams.',
    },
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
    columnDescriptions: {
      po_line: 'Sequential line number within a PO (1, 2, 3…). NOT a quantity.',
      open_qty: 'Outstanding/open quantity on this PO line.',
      time_bucket: 'Planned delivery time period (e.g., "2026-W12").',
    },
  },
  goods_receipts: {
    source: 'supabase',
    table: 'goods_receipts',
    sapEquivalent: 'MKPF (Goods Receipt)',
    description: 'Goods receipt records (supplier, material, qty, delivery dates)',
    columns: ['id', 'supplier_name', 'material_code', 'receipt_date', 'qty', 'is_on_time', 'actual_delivery_date'],
  },
};

// ── Table Metadata (row counts & date ranges for prompt enrichment) ───────────

const TABLE_METADATA = {
  customers:            { approxRows: '~99K rows' },
  orders:               { approxRows: '~99K rows', dateHints: { order_purchase_timestamp: '2016-09 to 2018-10', order_approved_at: '2016-10 to 2018-10', order_delivered_customer_date: '2016-10 to 2018-10' } },
  order_items:          { approxRows: '~112K rows' },
  payments:             { approxRows: '~103K rows' },
  reviews:              { approxRows: '~100K rows', dateHints: { review_creation_date: '2016-10 to 2018-10' } },
  products:             { approxRows: '~32K rows' },
  sellers:              { approxRows: '~3K rows' },
  geolocation:          { approxRows: '~1M rows' },
  category_translation: { approxRows: '~71 rows' },
  suppliers:            { approxRows: '~0 rows (Supabase — may be empty)' },
  materials:            { approxRows: '~0 rows (Supabase — may be empty)' },
  inventory_snapshots:  { approxRows: '~0 rows (Supabase — may be empty)' },
  po_open_lines:        { approxRows: '~0 rows (Supabase — may be empty)' },
  goods_receipts:       { approxRows: '~0 rows (Supabase — may be empty)' },
};

// ── Enriched Schema Prompt Builder ────────────────────────────────────────────

/**
 * Build a prompt-friendly schema string with column descriptions, row counts,
 * and date ranges for ambiguous columns.
 * Used by both the direct SQL generation path and the agent loop system prompt.
 */
export function buildEnrichedSchemaPrompt() {
  const header = 'IMPORTANT: Olist e-commerce data (Dataset A) covers 2016-09 to 2018-10 and is built-in. Do NOT filter by dates outside this range — it will return 0 rows. Dataset B (Supabase operational tables) is current-user scoped and may be empty if this user has not imported or synced operational data yet.';

  const tableLines = Object.entries(SAP_TABLE_REGISTRY).map(([name, entry]) => {
    const meta = TABLE_METADATA[name] || {};
    const rowInfo = meta.approxRows || '';
    const datasetInfo = getDatasetInfoForTable(name);
    const scopeInfo = datasetInfo ? `${datasetInfo.label}; scope=${datasetInfo.scope}` : '';
    const colList = `- ${name} (${entry.sapEquivalent}, ${rowInfo}${scopeInfo ? `, ${scopeInfo}` : ''}): ${entry.columns.join(', ')}`;

    const parts = [];
    // Column descriptions
    const desc = entry.columnDescriptions;
    if (desc && Object.keys(desc).length > 0) {
      parts.push(...Object.entries(desc).map(([col, text]) => `    ${col}: ${text}`));
    }
    // Date range hints
    if (meta.dateHints) {
      parts.push(...Object.entries(meta.dateHints).map(([col, range]) => `    ${col} range: ${range}`));
    }

    return parts.length > 0 ? `${colList}\n${parts.join('\n')}` : colList;
  }).join('\n');

  return `${header}\n\n${tableLines}`;
}

// ── Internal State ────────────────────────────────────────────────────────────

const _loadedTables = new Set();
const _loadingPromises = new Map(); // tableName → Promise (dedup concurrent loads)
const _tableRowCounts = {};
const MAX_RESULT_ROWS = 5000;

// Forbidden SQL keywords (only SELECT allowed)
const FORBIDDEN_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|REPLACE|EXEC|EXECUTE|GRANT|REVOKE)\b/i;

// Query serialization lock — DuckDB-WASM doesn't support concurrent queries on a single connection.
// When dual agents run in parallel, this ensures queries execute one at a time.
let _queryLock = Promise.resolve();

function buildDuckDbSqlRepairHint(errorMessage, sql) {
  const message = String(errorMessage || '').trim();
  if (/window function calls cannot be nested/i.test(message)) {
    return [
      'DuckDB does not allow nested window functions.',
      'Rewrite the query with staged CTEs/subqueries: compute totals or shares in one SELECT, then compute cumulative windows in an outer SELECT.',
      'Avoid patterns like `SUM(x / SUM(x) OVER ()) OVER (...)`.',
      'For Pareto/cumulative share analysis: first calculate `share = x / SUM(x) OVER ()`, then in the next CTE calculate `SUM(share) OVER (ORDER BY x DESC)`.',
    ].join(' ');
  }

  if (/aggregate function calls cannot contain window function calls/i.test(message)) {
    return [
      'DuckDB does not allow window functions inside aggregate function arguments.',
      'Split the query into stages: compute the window column first in a CTE, then aggregate it in the outer query.',
    ].join(' ');
  }

  if (/lateral join does not support aggregates/i.test(message)) {
    return [
      'DuckDB does not allow aggregate functions inside a LATERAL join.',
      'Move the aggregation into a separate CTE with GROUP BY, then join that CTE back to the main query.',
    ].join(' ');
  }

  if (/julianday|timestampdiff/i.test(String(sql || ''))) {
    return 'Use DuckDB date functions instead: DATE_TRUNC, EXTRACT, DATEDIFF, or direct date subtraction.';
  }

  return '';
}

// ── DuckDB-WASM Singleton ─────────────────────────────────────────────────────

let _db = null;
let _conn = null;
let _initPromise = null;

async function getDuckDB() {
  if (_conn) return { db: _db, conn: _conn };
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // Use local WASM files via Vite ?url imports to avoid CDN CORS issues.
    const worker = new Worker(duckdbWorkerUrl, { type: 'module' });
    const logger = new duckdb.ConsoleLogger();
    _db = new duckdb.AsyncDuckDB(logger, worker);
    await _db.instantiate(duckdbWasmUrl);

    _conn = await _db.connect();
    console.info('[sapDataQuery] DuckDB-WASM initialized successfully (local bundle)');
    return { db: _db, conn: _conn };
  })();

  return _initPromise;
}

// ── CSV Loader (DuckDB native) ────────────────────────────────────────────────

async function loadCsvTable(tableName, filename) {
  const { db, conn } = await getDuckDB();
  const url = `${window.location.origin}/data/sap/${filename}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${filename}: ${response.status}`);
  const csvText = await response.text();

  await db.registerFileText(`${tableName}.csv`, csvText);
  await conn.query(`
    CREATE OR REPLACE TABLE ${tableName} AS
    SELECT * FROM read_csv_auto('${tableName}.csv', header=true, auto_detect=true)
  `);

  const countResult = await conn.query(`SELECT COUNT(*)::INTEGER as cnt FROM ${tableName}`);
  _tableRowCounts[tableName] = countResult.toArray()[0].cnt;
  _loadedTables.add(tableName);
}

// ── Supabase Loader ───────────────────────────────────────────────────────────

async function fetchFromSupabase(supabaseTable) {
  // Dynamic import to avoid circular dependency
  const { supabase } = await import('../infra/supabaseClient.js');
  const { data, error } = await supabase
    .from(supabaseTable)
    .select('*')
    .limit(10000);

  if (error) throw new Error(`Supabase query failed for ${supabaseTable}: ${error.message}`);
  return data || [];
}

function getDatasetInfoForEntry(entry) {
  if (!entry) return null;
  if (entry.source === 'csv') return SAP_DATASET_INFO.olist;
  if (entry.source === 'supabase') return SAP_DATASET_INFO.di_ops;
  return null;
}

function getDatasetInfoForTable(tableName) {
  return getDatasetInfoForEntry(SAP_TABLE_REGISTRY[tableName]);
}

function buildTableProbe(tableName, overrides = {}) {
  const entry = SAP_TABLE_REGISTRY[tableName];
  const datasetInfo = getDatasetInfoForEntry(entry);
  const rowCount = Number.isFinite(overrides.rowCount)
    ? overrides.rowCount
    : (_tableRowCounts[tableName] ?? null);

  return {
    table_name: tableName,
    source: entry?.source || null,
    sap_equivalent: entry?.sapEquivalent || null,
    description: entry?.description || null,
    columns: entry?.columns || [],
    dataset_key: datasetInfo?.key || null,
    dataset_label: datasetInfo?.label || null,
    dataset_scope: datasetInfo?.scope || null,
    row_count: rowCount,
    is_empty: rowCount === 0,
    loaded: _loadedTables.has(tableName),
    error: overrides.error || null,
  };
}

function buildQueryMetaFromTables(tableNames = []) {
  const uniqueTables = [...new Set((tableNames || []).filter(Boolean))];
  const tableDetails = uniqueTables.map((tableName) => buildTableProbe(tableName));
  const datasetLabels = [...new Set(tableDetails.map((table) => table.dataset_label).filter(Boolean))];
  const datasetScopes = [...new Set(tableDetails.map((table) => table.dataset_scope).filter(Boolean))];

  return {
    tables_queried: uniqueTables,
    tables: tableDetails,
    dataset_label: datasetLabels.length === 1 ? datasetLabels[0] : datasetLabels.join(' + '),
    dataset_scope: datasetScopes.length === 1 ? datasetScopes[0] : (datasetScopes.length > 1 ? 'mixed' : null),
  };
}

async function loadSupabaseTable(tableName, rows) {
  const { db, conn } = await getDuckDB();
  const jsonStr = JSON.stringify(rows);
  await db.registerFileText(`${tableName}.json`, jsonStr);
  await conn.query(`
    CREATE OR REPLACE TABLE ${tableName} AS
    SELECT * FROM read_json_auto('${tableName}.json')
  `);

  _tableRowCounts[tableName] = rows.length;
  _loadedTables.add(tableName);
}

// ── Table Loader ──────────────────────────────────────────────────────────────

async function ensureTableLoaded(tableName) {
  if (_loadedTables.has(tableName)) return;

  // Dedup: if another agent is already loading this table, wait for that instead
  if (_loadingPromises.has(tableName)) return _loadingPromises.get(tableName);

  const entry = SAP_TABLE_REGISTRY[tableName];
  if (!entry) throw new Error(`Unknown table: ${tableName}. Available: ${Object.keys(SAP_TABLE_REGISTRY).join(', ')}`);

  const promise = (async () => {
    if (entry.source === 'csv') {
      await loadCsvTable(tableName, entry.file);
    } else if (entry.source === 'supabase') {
      const rows = await fetchFromSupabase(entry.table);
      await loadSupabaseTable(tableName, rows);
    } else {
      throw new Error(`Unknown source type for table ${tableName}: ${entry.source}`);
    }
  })();
  _loadingPromises.set(tableName, promise);

  try {
    await promise;
  } finally {
    _loadingPromises.delete(tableName);
  }
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

/**
 * Convert DuckDB Arrow result rows to plain JS objects.
 * Handles BigInt → Number and Date → ISO string coercion.
 */
function coerceRow(row) {
  const obj = row.toJSON();
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'bigint') {
      obj[key] = Number(val);
    } else if (val instanceof Date) {
      obj[key] = val.toISOString();
    }
  }
  return obj;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a SQL query against SAP master data tables.
 * Only SELECT statements are allowed. Results capped at 5000 rows.
 *
 * @param {object} params
 * @param {string} params.sql - SQL query string
 * @returns {{ success: boolean, rows: object[], rowCount: number, truncated: boolean, error?: string }}
 */
export async function executeQuery({ sql }) {
  if (!sql || typeof sql !== 'string') {
    return { success: false, rows: [], rowCount: 0, truncated: false, error: 'Missing or invalid sql parameter', meta: buildQueryMetaFromTables([]) };
  }

  const trimmed = sql.trim();

  // Security: only SELECT allowed
  if (FORBIDDEN_PATTERN.test(trimmed)) {
    return {
      success: false,
      rows: [],
      rowCount: 0,
      truncated: false,
      error: 'Only SELECT queries are allowed. INSERT/UPDATE/DELETE/DROP are forbidden.',
      meta: buildQueryMetaFromTables(extractTableNames(trimmed)),
    };
  }

  if (!/^\s*SELECT\b/i.test(trimmed) && !/^\s*WITH\b/i.test(trimmed)) {
    return {
      success: false,
      rows: [],
      rowCount: 0,
      truncated: false,
      error: 'Only SELECT queries are allowed.',
      meta: buildQueryMetaFromTables(extractTableNames(trimmed)),
    };
  }

  // Serialize: DuckDB-WASM single connection can't handle concurrent queries.
  // Wait for any prior query to finish before starting ours.
  const ticket = _queryLock;
  let release;
  _queryLock = new Promise((r) => { release = r; });

  try {
    await ticket;

    // Auto-load referenced tables
    const tables = extractTableNames(trimmed);
    const queryMeta = buildQueryMetaFromTables(tables);
    console.info('[sapDataQuery] SQL:', trimmed.slice(0, 500));
    console.info('[sapDataQuery] Tables referenced:', tables.length > 0 ? tables.join(', ') : '(none detected)');

    if (tables.length > 0) {
      await Promise.all(tables.map(ensureTableLoaded));
      console.info('[sapDataQuery] Table row counts:', tables.map(t => `${t}=${_tableRowCounts[t] ?? '?'}`).join(', '));
    }

    const { conn } = await getDuckDB();
    const arrowResult = await conn.query(trimmed);
    const allRows = arrowResult.toArray().map(coerceRow);

    if (allRows.length === 0) {
      console.warn('[sapDataQuery] 0 rows returned. Full SQL:', trimmed);
    } else {
      console.info(`[sapDataQuery] Result: ${allRows.length} rows`);
    }

    const truncated = allRows.length > MAX_RESULT_ROWS;
    const limited = truncated ? allRows.slice(0, MAX_RESULT_ROWS) : allRows;

    return {
      success: true,
      rows: limited,
      rowCount: allRows.length,
      truncated,
      meta: {
        ...queryMeta,
        emptyReason: allRows.length === 0 ? 'no_matching_rows' : null,
      },
      ...(truncated ? { note: `Result truncated to ${MAX_RESULT_ROWS} rows (total: ${allRows.length})` } : {}),
    };
  } catch (err) {
    console.error('[sapDataQuery] SQL error:', err.message, '| SQL:', trimmed.slice(0, 300));
    const repairHint = buildDuckDbSqlRepairHint(err?.message, trimmed);
    return {
      success: false,
      rows: [],
      rowCount: 0,
      truncated: false,
      error: repairHint
        ? `SQL error: ${err.message} Hint: ${repairHint}`
        : `SQL error: ${err.message}`,
      meta: buildQueryMetaFromTables(extractTableNames(trimmed)),
    };
  } finally {
    release();
  }
}

export async function probeTables(tableNames = []) {
  const requested = Array.isArray(tableNames) && tableNames.length > 0
    ? [...new Set(tableNames.map((name) => String(name || '').trim()).filter(Boolean))]
    : Object.keys(SAP_TABLE_REGISTRY);

  const probes = [];
  for (const tableName of requested) {
    if (!SAP_TABLE_REGISTRY[tableName]) {
      probes.push({
        table_name: tableName,
        source: null,
        sap_equivalent: null,
        description: null,
        columns: [],
        dataset_key: null,
        dataset_label: null,
        dataset_scope: null,
        row_count: null,
        is_empty: null,
        loaded: false,
        error: `Unknown table: ${tableName}`,
      });
      continue;
    }

    try {
      await ensureTableLoaded(tableName);
      probes.push(buildTableProbe(tableName));
    } catch (err) {
      probes.push(buildTableProbe(tableName, { error: String(err?.message || err) }));
    }
  }

  const datasetLabels = [...new Set(probes.map((probe) => probe.dataset_label).filter(Boolean))];
  const datasetScopes = [...new Set(probes.map((probe) => probe.dataset_scope).filter(Boolean))];

  return {
    success: probes.every((probe) => !probe.error),
    tables: probes,
    dataset_label: datasetLabels.length === 1 ? datasetLabels[0] : datasetLabels.join(' + '),
    dataset_scope: datasetScopes.length === 1 ? datasetScopes[0] : (datasetScopes.length > 1 ? 'mixed' : null),
  };
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
    dataset_key: getDatasetInfoForTable(name)?.key || null,
    dataset_label: getDatasetInfoForTable(name)?.label || null,
    dataset_scope: getDatasetInfoForTable(name)?.scope || null,
    row_count: _tableRowCounts[name] ?? '(not loaded yet — will load on first query)',
    loaded: _loadedTables.has(name),
  }));

  return {
    success: true,
    tables,
    usage: 'Use query_sap_data with SQL like: SELECT customer_state, COUNT(*) as cnt FROM customers GROUP BY customer_state ORDER BY cnt DESC LIMIT 10',
  };
}
