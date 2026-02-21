/**
 * exportWorkbook.js
 * Builds a multi-sheet Excel (.xlsx) workbook from CanvasPanel data.
 *
 * ─── How to add a new chart or table ────────────────────────────────────────
 * 1. Chart: add an entry in buildChartRegistry() below.  Each entry needs:
 *      { chart_id, title, rows }  where `rows` is an array of plain objects.
 *    The helper will create a "Chart_Data_<chart_id>" sheet automatically.
 *
 * 2. Table from a downloads artifact: in exportWorkbook(), find the artifact
 *    with findDownload(), parse its content (CSV → parseCsvContent, JSON → use
 *    directly), then call appendJsonSheet(wb, 'My_Sheet_Name', rows).
 *    Place the call inside the appropriate section (Plan_Output, Risk_Output …).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as XLSX from 'xlsx';

// ── Helpers ──────────────────────────────────────────────────────────────────

const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : '');

const safePct = (v) =>
  Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : '';

/** Append a sheet from an array of row-objects. No-op if rows is empty. */
function appendJsonSheet(wb, sheetName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

/** Append a sheet from [[key, value], …] pairs. */
function appendKVSheet(wb, sheetName, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return;
  const ws = XLSX.utils.aoa_to_sheet([['Key', 'Value'], ...pairs]);
  ws['!cols'] = [{ wch: 28 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

/** Append a narrative/text sheet – one line per row in column A. */
function appendNarrativeSheet(wb, sheetName, text) {
  if (!text) return;
  const lines = String(text)
    .split('\n')
    .map((line) => [line]);
  const ws = XLSX.utils.aoa_to_sheet([['Report Narrative'], ...lines]);
  ws['!cols'] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

/** Parse a CSV string to an array of row objects via SheetJS. */
function parseCsvContent(csvString) {
  if (!csvString || typeof csvString !== 'string') return [];
  try {
    const tempWb = XLSX.read(csvString, { type: 'string' });
    const ws = tempWb.Sheets[tempWb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws);
  } catch {
    return [];
  }
}

/**
 * Find the first download artifact whose label or fileName contains any of
 * the provided hint substrings (case-insensitive).
 */
function findDownload(downloads, ...hints) {
  return downloads.find((d) =>
    hints.some((hint) =>
      String(d.label || d.fileName || '')
        .toLowerCase()
        .includes(hint.toLowerCase())
    )
  );
}

// ── Chart Registry ───────────────────────────────────────────────────────────

/**
 * buildChartRegistry()
 * Returns one entry per chart that should appear as a Chart_Data_* sheet.
 *
 * To register a new chart, add an entry here:
 *   { chart_id: 'my_chart', title: 'My Chart', rows: [...] }
 *
 * `chart_id` becomes the sheet name suffix: Chart_Data_<chart_id>.
 * Sheet names are capped at 31 characters by Excel.
 */
function buildChartRegistry(chartPayload) {
  const charts = [];

  // ── Actual vs Forecast ────────────────────────────────────────────────────
  const forecastRows = chartPayload.actual_vs_forecast || [];
  if (forecastRows.length > 0) {
    charts.push({
      chart_id: 'Forecast',
      title: 'Actual vs Forecast',
      rows: forecastRows
    });
  }

  // ── Inventory Projection ──────────────────────────────────────────────────
  const invProj = chartPayload.inventory_projection || [];
  if (invProj.length > 0) {
    const rows = invProj.map((row, i) => {
      // row may be a plain object or a bare number (from SimpleLineChart mapping)
      if (row !== null && typeof row === 'object') {
        return {
          Period: row.period ?? row.date ?? i,
          With_Plan: safeNum(row.with_plan),
          Without_Plan: safeNum(row.without_plan)
        };
      }
      return { Period: i, With_Plan: safeNum(row) };
    });
    charts.push({
      chart_id: 'InventoryProj',
      title: 'Inventory Projection',
      rows
    });
  }

  // ── Cost Breakdown ────────────────────────────────────────────────────────
  const costBd = chartPayload.cost_breakdown || [];
  if (costBd.length > 0) {
    const rows = costBd.map((row) => ({
      Label: row.label ?? '',
      Value: safeNum(row.value)
    }));
    charts.push({
      chart_id: 'CostBreakdown',
      title: 'Cost Breakdown',
      rows
    });
  }

  return charts;
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummaryPairs(runMeta, downloads) {
  const pairs = [];

  if (runMeta.run_id) pairs.push(['Run ID', String(runMeta.run_id)]);
  if (runMeta.status) pairs.push(['Status', String(runMeta.status)]);
  if (runMeta.workflow) pairs.push(['Workflow', String(runMeta.workflow)]);
  pairs.push(['Exported At', new Date().toISOString()]);

  // KPIs from replay_metrics artifact
  const replayDownload = findDownload(downloads, 'replay_metrics');
  const replayContent = replayDownload?.content;
  if (replayContent && typeof replayContent === 'object') {
    const withPlan = replayContent.with_plan || {};
    if (Object.keys(withPlan).length > 0) {
      pairs.push(['---', '--- Plan KPIs (With Plan) ---']);
      if (withPlan.service_level !== undefined)
        pairs.push(['Service Level', safePct(withPlan.service_level)]);
      if (withPlan.stockout_units !== undefined)
        pairs.push(['Stockout Units', safeNum(withPlan.stockout_units)]);
      if (withPlan.holding_units !== undefined)
        pairs.push(['Holding Units', safeNum(withPlan.holding_units)]);
      if (withPlan.total_order_qty !== undefined)
        pairs.push(['Total Order Qty', safeNum(withPlan.total_order_qty)]);
      if (withPlan.total_cost !== undefined)
        pairs.push(['Total Cost', safeNum(withPlan.total_cost)]);
    }
  }

  return pairs;
}

// ── Main export function ──────────────────────────────────────────────────────

/**
 * exportWorkbook({ chartPayload, downloads, runMeta })
 *
 * Builds and returns an xlsx workbook as a Uint8Array.
 *
 * @param {Object} opts
 * @param {Object} [opts.chartPayload]  – CanvasPanel chartPayload prop
 * @param {Array}  [opts.downloads]     – CanvasPanel downloads prop
 * @param {Object} [opts.runMeta]       – { run_id, status, workflow }
 * @returns {Uint8Array}
 */
export function exportWorkbook({
  chartPayload = {},
  downloads = [],
  runMeta = {}
} = {}) {
  const wb = XLSX.utils.book_new();
  const notes = []; // degradation notes accumulate here

  // ── 1. Summary ─────────────────────────────────────────────────────────────
  const summaryPairs = buildSummaryPairs(runMeta, downloads);
  if (summaryPairs.length > 0) {
    appendKVSheet(wb, 'Summary', summaryPairs);
  }

  // ── 2. Report (AI narrative) ───────────────────────────────────────────────
  // Try report.json / run_report.json; prefer final_report.summary, then summary.
  const reportDownload =
    findDownload(downloads, 'report.json', 'run_report') || null;
  const reportContent = reportDownload?.content;
  const narrativeText =
    (typeof reportContent === 'object' && reportContent !== null
      ? reportContent?.final_report?.summary ||
        reportContent?.summary ||
        reportContent?.summary_text ||
        ''
      : '') || '';

  if (narrativeText) {
    appendNarrativeSheet(wb, 'Report', narrativeText);
  } else {
    notes.push('Report narrative unavailable; no report artifact found.');
  }

  // ── 3. Inputs (contract / settings / validation snapshot) ─────────────────
  if (reportContent && typeof reportContent === 'object') {
    const inputPairs = [];
    const { validation, solver_used: solverUsed, evidence_pack: evidencePack } =
      reportContent;

    if (solverUsed) inputPairs.push(['Solver Used', String(solverUsed)]);
    if (validation?.status) inputPairs.push(['Validation Status', String(validation.status)]);
    if (validation?.notes) inputPairs.push(['Validation Notes', String(validation.notes)]);

    if (evidencePack && typeof evidencePack === 'object') {
      Object.entries(evidencePack).forEach(([k, v]) => {
        if (typeof v === 'string' || typeof v === 'number') {
          inputPairs.push([k, v]);
        }
      });
    }

    if (inputPairs.length > 0) {
      appendKVSheet(wb, 'Inputs', inputPairs);
    }
  }

  // ── 4. Forecast_Data ───────────────────────────────────────────────────────
  const forecastRows = chartPayload.actual_vs_forecast || [];
  if (forecastRows.length > 0) {
    appendJsonSheet(wb, 'Forecast_Data', forecastRows);
  } else {
    notes.push('Forecast data unavailable.');
  }

  // ── 5. Plan_Output ─────────────────────────────────────────────────────────
  // Look for the plan CSV artifact first (most complete), then plan_table JSON.
  const planCsvDownload = findDownload(downloads, 'plan.csv', 'plan_run_');
  let planRows = [];
  if (typeof planCsvDownload?.content === 'string') {
    planRows = parseCsvContent(planCsvDownload.content);
  }
  if (planRows.length > 0) {
    appendJsonSheet(wb, 'Plan_Output', planRows);
  } else {
    notes.push('Plan output unavailable; no plan artifact found.');
  }

  // ── 6. Risk_Output ─────────────────────────────────────────────────────────
  const riskCsvDownload = findDownload(downloads, 'risk_plan.csv', 'risk_plan_run_');
  if (typeof riskCsvDownload?.content === 'string') {
    const riskRows = parseCsvContent(riskCsvDownload.content);
    if (riskRows.length > 0) {
      appendJsonSheet(wb, 'Risk_Output', riskRows);
    }
  }

  // ── 7. WhatIf_Compare ──────────────────────────────────────────────────────
  // Drawn from chartPayload.plan_comparison (set by risk-aware planning).
  const comparison = chartPayload.plan_comparison;
  if (comparison?.kpis) {
    const { base = {}, risk = {}, delta = {} } = comparison.kpis;
    const allKeys = [
      ...new Set([
        ...Object.keys(base),
        ...Object.keys(risk),
        ...Object.keys(delta)
      ])
    ];
    const compRows = allKeys.map((key) => ({
      Metric: key,
      Base: base[key] ?? '',
      'Risk-Aware': risk[key] ?? '',
      Delta: delta[key] ?? ''
    }));
    if (compRows.length > 0) {
      appendJsonSheet(wb, 'WhatIf_Compare', compRows);
    }
  }

  // ── 8. Chart_Data_* sheets ─────────────────────────────────────────────────
  const chartRegistry = buildChartRegistry(chartPayload);
  for (const chart of chartRegistry) {
    const sheetName = `Chart_Data_${chart.chart_id}`.slice(0, 31);
    appendJsonSheet(wb, sheetName, chart.rows);
  }

  // ── 9. Export_Notes (degradation report) ──────────────────────────────────
  if (notes.length > 0) {
    const noteRows = notes.map((n) => [n]);
    const ws = XLSX.utils.aoa_to_sheet([['Export Note'], ...noteRows]);
    ws['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Export_Notes');
  }

  // Guard: ensure workbook has at least one sheet (Excel rejects empty books).
  if (wb.SheetNames.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([['No data available for export.']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Empty');
  }

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}
