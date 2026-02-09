/**
 * Data Auto-Fill Utility
 * 自動補齊最常見的資料缺漏，避免因小問題導致整批失敗
 */

/**
 * Auto-fill common missing fields for a row based on uploadType
 * @param {object} row - Single data row
 * @param {string} uploadType - Upload type
 * @returns {object} Row with auto-filled fields
 */
export function autoFillRow(row, uploadType) {
  if (!row || !uploadType) return row;

  const filled = { ...row };

  // 共通欄位：UOM (單位)
  if (!filled.uom || filled.uom === '') {
    filled.uom = 'pcs';
  }

  // 依 uploadType 處理
  switch (uploadType) {
    case 'bom_edge':
      return autoFillBomEdge(filled);
    case 'demand_fg':
      return autoFillDemandFg(filled);
    case 'po_open_lines':
      return autoFillPoOpenLines(filled);
    case 'inventory_snapshots':
      return autoFillInventorySnapshots(filled);
    case 'fg_financials':
      return autoFillFgFinancials(filled);
    case 'supplier_master':
      return autoFillSupplierMaster(filled);
    default:
      return filled;
  }
}

/**
 * Auto-fill for BOM Edge
 */
function autoFillBomEdge(row) {
  // qty_per 必填，但如果是 null/"" 可嘗試預設為 1
  if (!row.qty_per || row.qty_per === '' || isNaN(row.qty_per)) {
    row.qty_per = 1;
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push('qty_per=1');
  }

  // scrap_rate / yield_rate 預設
  if (row.scrap_rate === null || row.scrap_rate === undefined || row.scrap_rate === '') {
    row.scrap_rate = null;  // 允許 null
  }
  if (row.yield_rate === null || row.yield_rate === undefined || row.yield_rate === '') {
    row.yield_rate = null;  // 允許 null
  }

  return row;
}

/**
 * Auto-fill for Demand FG
 */
function autoFillDemandFg(row) {
  // demand_qty 必填，但如果是 null/"" 可嘗試預設為 0
  if (!row.demand_qty || row.demand_qty === '' || isNaN(row.demand_qty)) {
    row.demand_qty = 0;
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push('demand_qty=0');
  }

  // time_bucket 必填，若缺失但有 week_bucket 或 date 可補
  if (!row.time_bucket || row.time_bucket === '') {
    if (row.week_bucket) {
      row.time_bucket = row.week_bucket;
      row._autoFilled = row._autoFilled || [];
      row._autoFilled.push('time_bucket=week_bucket');
    } else if (row.date) {
      row.time_bucket = row.date;
      row._autoFilled = row._autoFilled || [];
      row._autoFilled.push('time_bucket=date');
    }
  }

  // status 預設
  if (!row.status || row.status === '') {
    row.status = 'confirmed';
  }

  return row;
}

/**
 * Auto-fill for PO Open Lines
 */
function autoFillPoOpenLines(row) {
  // open_qty 必填
  if (!row.open_qty || row.open_qty === '' || isNaN(row.open_qty)) {
    row.open_qty = 0;
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push('open_qty=0');
  }

  // status 預設
  if (!row.status || row.status === '') {
    row.status = 'open';
  }

  // po_line 預設（如果缺失）
  if (!row.po_line || row.po_line === '') {
    row.po_line = '10';
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push('po_line=10');
  }

  return row;
}

/**
 * Auto-fill for Inventory Snapshots
 */
function autoFillInventorySnapshots(row) {
  // onhand_qty 必填
  if (!row.onhand_qty || row.onhand_qty === '' || isNaN(row.onhand_qty)) {
    row.onhand_qty = 0;
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push('onhand_qty=0');
  }

  // allocated_qty / safety_stock / shortage_qty 預設為 0
  if (row.allocated_qty === null || row.allocated_qty === undefined || row.allocated_qty === '' || isNaN(row.allocated_qty)) {
    row.allocated_qty = 0;
  }
  if (row.safety_stock === null || row.safety_stock === undefined || row.safety_stock === '' || isNaN(row.safety_stock)) {
    row.safety_stock = 0;
  }
  if (row.shortage_qty === null || row.shortage_qty === undefined || row.shortage_qty === '' || isNaN(row.shortage_qty)) {
    row.shortage_qty = 0;
  }

  // snapshot_date 必填，若缺失可用今天
  if (!row.snapshot_date || row.snapshot_date === '') {
    const today = new Date().toISOString().split('T')[0];
    row.snapshot_date = today;
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push(`snapshot_date=${today}`);
  }

  return row;
}

/**
 * Auto-fill for FG Financials
 */
function autoFillFgFinancials(row) {
  // unit_margin 必填
  if (!row.unit_margin || row.unit_margin === '' || isNaN(row.unit_margin)) {
    row.unit_margin = 0;
    row._autoFilled = row._autoFilled || [];
    row._autoFilled.push('unit_margin=0');
  }

  // unit_price 可選，但如果是 "" 應改為 null
  if (row.unit_price === '') {
    row.unit_price = null;
  }

  // currency 預設
  if (!row.currency || row.currency === '') {
    row.currency = 'USD';
  }

  return row;
}

/**
 * Auto-fill for Supplier Master
 */
function autoFillSupplierMaster(row) {
  // supplier_code 可選，如果缺失可用 supplier_name
  if (!row.supplier_code || row.supplier_code === '') {
    row.supplier_code = row.supplier_name || 'UNKNOWN';
  }

  // status 必須合法化（已有 normalizeSupplierStatus 會處理）
  // 這裡只確保不是空字串
  if (!row.status || row.status === '') {
    row.status = 'active';
  }

  return row;
}

/**
 * Auto-fill multiple rows
 * @param {object[]} rows - Array of data rows
 * @param {string} uploadType - Upload type
 * @returns {object} { rows: filled rows, autoFillCount: number, autoFillSummary: string[] }
 */
export function autoFillRows(rows, uploadType) {
  if (!rows || rows.length === 0) {
    return { rows: [], autoFillCount: 0, autoFillSummary: [] };
  }

  const filled = rows.map(row => autoFillRow(row, uploadType));
  
  // 統計自動補齊次數
  const autoFilledRows = filled.filter(row => row._autoFilled && row._autoFilled.length > 0);
  const autoFillCount = autoFilledRows.length;
  
  // 統計哪些欄位被自動補齊
  const fieldCounts = {};
  autoFilledRows.forEach(row => {
    row._autoFilled.forEach(field => {
      fieldCounts[field] = (fieldCounts[field] || 0) + 1;
    });
  });
  
  const autoFillSummary = Object.entries(fieldCounts)
    .map(([field, count]) => `${field} (${count} rows)`)
    .sort((a, b) => {
      const countA = parseInt(a.match(/\((\d+) rows\)/)[1]);
      const countB = parseInt(b.match(/\((\d+) rows\)/)[1]);
      return countB - countA;
    });

  // 移除 _autoFilled 標記（不寫入 DB）
  filled.forEach(row => {
    delete row._autoFilled;
  });

  return {
    rows: filled,
    autoFillCount,
    autoFillSummary
  };
}

/**
 * Validate critical required fields (after auto-fill)
 * @param {object[]} rows - Array of data rows
 * @param {string} uploadType - Upload type
 * @returns {object} { isValid: boolean, missingFields: string[], invalidRows: object[] }
 */
export function validateRequiredFields(rows, uploadType) {
  const requiredFields = {
    bom_edge: ['parent_material', 'child_material', 'qty_per'],
    demand_fg: ['material_code', 'plant_id', 'time_bucket', 'demand_qty'],
    po_open_lines: ['po_number', 'po_line', 'material_code', 'plant_id', 'time_bucket', 'open_qty'],
    inventory_snapshots: ['material_code', 'plant_id', 'snapshot_date', 'onhand_qty'],
    fg_financials: ['material_code', 'unit_margin'],
    supplier_master: ['supplier_name']
  };

  const required = requiredFields[uploadType] || [];
  const invalidRows = [];

  rows.forEach((row, idx) => {
    const missing = [];
    required.forEach(field => {
      if (row[field] === null || row[field] === undefined || row[field] === '') {
        missing.push(field);
      }
    });

    if (missing.length > 0) {
      invalidRows.push({
        rowIndex: idx + 1,
        missingFields: missing,
        rowData: {
          material_code: row.material_code,
          po_number: row.po_number,
          supplier_name: row.supplier_name
        }
      });
    }
  });

  return {
    isValid: invalidRows.length === 0,
    missingFields: [...new Set(invalidRows.flatMap(r => r.missingFields))],
    invalidRows: invalidRows.slice(0, 10)  // 最多回傳前 10 筆
  };
}
