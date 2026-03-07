/**
 * liveDataQueryService.js
 *
 * Unified query/update service for Plan Studio Data tab.
 * Provides a registry-driven approach to browse and inline-edit database records.
 */

import { supabase } from './supabaseClient';
import { recordFieldEdit } from './dataEditAuditService';

// ── Table Registry ───────────────────────────────────────────────────────────

export const TABLE_REGISTRY = {
  suppliers: {
    label: 'Suppliers',
    table: 'suppliers',
    displayColumns: ['supplier_code', 'supplier_name', 'status', 'contact_info', 'created_at'],
    editableFields: {
      supplier_name: { type: 'text', label: 'Name' },
      status: { type: 'select', label: 'Status', options: ['active', 'inactive'] },
      contact_info: { type: 'text', label: 'Contact' },
    },
    filterFields: [
      { key: 'supplier_name', label: 'Supplier Name', type: 'ilike' },
      { key: 'supplier_code', label: 'Code', type: 'eq' },
      { key: 'status', label: 'Status', type: 'eq' },
    ],
    defaultSort: { column: 'created_at', ascending: false },
    idField: 'id',
  },
  materials: {
    label: 'Materials',
    table: 'materials',
    displayColumns: ['material_code', 'material_name', 'category', 'uom', 'created_at'],
    editableFields: {
      material_name: { type: 'text', label: 'Name' },
      category: { type: 'text', label: 'Category' },
      uom: { type: 'text', label: 'UOM' },
    },
    filterFields: [
      { key: 'material_code', label: 'Material Code', type: 'eq' },
      { key: 'material_name', label: 'Name', type: 'ilike' },
      { key: 'category', label: 'Category', type: 'eq' },
    ],
    defaultSort: { column: 'material_code', ascending: true },
    idField: 'id',
  },
  inventory_snapshots: {
    label: 'Inventory',
    table: 'inventory_snapshots',
    displayColumns: ['material_code', 'plant_id', 'snapshot_date', 'onhand_qty', 'safety_stock', 'uom'],
    editableFields: {
      safety_stock: { type: 'number', label: 'Safety Stock', min: 0 },
      notes: { type: 'text', label: 'Notes' },
    },
    filterFields: [
      { key: 'material_code', label: 'Material', type: 'eq' },
      { key: 'plant_id', label: 'Plant', type: 'eq' },
    ],
    defaultSort: { column: 'snapshot_date', ascending: false },
    idField: 'id',
  },
  po_open_lines: {
    label: 'Open POs',
    table: 'po_open_lines',
    displayColumns: ['po_number', 'po_line', 'material_code', 'plant_id', 'time_bucket', 'open_qty', 'status'],
    editableFields: {
      open_qty: { type: 'number', label: 'Open Qty', min: 0 },
      status: { type: 'select', label: 'Status', options: ['open', 'closed', 'cancelled'] },
      notes: { type: 'text', label: 'Notes' },
    },
    filterFields: [
      { key: 'material_code', label: 'Material', type: 'eq' },
      { key: 'plant_id', label: 'Plant', type: 'eq' },
      { key: 'po_number', label: 'PO Number', type: 'eq' },
      { key: 'status', label: 'Status', type: 'eq' },
    ],
    defaultSort: { column: 'time_bucket', ascending: true },
    idField: 'id',
  },
};

// ── Local data cache (offline fallback) ──────────────────────────────────────

const _localCache = {};

/**
 * Set local data for a table (used when Supabase is unavailable).
 * @param {string} tableName - Registry key (e.g. 'suppliers', 'inventory_snapshots')
 * @param {Array<object>} rows - Mapped rows matching the table schema
 */
export function setLocalTableData(tableName, rows) {
  if (!TABLE_REGISTRY[tableName]) return;
  _localCache[tableName] = Array.isArray(rows) ? rows : [];
}

/**
 * Clear all local table data.
 */
export function clearLocalTableData() {
  Object.keys(_localCache).forEach((key) => { delete _localCache[key]; });
}

function queryLocalCache(tableName, { filters = {}, sort = null, limit = 50, offset = 0 } = {}) {
  const config = TABLE_REGISTRY[tableName];
  if (!config) return { rows: [], totalCount: 0 };
  let rows = [...(_localCache[tableName] || [])];

  // Apply filters
  for (const filterDef of config.filterFields) {
    const value = filters[filterDef.key];
    if (value == null || value === '') continue;
    if (filterDef.type === 'ilike') {
      const pattern = String(value).toLowerCase();
      rows = rows.filter((r) => String(r[filterDef.key] || '').toLowerCase().includes(pattern));
    } else {
      rows = rows.filter((r) => String(r[filterDef.key] || '') === String(value));
    }
  }

  // Sort
  const { column: sortCol, ascending: sortAsc } = sort || config.defaultSort;
  rows.sort((a, b) => {
    const av = a[sortCol] ?? '';
    const bv = b[sortCol] ?? '';
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortAsc ? cmp : -cmp;
  });

  const totalCount = rows.length;
  return { rows: rows.slice(offset, offset + limit), totalCount };
}

// ── Query ────────────────────────────────────────────────────────────────────

/**
 * Query a table with filters, sorting, and pagination.
 * Falls back to local cache when Supabase is unavailable.
 * @returns {{ rows: Array, totalCount: number }}
 */
export async function queryTable(userId, tableName, {
  filters = {},
  sort = null,
  limit = 50,
  offset = 0,
} = {}) {
  const config = TABLE_REGISTRY[tableName];
  if (!config) throw new Error(`Unknown table: ${tableName}`);

  const queryOpts = { filters, sort, limit, offset };

  // Return local cache immediately if available (avoids 8s Supabase timeout)
  if (_localCache[tableName]?.length > 0) {
    return queryLocalCache(tableName, queryOpts);
  }

  try {
    const { column: sortCol, ascending: sortAsc } = sort || config.defaultSort;

    // Build query
    let query = supabase
      .from(config.table)
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    // Apply filters
    for (const filterDef of config.filterFields) {
      const value = filters[filterDef.key];
      if (value == null || value === '') continue;
      if (filterDef.type === 'ilike') {
        query = query.ilike(filterDef.key, `%${value}%`);
      } else {
        query = query.eq(filterDef.key, value);
      }
    }

    query = query
      .order(sortCol, { ascending: sortAsc })
      .range(offset, offset + limit - 1);

    const result = await Promise.race([
      query,
      new Promise((_, reject) => setTimeout(() => reject(new Error('queryTable timeout')), 8000))
    ]);

    const { data, error, count } = result;
    if (error) throw error;

    return { rows: data || [], totalCount: count || 0 };
  } catch {
    return { rows: [], totalCount: 0 };
  }
}

/**
 * Get row count for a table with optional filters.
 */
export async function getTableCount(userId, tableName, filters = {}) {
  const config = TABLE_REGISTRY[tableName];
  if (!config) throw new Error(`Unknown table: ${tableName}`);

  // Return local cache count immediately if available
  if (_localCache[tableName]?.length > 0) {
    const localResult = queryLocalCache(tableName, { filters, limit: 999999 });
    return localResult.totalCount;
  }

  try {
    let query = supabase
      .from(config.table)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    for (const filterDef of config.filterFields) {
      const value = filters[filterDef.key];
      if (value == null || value === '') continue;
      if (filterDef.type === 'ilike') {
        query = query.ilike(filterDef.key, `%${value}%`);
      } else {
        query = query.eq(filterDef.key, value);
      }
    }

    const result = await Promise.race([
      query,
      new Promise((_, reject) => setTimeout(() => reject(new Error('getTableCount timeout')), 8000))
    ]);

    const { count, error } = result;
    if (error) throw error;
    return count || 0;
  } catch {
    return 0;
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * Update a single field on a record with audit trail.
 * @returns {Object} The updated row
 */
export async function updateField(userId, tableName, recordId, fieldName, newValue) {
  const config = TABLE_REGISTRY[tableName];
  if (!config) throw new Error(`Unknown table: ${tableName}`);
  if (!config.editableFields[fieldName]) {
    throw new Error(`Field "${fieldName}" is not editable on table "${tableName}"`);
  }

  // 1. Read current value for audit trail
  const { data: current, error: readError } = await supabase
    .from(config.table)
    .select(fieldName)
    .eq(config.idField, recordId)
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) throw readError;
  if (!current) throw new Error(`Record ${recordId} not found in ${tableName}`);

  const oldValue = current[fieldName];

  // 2. Update the field
  const { data: updated, error: updateError } = await supabase
    .from(config.table)
    .update({ [fieldName]: newValue })
    .eq(config.idField, recordId)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (updateError) throw updateError;

  // 3. Record audit trail (fire-and-forget)
  recordFieldEdit({
    userId,
    tableName: config.table,
    recordId: String(recordId),
    fieldName,
    oldValue,
    newValue,
  }).catch((err) => {
    console.warn('[liveDataQueryService] Audit trail failed (non-fatal):', err.message);
  });

  return updated;
}

/**
 * Get all available table keys from the registry.
 */
export function getAvailableTables() {
  return Object.entries(TABLE_REGISTRY).map(([key, config]) => ({
    key,
    label: config.label,
  }));
}
