// ─────────────────────────────────────────────────────────────────────────────
// Excel Ops Executor — runs in the Office.js Add-in context
//
// Receives typed operation commands from the excel_ops_queue (via report-api)
// and executes them via Excel.run() + Office.js API.
//
// This is the "hands" of the AI Employee — it operates Excel like a real person.
//
// NOTE: This file is loaded as a standalone module in the add-in. All Office.js
// execution is done inline in taskpane.js _dispatchAutoModeOp() for simplicity.
// This file serves as reference documentation for the operation type contract.
// ─────────────────────────────────────────────────────────────────────────────

/* global Excel */

/**
 * Supported operation types and their payload shapes:
 *
 * batch_start    { summary: string }
 * batch_end      { summary: string }
 * create_sheet   { activate?: boolean }                     target_sheet required
 * delete_sheet   {}                                          target_sheet required
 * rename_sheet   { from: string, to: string }
 * write_values   { values: any[][] }                         target_sheet + range_addr
 * write_formula  { formula: string }                         target_sheet + range_addr (cell)
 * write_formulas { formulas: string[][] }                    target_sheet + range_addr
 * format_cells   { font?, fill?, alignment?, numberFormat?, border? }
 * create_table   { tableName, hasHeaders?, style? }          target_sheet + range_addr
 * create_chart   { chartType, title, width?, height? }       target_sheet + range_addr (data)
 * autofit_columns {}                                         target_sheet + range_addr
 * autofit_rows   {}                                          target_sheet + range_addr
 * merge_cells    {}                                          target_sheet + range_addr
 * conditional_format { type: 'color_scale'|'data_bar'|'icon_set' }
 * freeze_panes   { rows?: number, cols?: number }            target_sheet
 * set_column_width { width: number }                         target_sheet + range_addr
 * sort_range     { colIndex: number, ascending?: boolean }   target_sheet + range_addr
 * kpi_dashboard  { kpis: Record<string, any> }               target_sheet
 * add_comment    { text: string }                             target_sheet + range_addr (cell)
 */

// The actual execution logic lives in taskpane.js _dispatchAutoModeOp()
// to avoid module loading issues in the Office.js sandbox.

export const SUPPORTED_OPS = [
  'batch_start', 'batch_end',
  'create_sheet', 'delete_sheet', 'rename_sheet',
  'write_values', 'write_formula', 'write_formulas',
  'format_cells', 'create_table', 'create_chart',
  'autofit_columns', 'autofit_rows', 'merge_cells',
  'conditional_format', 'freeze_panes', 'set_column_width',
  'sort_range', 'kpi_dashboard', 'add_comment',
];

export default { SUPPORTED_OPS };
