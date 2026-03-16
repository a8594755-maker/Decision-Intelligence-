// @product: ai-employee
//
// excelOpsTemplates.js
// ─────────────────────────────────────────────────────────────────────────────
// Pre-built Excel operation sequences for common report types.
// Each template generates an array of ops consumed by excelOpsService.pushExcelOps().
//
// Templates are pure functions — no side effects, no DB calls.
// ─────────────────────────────────────────────────────────────────────────────

import {
  resetSequence,
  batchStart,
  batchEnd,
  createSheet,
  writeValues,
  writeFormula,
  formatCells,
  createTable,
  createChart,
  autofitColumns,
  mergeCells,
  conditionalFormat,
  freezePanes,
  kpiDashboard,
  writeTableOps,
} from './excelOpsService';

// ── Helpers ──────────────────────────────────────────────────────────────────

function colLetter(idx) {
  let s = '';
  let i = idx;
  while (i >= 0) {
    s = String.fromCharCode((i % 26) + 65) + s;
    i = Math.floor(i / 26) - 1;
  }
  return s;
}

function safeSheet(name) {
  return (name || 'Sheet').replace(/[\\/*?[\]:]/g, '_').slice(0, 31);
}

// ── MBR (Monthly Business Review) Template ───────────────────────────────────

/**
 * Generate the full sequence of Excel operations for a Monthly Business Review.
 *
 * Expects aggregated artifacts from prior agent loop steps:
 *   - priorArtifacts.forecast  → forecast_series / forecast_csv
 *   - priorArtifacts.plan      → plan_table / plan_csv / replay_metrics
 *   - priorArtifacts.risk      → risk data
 *   - priorArtifacts.synthesize → aggregated data
 *
 * @param {string} taskId
 * @param {string} userId
 * @param {object} priorArtifacts - { step_name: artifact_refs[] }
 * @param {object} [meta]         - { title, period, ... }
 * @returns {object[]} Array of Excel ops
 */
export function buildMbrOps(taskId, userId, priorArtifacts, meta = {}) {
  const batchId = `mbr_${Date.now()}`;
  resetSequence();

  const ops = [];
  const period = meta.period || new Date().toISOString().slice(0, 7);
  const title = meta.title || `Monthly Business Review — ${period}`;

  ops.push(batchStart(batchId, `Building MBR workbook: ${title}`));

  // ── Sheet 1: Cover Page ────────────────────────────────────────────────
  {
    const sheet = 'MBR_Cover';
    ops.push(createSheet(batchId, sheet, { activate: true }));

    ops.push(writeValues(batchId, sheet, 'A1:F1', [[title, '', '', '', '', '']]));
    ops.push(mergeCells(batchId, sheet, 'A1:F1'));
    ops.push(formatCells(batchId, sheet, 'A1:F1', {
      font: { size: 24, bold: true, color: '#1F4E79' },
      alignment: { horizontal: 'center' },
    }));

    ops.push(writeValues(batchId, sheet, 'A2:F2', [[`Generated: ${new Date().toLocaleString()}`, '', '', '', '', '']]));
    ops.push(mergeCells(batchId, sheet, 'A2:F2'));
    ops.push(formatCells(batchId, sheet, 'A2:F2', {
      font: { size: 10, color: '#888888' },
      alignment: { horizontal: 'center' },
    }));

    // Table of contents
    const tocRows = [
      ['Sheet', 'Description'],
      ['MBR_KPIs', 'Key Performance Indicators Dashboard'],
      ['MBR_Cleaned_Data', 'Cleaned & standardized dataset'],
      ['MBR_Data_Issues', 'Data quality issues log'],
      ['MBR_Analysis', 'Pivot analysis & insights'],
      ['MBR_Forecast', 'Demand forecast data'],
      ['MBR_Plan', 'Replenishment plan output'],
      ['MBR_Risk', 'Risk analysis'],
      ['MBR_Dashboard', 'One-page management dashboard'],
    ];
    const tocRange = `A4:B${4 + tocRows.length - 1}`;
    ops.push(writeValues(batchId, sheet, tocRange, tocRows));
    ops.push(createTable(batchId, sheet, tocRange, 'T_TableOfContents'));
    ops.push(autofitColumns(batchId, sheet, 'A:F'));
  }

  // ── Sheet 2: KPI Dashboard ────────────────────────────────────────────
  {
    const sheet = 'MBR_KPIs';
    ops.push(createSheet(batchId, sheet));

    // Extract KPIs from synthesis or plan artifacts
    const kpis = _extractKPIs(priorArtifacts);
    if (Object.keys(kpis).length > 0) {
      ops.push(kpiDashboard(batchId, sheet, kpis));
    } else {
      // Placeholder KPI structure
      ops.push(kpiDashboard(batchId, sheet, {
        'Total Revenue': '—',
        'Units Sold': '—',
        'Gross Profit': '—',
        'Gross Margin %': '—',
        'ASP (Avg Selling Price)': '—',
        'Return Rate': '—',
        'Discount Rate': '—',
        'Sales vs Target': '—',
        'Inventory Coverage (Days)': '—',
        'Marketing ROAS': '—',
        'Ticket Volume': '—',
        'Avg Resolution Time': '—',
      }));
    }
  }

  // ── Sheet 3: Cleaned Data ─────────────────────────────────────────────
  {
    const cleanedData = _findArtifactData(priorArtifacts, ['cleaned', 'clean', 'data']);
    if (cleanedData && Array.isArray(cleanedData) && cleanedData.length > 0) {
      const headers = Object.keys(cleanedData[0]);
      const rows = cleanedData.map(row => headers.map(h => {
        const v = row[h];
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      }));
      const tableOps = writeTableOps(batchId, 'MBR_Cleaned_Data', headers, rows, {
        chart: false,
      });
      ops.push(...tableOps);
    } else {
      ops.push(createSheet(batchId, 'MBR_Cleaned_Data'));
      ops.push(writeValues(batchId, 'MBR_Cleaned_Data', 'A1', [['Cleaned data will be populated by the analysis step.']]));
    }
  }

  // ── Sheet 4: Data Issues Log ──────────────────────────────────────────
  {
    const issuesData = _findArtifactData(priorArtifacts, ['issue', 'quality', 'log', 'problem']);
    if (issuesData && Array.isArray(issuesData) && issuesData.length > 0) {
      const headers = Object.keys(issuesData[0]);
      const rows = issuesData.map(row => headers.map(h => {
        const v = row[h];
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      }));
      const tableOps = writeTableOps(batchId, 'MBR_Data_Issues', headers, rows);
      ops.push(...tableOps);
    } else {
      ops.push(createSheet(batchId, 'MBR_Data_Issues'));
      ops.push(writeValues(batchId, 'MBR_Data_Issues', 'A1:C1', [['Issue', 'Description', 'Resolution']]));
      ops.push(formatCells(batchId, 'MBR_Data_Issues', 'A1:C1', {
        font: { bold: true },
        fill: { color: '#E2E8F0' },
      }));
    }
  }

  // ── Sheet 5: Forecast ─────────────────────────────────────────────────
  {
    const forecastData = _findArtifactData(priorArtifacts, ['forecast', 'actual_vs_forecast', 'forecast_series']);
    if (forecastData && Array.isArray(forecastData) && forecastData.length > 0) {
      const headers = Object.keys(forecastData[0]);
      const rows = forecastData.map(row => headers.map(h => {
        const v = row[h];
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      }));
      const tableOps = writeTableOps(batchId, 'MBR_Forecast', headers, rows, {
        chart: true,
        chartTitle: 'Demand Forecast — Actual vs Predicted',
        chartType: 'line',
      });
      ops.push(...tableOps);
    } else {
      ops.push(createSheet(batchId, 'MBR_Forecast'));
      ops.push(writeValues(batchId, 'MBR_Forecast', 'A1', [['Forecast data will be populated when the forecast step completes.']]));
    }
  }

  // ── Sheet 6: Plan ─────────────────────────────────────────────────────
  {
    const planData = _findArtifactData(priorArtifacts, ['plan_table', 'plan', 'replenishment']);
    if (planData && Array.isArray(planData) && planData.length > 0) {
      const headers = Object.keys(planData[0]);
      const rows = planData.map(row => headers.map(h => {
        const v = row[h];
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      }));
      const tableOps = writeTableOps(batchId, 'MBR_Plan', headers, rows, {
        chart: planData.length >= 3 && planData.length <= 30,
        chartTitle: 'Replenishment Plan Summary',
      });
      ops.push(...tableOps);
    } else {
      ops.push(createSheet(batchId, 'MBR_Plan'));
      ops.push(writeValues(batchId, 'MBR_Plan', 'A1', [['Plan data will be populated when the plan step completes.']]));
    }
  }

  // ── Sheet 7: Risk ─────────────────────────────────────────────────────
  {
    const riskData = _findArtifactData(priorArtifacts, ['risk', 'risk_scores', 'risk_plan']);
    if (riskData && Array.isArray(riskData) && riskData.length > 0) {
      const headers = Object.keys(riskData[0]);
      const rows = riskData.map(row => headers.map(h => {
        const v = row[h];
        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      }));
      const tableOps = writeTableOps(batchId, 'MBR_Risk', headers, rows, {
        chart: true,
        chartTitle: 'Risk Score Distribution',
        chartType: 'barClustered',
      });
      ops.push(...tableOps);
    } else {
      ops.push(createSheet(batchId, 'MBR_Risk'));
      ops.push(writeValues(batchId, 'MBR_Risk', 'A1', [['Risk data will be populated when the risk analysis step completes.']]));
    }
  }

  // ── Sheet 8: Analysis (Pivot-style) ────────────────────────────────────
  {
    ops.push(createSheet(batchId, 'MBR_Analysis'));

    // Build analysis summary from available data
    const analysisRows = [
      ['Analysis Category', 'Finding', 'Status', 'Impact'],
    ];

    // Extract metrics for analysis
    const metrics = _extractKPIs(priorArtifacts);
    if (metrics['Gross Margin %'] !== undefined) {
      const margin = parseFloat(metrics['Gross Margin %']);
      if (!isNaN(margin)) {
        analysisRows.push([
          'Margin Health',
          `Current gross margin: ${(margin * 100).toFixed(1)}%`,
          margin < 0.3 ? 'Warning' : 'OK',
          margin < 0.3 ? 'Margin below 30% threshold' : 'Within target range',
        ]);
      }
    }

    if (metrics['Return Rate'] !== undefined) {
      const retRate = parseFloat(metrics['Return Rate']);
      if (!isNaN(retRate)) {
        analysisRows.push([
          'Return Rate',
          `Return rate: ${(retRate * 100).toFixed(1)}%`,
          retRate > 0.05 ? 'Alert' : 'OK',
          retRate > 0.05 ? 'Above 5% — investigate by product/region' : 'Within acceptable range',
        ]);
      }
    }

    if (analysisRows.length === 1) {
      // Placeholder analysis if no metrics available
      analysisRows.push(
        ['Target Achievement', 'To be analyzed from data', 'Pending', '—'],
        ['Regional Performance', 'To be analyzed from data', 'Pending', '—'],
        ['Product Mix', 'To be analyzed from data', 'Pending', '—'],
        ['Return Analysis', 'To be analyzed from data', 'Pending', '—'],
        ['Discount vs Margin', 'To be analyzed from data', 'Pending', '—'],
        ['Inventory Pressure', 'To be analyzed from data', 'Pending', '—'],
      );
    }

    const aRange = `A1:D${analysisRows.length}`;
    ops.push(writeValues(batchId, 'MBR_Analysis', aRange, analysisRows));
    ops.push(createTable(batchId, 'MBR_Analysis', aRange, 'T_Analysis'));
    ops.push(freezePanes(batchId, 'MBR_Analysis', 1, 0));
    ops.push(autofitColumns(batchId, 'MBR_Analysis', 'A:D'));

    // Conditional format on Status column (C)
    if (analysisRows.length > 1) {
      ops.push(conditionalFormat(batchId, 'MBR_Analysis', `C2:C${analysisRows.length}`, 'icon_set'));
    }
  }

  // ── Sheet 9: Dashboard (one-page summary) ─────────────────────────────
  {
    ops.push(createSheet(batchId, 'MBR_Dashboard'));

    // Title
    ops.push(writeValues(batchId, 'MBR_Dashboard', 'A1:H1', [[title, '', '', '', '', '', '', '']]));
    ops.push(mergeCells(batchId, 'MBR_Dashboard', 'A1:H1'));
    ops.push(formatCells(batchId, 'MBR_Dashboard', 'A1:H1', {
      font: { size: 20, bold: true, color: '#1F4E79' },
      alignment: { horizontal: 'center' },
      fill: { color: '#F2F7FB' },
    }));

    // KPI cards row (compact)
    const kpis = _extractKPIs(priorArtifacts);
    const kpiEntries = Object.entries(kpis).slice(0, 6); // Top 6 for dashboard
    if (kpiEntries.length > 0) {
      const kpiLabels = kpiEntries.map(([k]) => k);
      const kpiValues = kpiEntries.map(([, v]) => v);
      ops.push(writeValues(batchId, 'MBR_Dashboard', `A3:${colLetter(kpiEntries.length - 1)}3`, [kpiLabels]));
      ops.push(writeValues(batchId, 'MBR_Dashboard', `A4:${colLetter(kpiEntries.length - 1)}4`, [kpiValues]));
      ops.push(formatCells(batchId, 'MBR_Dashboard', `A3:${colLetter(kpiEntries.length - 1)}3`, {
        font: { size: 9, bold: true, color: '#666666' },
      }));
      ops.push(formatCells(batchId, 'MBR_Dashboard', `A4:${colLetter(kpiEntries.length - 1)}4`, {
        font: { size: 18, bold: true, color: '#1F4E79' },
      }));
      for (let c = 0; c < kpiEntries.length; c++) {
        ops.push(formatCells(batchId, 'MBR_Dashboard', `${colLetter(c)}3:${colLetter(c)}4`, {
          fill: { color: '#F2F7FB' },
          border: { bottom: { style: 'thin', color: '#2E75B6' } },
        }));
      }
    }

    // Observations section
    ops.push(writeValues(batchId, 'MBR_Dashboard', 'A7:H7', [['Key Observations & Management Insights', '', '', '', '', '', '', '']]));
    ops.push(mergeCells(batchId, 'MBR_Dashboard', 'A7:H7'));
    ops.push(formatCells(batchId, 'MBR_Dashboard', 'A7:H7', {
      font: { size: 14, bold: true, color: '#1F4E79' },
    }));

    const insights = _generateInsights(priorArtifacts, kpis);
    for (let i = 0; i < insights.length; i++) {
      ops.push(writeValues(batchId, 'MBR_Dashboard', `A${8 + i}:H${8 + i}`, [[`${i + 1}. ${insights[i]}`, '', '', '', '', '', '', '']]));
      ops.push(mergeCells(batchId, 'MBR_Dashboard', `A${8 + i}:H${8 + i}`));
    }

    ops.push(autofitColumns(batchId, 'MBR_Dashboard', 'A:H'));
  }

  ops.push(batchEnd(batchId, `MBR workbook built: ${ops.length} operations across 9 sheets.`));

  return ops;
}

// ── Data extraction helpers ──────────────────────────────────────────────────

function _findArtifactData(priorArtifacts, keywords) {
  if (!priorArtifacts) return null;

  for (const stepRefs of Object.values(priorArtifacts)) {
    if (!Array.isArray(stepRefs)) continue;
    for (const ref of stepRefs) {
      const type = (ref.type || '').toLowerCase();
      const label = (ref.label || '').toLowerCase();
      for (const kw of keywords) {
        if (type.includes(kw) || label.includes(kw)) {
          return ref.data || ref.content || null;
        }
      }
    }
  }
  return null;
}

function _extractKPIs(priorArtifacts) {
  if (!priorArtifacts) return {};

  const kpis = {};

  // Look through all artifacts for KPI-like data
  for (const stepRefs of Object.values(priorArtifacts)) {
    if (!Array.isArray(stepRefs)) continue;
    for (const ref of stepRefs) {
      const type = (ref.type || '').toLowerCase();
      const data = ref.data || ref.content;
      if (!data) continue;

      // replay_metrics, metrics, solver_meta contain KPIs
      if (type === 'replay_metrics' || type === 'metrics') {
        if (typeof data === 'object' && !Array.isArray(data)) {
          Object.assign(kpis, data);
        }
      }

      // solver_meta may have planning KPIs
      if (type === 'solver_meta') {
        if (data.items_planned !== undefined) kpis['Items Planned'] = data.items_planned;
        if (data.total_cost !== undefined) kpis['Total Cost'] = data.total_cost;
        if (data.solver_used) kpis['Solver'] = data.solver_used;
      }
    }
  }

  return kpis;
}

function _generateInsights(priorArtifacts, kpis) {
  const insights = [];

  // Margin insight
  const margin = parseFloat(kpis['Gross Margin %'] || kpis['gross_margin'] || kpis['margin']);
  if (!isNaN(margin)) {
    if (margin < 0.3) {
      insights.push(`Gross margin at ${(margin * 100).toFixed(1)}% is below the 30% target — discount strategy may be eroding profitability.`);
    } else {
      insights.push(`Gross margin healthy at ${(margin * 100).toFixed(1)}%.`);
    }
  }

  // Return rate insight
  const retRate = parseFloat(kpis['Return Rate'] || kpis['return_rate']);
  if (!isNaN(retRate) && retRate > 0.03) {
    insights.push(`Return rate at ${(retRate * 100).toFixed(1)}% — investigate products/regions with highest return volume.`);
  }

  // Risk insight
  const riskData = _findArtifactData(priorArtifacts, ['risk_scores']);
  if (Array.isArray(riskData)) {
    const highRisk = riskData.filter(r => (r.risk_score || 0) >= 0.7).length;
    if (highRisk > 0) {
      insights.push(`${highRisk} item(s) flagged as high-risk (score ≥ 0.7) — review supply continuity and safety stock levels.`);
    }
  }

  // Inventory insight
  const invCoverage = parseFloat(kpis['Inventory Coverage (Days)'] || kpis['inventory_coverage_days']);
  if (!isNaN(invCoverage)) {
    if (invCoverage > 90) {
      insights.push(`Inventory coverage at ${invCoverage.toFixed(0)} days — potential overstock; consider reducing order quantities.`);
    } else if (invCoverage < 14) {
      insights.push(`Inventory coverage at ${invCoverage.toFixed(0)} days — stockout risk; expedite replenishment.`);
    }
  }

  // Default insights if none generated
  if (insights.length === 0) {
    insights.push(
      'Review regional revenue breakdown for underperforming markets.',
      'Compare discount rate vs. gross margin trend — discount may be eroding margins.',
      'Assess inventory aging to identify slow-moving SKUs for markdown.',
    );
  }

  return insights.slice(0, 5); // Max 5 insights
}

// ── Export ────────────────────────────────────────────────────────────────────

export default { buildMbrOps };
