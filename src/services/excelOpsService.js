// @product: ai-employee
//
// excelOpsService.js
// ─────────────────────────────────────────────────────────────────────────────
// Excel Ops Command Queue — pushes typed Excel operations to the
// `excel_ops_queue` table for consumption by the Office.js Add-in.
//
// The AI Employee agent calls these functions after generating artifacts.
// The Excel Add-in polls for pending ops and executes them via Excel.run().
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../lib/supabaseClient';

// ── Operation types ──────────────────────────────────────────────────────────

export const OPS = {
  BATCH_START:       'batch_start',
  BATCH_END:         'batch_end',
  CREATE_SHEET:      'create_sheet',
  DELETE_SHEET:      'delete_sheet',
  RENAME_SHEET:      'rename_sheet',
  WRITE_VALUES:      'write_values',
  WRITE_FORMULA:     'write_formula',
  WRITE_FORMULAS:    'write_formulas',
  FORMAT_CELLS:      'format_cells',
  CREATE_TABLE:      'create_table',
  CREATE_CHART:      'create_chart',
  AUTOFIT_COLUMNS:   'autofit_columns',
  AUTOFIT_ROWS:      'autofit_rows',
  MERGE_CELLS:       'merge_cells',
  CONDITIONAL_FORMAT:'conditional_format',
  FREEZE_PANES:      'freeze_panes',
  SET_COLUMN_WIDTH:  'set_column_width',
  ADD_COMMENT:       'add_comment',
  SORT_RANGE:        'sort_range',
  KPI_DASHBOARD:     'kpi_dashboard',
};

// ── Push ops to Supabase ─────────────────────────────────────────────────────

/**
 * Push a batch of Excel operation commands to the queue.
 *
 * @param {string} taskId  - AI Employee task ID
 * @param {string} userId  - Authenticated user ID
 * @param {object[]} ops   - Array of operation objects from builder helpers
 * @returns {Promise<{ batch_id: string, count: number }>}
 */
export async function pushExcelOps(taskId, userId, ops) {
  if (!ops?.length) return { batch_id: null, count: 0 };

  const batchId = ops[0]?.batch_id || `batch_${Date.now()}`;

  const rows = ops.map((op, i) => ({
    task_id: taskId,
    batch_id: batchId,
    sequence: op.sequence ?? i,
    op: op.op,
    target_sheet: op.target_sheet || null,
    range_addr: op.range_addr || null,
    payload: op.payload || {},
    status: 'pending',
    user_id: userId,
  }));

  const { error } = await supabase
    .from('excel_ops_queue')
    .insert(rows);

  if (error) {
    console.error('[excelOpsService] pushExcelOps failed:', error.message);
    throw new Error(`Failed to push Excel ops: ${error.message}`);
  }

  return { batch_id: batchId, count: rows.length };
}

// ── Builder helpers ──────────────────────────────────────────────────────────
// Pure functions that return operation objects. No side effects.

let _seq = 0;

export function resetSequence() { _seq = 0; }

export function batchStart(batchId, summary) {
  return { batch_id: batchId, op: OPS.BATCH_START, sequence: _seq++, payload: { summary } };
}

export function batchEnd(batchId, summary) {
  return { batch_id: batchId, op: OPS.BATCH_END, sequence: _seq++, payload: { summary } };
}

export function createSheet(batchId, name, opts = {}) {
  return {
    batch_id: batchId, op: OPS.CREATE_SHEET, sequence: _seq++,
    target_sheet: name,
    payload: { activate: opts.activate ?? false },
  };
}

export function writeValues(batchId, sheetName, rangeAddr, values) {
  return {
    batch_id: batchId, op: OPS.WRITE_VALUES, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: { values },
  };
}

export function writeFormula(batchId, sheetName, cellAddr, formula) {
  return {
    batch_id: batchId, op: OPS.WRITE_FORMULA, sequence: _seq++,
    target_sheet: sheetName, range_addr: cellAddr,
    payload: { formula },
  };
}

export function writeFormulas(batchId, sheetName, rangeAddr, formulas) {
  return {
    batch_id: batchId, op: OPS.WRITE_FORMULAS, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: { formulas },
  };
}

export function formatCells(batchId, sheetName, rangeAddr, format) {
  return {
    batch_id: batchId, op: OPS.FORMAT_CELLS, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: format,
  };
}

export function createTable(batchId, sheetName, rangeAddr, tableName, opts = {}) {
  return {
    batch_id: batchId, op: OPS.CREATE_TABLE, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: { tableName, hasHeaders: true, style: opts.style || 'TableStyleMedium2' },
  };
}

export function createChart(batchId, sheetName, dataRange, chartTitle, opts = {}) {
  return {
    batch_id: batchId, op: OPS.CREATE_CHART, sequence: _seq++,
    target_sheet: sheetName, range_addr: dataRange,
    payload: {
      chartType: opts.chartType || 'columnClustered',
      title: chartTitle,
      width: opts.width || 600,
      height: opts.height || 350,
      position: opts.position || null,
    },
  };
}

export function autofitColumns(batchId, sheetName, rangeAddr) {
  return {
    batch_id: batchId, op: OPS.AUTOFIT_COLUMNS, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
  };
}

export function autofitRows(batchId, sheetName, rangeAddr) {
  return {
    batch_id: batchId, op: OPS.AUTOFIT_ROWS, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
  };
}

export function mergeCells(batchId, sheetName, rangeAddr) {
  return {
    batch_id: batchId, op: OPS.MERGE_CELLS, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
  };
}

export function conditionalFormat(batchId, sheetName, rangeAddr, type, opts = {}) {
  return {
    batch_id: batchId, op: OPS.CONDITIONAL_FORMAT, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: { type, ...opts },
  };
}

export function freezePanes(batchId, sheetName, rows, cols) {
  return {
    batch_id: batchId, op: OPS.FREEZE_PANES, sequence: _seq++,
    target_sheet: sheetName,
    payload: { rows: rows || 1, cols: cols || 0 },
  };
}

export function setColumnWidth(batchId, sheetName, rangeAddr, width) {
  return {
    batch_id: batchId, op: OPS.SET_COLUMN_WIDTH, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: { width },
  };
}

export function addComment(batchId, sheetName, cellAddr, text) {
  return {
    batch_id: batchId, op: OPS.ADD_COMMENT, sequence: _seq++,
    target_sheet: sheetName, range_addr: cellAddr,
    payload: { text },
  };
}

export function sortRange(batchId, sheetName, rangeAddr, colIndex, ascending = false) {
  return {
    batch_id: batchId, op: OPS.SORT_RANGE, sequence: _seq++,
    target_sheet: sheetName, range_addr: rangeAddr,
    payload: { colIndex, ascending },
  };
}

export function kpiDashboard(batchId, sheetName, kpis) {
  return {
    batch_id: batchId, op: OPS.KPI_DASHBOARD, sequence: _seq++,
    target_sheet: sheetName,
    payload: { kpis },
  };
}

// ── Composite: write a 2D array as table with formatting ─────────────────────

/**
 * Generate ops to write tabular data to a sheet with full formatting:
 * create sheet → write values → create table → autofit → conditional format
 */
export function writeTableOps(batchId, sheetName, headers, dataRows, opts = {}) {
  const ops = [];
  const totalRows = dataRows.length + 1;
  const maxCols = headers.length;
  const rangeAddr = `A1:${_colLetter(maxCols - 1)}${totalRows}`;

  // Build 2D values array
  const values = [headers, ...dataRows];

  ops.push(createSheet(batchId, sheetName));
  ops.push(writeValues(batchId, sheetName, rangeAddr, values));

  // Create native Excel Table
  const tableName = `T_${sheetName}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
  ops.push(createTable(batchId, sheetName, rangeAddr, tableName, { style: opts.tableStyle }));

  // Freeze header row
  ops.push(freezePanes(batchId, sheetName, 1, 0));

  // Autofit
  ops.push(autofitColumns(batchId, sheetName, rangeAddr));

  // Smart conditional formatting on key columns
  for (let c = 0; c < headers.length; c++) {
    const h = (headers[c] || '').toLowerCase();
    if (h.includes('score') || h.includes('risk') || h.includes('rate') ||
        h.includes('ratio') || h.includes('margin') || h.includes('percent')) {
      const colRange = `${_colLetter(c)}2:${_colLetter(c)}${totalRows}`;
      ops.push(conditionalFormat(batchId, sheetName, colRange, 'color_scale'));
    } else if (h.includes('revenue') || h.includes('sales') || h.includes('profit') ||
               h.includes('amount') || h.includes('cost')) {
      const colRange = `${_colLetter(c)}2:${_colLetter(c)}${totalRows}`;
      ops.push(conditionalFormat(batchId, sheetName, colRange, 'data_bar'));
    }
  }

  // Smart number formatting
  for (let c = 0; c < headers.length; c++) {
    const h = (headers[c] || '').toLowerCase();
    let fmt = null;
    if (h.includes('revenue') || h.includes('cost') || h.includes('price') ||
        h.includes('amount') || h.includes('profit') || h.includes('budget') ||
        h.includes('sales') || h.includes('asp') || h.includes('margin_value') ||
        h.includes('營收') || h.includes('金額') || h.includes('成本')) {
      fmt = '#,##0.00';
    } else if (h.includes('rate') || h.includes('ratio') || h.includes('margin') ||
               h.includes('percent') || h.includes('%') || h.includes('比率')) {
      fmt = '0.0%';
    } else if (h.includes('count') || h.includes('qty') || h.includes('units') ||
               h.includes('quantity') || h.includes('數量')) {
      fmt = '#,##0';
    } else if (h.includes('date') || h.includes('日期') || h.includes('month')) {
      fmt = 'yyyy-mm-dd';
    }
    if (fmt) {
      const colRange = `${_colLetter(c)}2:${_colLetter(c)}${totalRows}`;
      ops.push(formatCells(batchId, sheetName, colRange, { numberFormat: fmt }));
    }
  }

  // Optional chart
  if (opts.chart && dataRows.length >= 3 && maxCols >= 2) {
    ops.push(createChart(batchId, sheetName, rangeAddr, opts.chartTitle || sheetName, {
      chartType: opts.chartType || 'columnClustered',
    }));
  }

  return ops;
}

// ── Convert artifacts to Excel ops ───────────────────────────────────────────

/**
 * Translate a completed agent loop step's artifacts into Excel operations.
 * Called by the agent loop after step completion (best-effort).
 *
 * @param {string}   taskId
 * @param {string}   userId
 * @param {object}   step       - Step definition from loop_state
 * @param {object}   result     - Execution result from aiEmployeeExecutor
 * @returns {Promise<{ batch_id: string, count: number }|null>}
 */
export async function generateExcelOpsForStep(taskId, userId, step, result) {
  const batchId = `step_${step.name}_${Date.now()}`;
  resetSequence();

  const ops = [];
  ops.push(batchStart(batchId, `Building sheet for step: ${step.name}`));

  const artifactRefs = result?.run?.artifact_refs || result?.artifact_refs || [];

  for (const ref of artifactRefs) {
    const data = ref.data || ref.content;
    if (!data) continue;

    const artType = (ref.type || '').toLowerCase();
    const label = ref.label || ref.type || step.name;
    const sheetName = label.replace(/[\\\/\*\?\[\]:]/g, '_').slice(0, 31);

    // KPI / metrics → dashboard layout
    if (artType.includes('kpi') || artType === 'metrics' || artType.includes('summary')) {
      if (typeof data === 'object' && !Array.isArray(data)) {
        ops.push(createSheet(batchId, sheetName));
        ops.push(kpiDashboard(batchId, sheetName, data));
      }
      continue;
    }

    // Tabular data → table with formatting + chart
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
      const headers = Object.keys(data[0]);
      const rows = data.map(row => headers.map(h => {
        const v = row[h];
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      }));
      const tableOps = writeTableOps(batchId, sheetName, headers, rows, {
        chart: data.length >= 3 && data.length <= 50 && headers.length <= 8,
        chartTitle: label,
      });
      ops.push(...tableOps);
      continue;
    }

    // Key-value object → simple table
    if (typeof data === 'object' && !Array.isArray(data)) {
      const kvHeaders = ['Metric', 'Value'];
      const kvRows = Object.entries(data)
        .filter(([k]) => !['pdf_base64', 'html', 'image_base64'].includes(k))
        .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]);
      if (kvRows.length > 0) {
        const kvOps = writeTableOps(batchId, sheetName, kvHeaders, kvRows);
        ops.push(...kvOps);
      }
    }
  }

  ops.push(batchEnd(batchId, `Step "${step.name}" written to Excel.`));

  if (ops.length <= 2) return null; // Only batch_start + batch_end = nothing useful

  return pushExcelOps(taskId, userId, ops);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _colLetter(idx) {
  let s = '';
  let i = idx;
  while (i >= 0) {
    s = String.fromCharCode((i % 26) + 65) + s;
    i = Math.floor(i / 26) - 1;
  }
  return s;
}

export default {
  OPS,
  pushExcelOps,
  generateExcelOpsForStep,
  resetSequence,
  batchStart,
  batchEnd,
  createSheet,
  writeValues,
  writeFormula,
  writeFormulas,
  formatCells,
  createTable,
  createChart,
  autofitColumns,
  autofitRows,
  mergeCells,
  conditionalFormat,
  freezePanes,
  setColumnWidth,
  addComment,
  sortRange,
  kpiDashboard,
  writeTableOps,
};
