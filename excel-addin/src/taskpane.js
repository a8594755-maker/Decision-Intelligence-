// ─────────────────────────────────────────────────────────────────────────────
// SmartOps DI Reports — Excel Add-in Taskpane
//
// Authenticates with Supabase, fetches report data from report-api Edge
// Function, and writes structured data into Excel worksheets via Office.js.
// ─────────────────────────────────────────────────────────────────────────────

/* global Office, Excel */

// ── State ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://cbxvqqqulwytdblivtoe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNieHZxcXF1bHd5dGRibGl2dG9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NjQzNjUsImV4cCI6MjA4MDA0MDM2NX0.3PeFtqJAkoxrosFeAiXbOklRCDxaQjH2VjXWwEiFyYI';

let _supabaseUrl = SUPABASE_URL;
let _anonKey = SUPABASE_ANON_KEY;
let _accessToken = '';
let _userEmail = '';
let _reports = [];
let _selectedReportId = null;
let _kpiData = null;
let _monthlyData = null;

// ── Office Init ─────────────────────────────────────────────────────────────

Office.onReady((info) => {
  if (info.host === Office.HostType.Excel) {
    setStatus('Excel Add-in ready.');
  }
  // Restore saved connection
  try {
    const saved = localStorage.getItem('di_addin_connection');
    if (saved) {
      const conn = JSON.parse(saved);
      if (conn.token && conn.email) {
        _accessToken = conn.token;
        _userEmail = conn.email;
        showConnected();
      }
    }
  } catch { /* ignore */ }
});

// ── Auth ────────────────────────────────────────────────────────────────────

async function doLogin() {
  const email = document.getElementById('input-email').value.trim();
  const password = document.getElementById('input-password').value;

  if (!email || !password) {
    showAuthError('Please enter email and password.');
    return;
  }

  setStatus('Signing in...');
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error_description || err.msg || `Auth failed (${res.status})`);
    }

    const data = await res.json();
    _accessToken = data.access_token;
    _userEmail = email;

    // Persist connection
    localStorage.setItem('di_addin_connection', JSON.stringify({
      token: data.access_token, email,
    }));

    showConnected();
    setStatus('Signed in successfully.');
  } catch (err) {
    showAuthError(err.message);
    setStatus('Sign in failed.');
  }
}

function doLogout() {
  _accessToken = '';
  _userEmail = '';
  _reports = [];
  _selectedReportId = null;
  localStorage.removeItem('di_addin_connection');

  document.getElementById('auth-login').classList.remove('hidden');
  document.getElementById('auth-connected').classList.add('hidden');
  document.getElementById('main-content').classList.add('hidden');
  setStatus('Signed out.');
}

function showConnected() {
  document.getElementById('auth-login').classList.add('hidden');
  document.getElementById('auth-connected').classList.remove('hidden');
  document.getElementById('auth-user').textContent = _userEmail;
  document.getElementById('main-content').classList.remove('hidden');

  // Auto Mode is always on — start immediately
  if (!_autoModeActive) {
    startAutoMode();
  }

  // Start listening for realtime task updates
  startRealtimeSubscription();
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── API Client ──────────────────────────────────────────────────────────────

async function callReportApi(action, params = {}) {
  const url = `${_supabaseUrl}/functions/v1/report-api`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_accessToken}`,
    },
    body: JSON.stringify({ action, ...params }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error (${res.status})`);
  }

  return res.json();
}

// ── Report List ─────────────────────────────────────────────────────────────

async function loadReports() {
  const spinner = document.getElementById('spin-reports');
  spinner.classList.remove('hidden');
  setStatus('Loading reports...');

  try {
    const data = await callReportApi('list_reports', { limit: 20 });
    _reports = data.reports || [];
    renderReportList();
    setStatus(`Loaded ${_reports.length} report(s).`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    spinner.classList.add('hidden');
  }
}

function renderReportList() {
  const container = document.getElementById('report-items');
  if (_reports.length === 0) {
    container.innerHTML = '<div style="padding:8px 0;color:var(--text-muted);">No reports found.</div>';
    return;
  }

  container.innerHTML = _reports.map((r, i) => {
    const score = r.avg_score ?? r.score ?? null;
    const scoreClass = score >= 75 ? 'score-high' : score >= 50 ? 'score-mid' : 'score-low';
    const selected = _selectedReportId === r.id ? 'background:#eff6ff;' : '';
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';
    return `
      <div class="report-item" style="${selected}cursor:pointer;" onclick="selectReport('${r.id}', ${i})">
        <div>
          <div class="report-name">${escHtml(r.title || r.instruction?.slice(0, 40) || 'Untitled')}</div>
          <div class="report-meta">${date} &middot; ${r.status || 'unknown'} &middot; ${r.step_count || 0} steps</div>
        </div>
        ${score !== null ? `<span class="report-score ${scoreClass}">${Math.round(score)}</span>` : ''}
      </div>`;
  }).join('');
}

function selectReport(id, index) {
  _selectedReportId = id;
  renderReportList();
  setStatus(`Selected: ${_reports[index]?.title || id}`);
}

// ── Pull Report to Sheet ────────────────────────────────────────────────────

async function pullSelectedReport() {
  if (!_selectedReportId) {
    setStatus('Select a report first.');
    return;
  }

  setStatus('Fetching report data...');
  try {
    const data = await callReportApi('get_report', { task_id: _selectedReportId });
    await writeReportToExcel(data);
    setStatus('Report written to Excel.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

async function writeReportToExcel(report) {
  const prefix = document.getElementById('pref-prefix').value || 'DI_';
  const autoFormat = document.getElementById('pref-autoformat').checked;

  await Excel.run(async (context) => {
    const wb = context.workbook;

    // 1. Summary sheet
    const summaryName = `${prefix}Summary`;
    let summarySheet = tryGetSheet(wb, summaryName);
    if (!summarySheet) {
      summarySheet = wb.worksheets.add(summaryName);
    }
    summarySheet.activate();

    const summaryRows = [
      ['SmartOps DI Report'],
      [''],
      ['Task ID', report.task?.id || ''],
      ['Title', report.task?.title || report.task?.instruction || ''],
      ['Status', report.task?.status || ''],
      ['Created', report.task?.created_at || ''],
      ['Employee', report.task?.employee_id || ''],
      [''],
      ['Steps', 'Status', 'Score', 'Duration (ms)'],
    ];

    if (report.steps?.length) {
      for (const step of report.steps) {
        summaryRows.push([
          step.step_name || '',
          step.status || '',
          step.review_score ?? '',
          step.duration_ms ?? '',
        ]);
      }
    }

    writeData(summarySheet, summaryRows);
    if (autoFormat) formatAsTable(summarySheet, summaryRows, context);

    // 2. Artifacts sheets by category — use native Excel Tables + formatting
    const artifacts = report.artifacts || {};
    for (const [category, items] of Object.entries(artifacts)) {
      if (!items?.length) continue;

      const sheetName = `${prefix}${capitalize(category)}`;
      let sheet = tryGetSheet(wb, sheetName);
      if (!sheet) sheet = wb.worksheets.add(sheetName);

      const rows = artifactsToRows(items);
      if (rows.length > 0) {
        if (autoFormat && rows.length >= 2) {
          // Use native Excel Table
          const tableName = `T_${category}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
          writeAsExcelTable(sheet, rows, tableName);
          freezeHeaderRow(sheet);

          // Smart formatting
          const headers = rows[0] || [];
          applySmartNumberFormatting(sheet, headers, 2, rows.length);
        } else {
          writeData(sheet, rows);
        }
      }
    }

    // 3. Reviews sheet
    if (report.reviews?.length) {
      const reviewName = `${prefix}Reviews`;
      let reviewSheet = tryGetSheet(wb, reviewName);
      if (!reviewSheet) reviewSheet = wb.worksheets.add(reviewName);

      const reviewRows = [
        ['Step', 'Round', 'Score', 'Passed', 'Feedback', 'Reviewer'],
      ];
      for (const r of report.reviews) {
        reviewRows.push([
          r.step_name || '',
          r.revision_round || '',
          r.score ?? '',
          r.passed ? 'Yes' : 'No',
          r.feedback || '',
          r.reviewer_model || '',
        ]);
      }

      writeData(reviewSheet, reviewRows);
      if (autoFormat) formatAsTable(reviewSheet, reviewRows, context);
    }

    await context.sync();
  });
}

// ── KPIs ────────────────────────────────────────────────────────────────────

async function loadKPIs() {
  const spinner = document.getElementById('spin-kpis');
  spinner.classList.remove('hidden');
  setStatus('Loading KPIs...');

  try {
    _kpiData = await callReportApi('get_kpis');
    renderKPIs();
    setStatus('KPIs loaded.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    spinner.classList.add('hidden');
  }
}

function renderKPIs() {
  const container = document.getElementById('kpi-items');
  if (!_kpiData?.kpis) {
    container.innerHTML = '<div>No KPI data.</div>';
    return;
  }

  const kpis = _kpiData.kpis;
  container.innerHTML = Object.entries(kpis).map(([key, val]) => `
    <div class="setting-row">
      <span class="setting-label">${escHtml(key)}</span>
      <span class="setting-value" style="font-weight:600;">${typeof val === 'number' ? val.toFixed(2) : val}</span>
    </div>
  `).join('');
}

async function pullKPIsToSheet() {
  if (!_kpiData?.kpis) {
    setStatus('Load KPIs first.');
    return;
  }

  setStatus('Writing KPIs to sheet...');
  try {
    const prefix = document.getElementById('pref-prefix').value || 'DI_';
    const autoFormat = document.getElementById('pref-autoformat').checked;

    await Excel.run(async (context) => {
      const sheetName = `${prefix}KPIs`;
      let sheet = tryGetSheet(context.workbook, sheetName);
      if (!sheet) sheet = context.workbook.worksheets.add(sheetName);
      sheet.activate();

      const rows = [['KPI', 'Value']];
      for (const [key, val] of Object.entries(_kpiData.kpis)) {
        rows.push([key, val]);
      }

      writeData(sheet, rows);
      if (autoFormat) formatAsTable(sheet, rows, context);
      await context.sync();
    });
    setStatus('KPIs written to sheet.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// ── Monthly ─────────────────────────────────────────────────────────────────

async function loadMonthly() {
  const spinner = document.getElementById('spin-monthly');
  spinner.classList.remove('hidden');
  setStatus('Loading monthly data...');

  try {
    const month = parseInt(document.getElementById('month-select').value);
    const year = parseInt(document.getElementById('year-input').value);
    _monthlyData = await callReportApi('get_monthly', { month, year });

    const summary = document.getElementById('monthly-summary');
    const content = document.getElementById('monthly-content');
    summary.classList.remove('hidden');

    const md = _monthlyData;
    content.innerHTML = `
      <div class="setting-row"><span class="setting-label">Period</span><span class="setting-value">${md.period || `${year}-${String(month).padStart(2,'0')}`}</span></div>
      <div class="setting-row"><span class="setting-label">Total Tasks</span><span class="setting-value" style="font-weight:600;">${md.total_tasks ?? 0}</span></div>
      <div class="setting-row"><span class="setting-label">Completed</span><span class="setting-value" style="font-weight:600;">${md.completed_tasks ?? 0}</span></div>
      <div class="setting-row"><span class="setting-label">Avg Review Score</span><span class="setting-value" style="font-weight:600;">${md.avg_review_score?.toFixed(1) ?? '—'}</span></div>
      <div class="setting-row"><span class="setting-label">Total Cost (USD)</span><span class="setting-value" style="font-weight:600;">$${md.total_cost?.toFixed(4) ?? '0.00'}</span></div>
    `;
    setStatus('Monthly data loaded.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    spinner.classList.add('hidden');
  }
}

async function pullMonthlyToSheet() {
  if (!_monthlyData) {
    setStatus('Fetch monthly data first.');
    return;
  }

  setStatus('Writing monthly report to sheet...');
  try {
    const prefix = document.getElementById('pref-prefix').value || 'DI_';
    const month = document.getElementById('month-select').value;
    const year = document.getElementById('year-input').value;
    const autoFormat = document.getElementById('pref-autoformat').checked;

    await Excel.run(async (context) => {
      const sheetName = `${prefix}Monthly_${year}_${String(month).padStart(2,'0')}`;
      let sheet = tryGetSheet(context.workbook, sheetName);
      if (!sheet) sheet = context.workbook.worksheets.add(sheetName);
      sheet.activate();

      // Summary section
      const rows = [
        ['Monthly Report', `${year}-${String(month).padStart(2,'0')}`],
        [''],
        ['Metric', 'Value'],
        ['Total Tasks', _monthlyData.total_tasks ?? 0],
        ['Completed Tasks', _monthlyData.completed_tasks ?? 0],
        ['Failed Tasks', _monthlyData.failed_tasks ?? 0],
        ['Avg Review Score', _monthlyData.avg_review_score ?? ''],
        ['Total Cost (USD)', _monthlyData.total_cost ?? 0],
        [''],
      ];

      // Task details if available
      if (_monthlyData.tasks?.length) {
        rows.push(['Task ID', 'Title', 'Status', 'Score', 'Cost', 'Created']);
        for (const t of _monthlyData.tasks) {
          rows.push([
            t.id || '',
            t.title || t.instruction?.slice(0, 60) || '',
            t.status || '',
            t.avg_score ?? '',
            t.cost ?? '',
            t.created_at || '',
          ]);
        }
      }

      writeData(sheet, rows);
      if (autoFormat) formatAsTable(sheet, rows, context);
      await context.sync();
    });
    setStatus('Monthly report written to sheet.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// ── Tab Navigation ──────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
}

// ── Excel Helpers ───────────────────────────────────────────────────────────

function writeData(sheet, rows) {
  if (rows.length === 0) return;
  const maxCols = Math.max(...rows.map(r => r.length));
  // Pad rows to same width
  const padded = rows.map(r => {
    const row = [...r];
    while (row.length < maxCols) row.push('');
    return row;
  });

  const range = sheet.getRange(
    `A1:${colLetter(maxCols - 1)}${padded.length}`
  );
  range.values = padded;
}

function formatAsTable(sheet, rows, context) {
  if (rows.length < 2) return;

  // Find first header row (non-empty with multiple columns)
  let headerIdx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].filter(c => c !== '' && c !== null && c !== undefined).length >= 2) {
      headerIdx = i;
      break;
    }
  }

  try {
    const maxCols = Math.max(...rows.map(r => r.length));
    const headerRange = sheet.getRange(
      `A${headerIdx + 1}:${colLetter(maxCols - 1)}${headerIdx + 1}`
    );
    headerRange.format.font.bold = true;
    headerRange.format.fill.color = '#e2e8f0';

    // Auto-fit columns
    const fullRange = sheet.getRange(
      `A1:${colLetter(maxCols - 1)}${rows.length}`
    );
    fullRange.format.autofitColumns();
  } catch { /* best-effort formatting */ }
}

// ── Native Excel Operations (Office.js) ─────────────────────────────────────
// Rich formatting using native Excel capabilities: Tables, Charts, Conditional
// Formatting, Sorting, Filtering, Number Formatting, Data Validation.
// Modelled after Claude for Excel's native operation approach.

/**
 * Write data as an Excel Table with auto-filter, banded rows, and auto-fit.
 * Uses the native Table API — not just cell formatting.
 */
function writeAsExcelTable(sheet, rows, tableName) {
  if (rows.length < 2) return null;

  const maxCols = Math.max(...rows.map(r => r.length));
  const padded = rows.map(r => {
    const row = [...r];
    while (row.length < maxCols) row.push('');
    return row;
  });

  // Write raw data first
  const rangeAddr = `A1:${colLetter(maxCols - 1)}${padded.length}`;
  const range = sheet.getRange(rangeAddr);
  range.values = padded;

  // Convert to Excel Table (native)
  try {
    const safeName = (tableName || 'Table1').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
    const table = sheet.tables.add(rangeAddr, true /* hasHeaders */);
    table.name = safeName;
    table.style = 'TableStyleMedium2'; // Blue banded rows
    table.showFilterButton = true;

    // Auto-fit
    range.format.autofitColumns();
    range.format.autofitRows();

    return table;
  } catch (e) {
    // Fallback: just format the header
    console.warn('[taskpane] Table creation failed, using basic formatting:', e.message);
    const headerRange = sheet.getRange(`A1:${colLetter(maxCols - 1)}1`);
    headerRange.format.font.bold = true;
    headerRange.format.fill.color = '#1F4E79';
    headerRange.format.font.color = '#FFFFFF';
    range.format.autofitColumns();
    return null;
  }
}

/**
 * Apply conditional formatting to a numeric column.
 * Highlights top values green, bottom values red (color scale).
 */
function applyConditionalFormatting(sheet, colIndex, startRow, endRow, type) {
  try {
    const rangeAddr = `${colLetter(colIndex)}${startRow}:${colLetter(colIndex)}${endRow}`;
    const range = sheet.getRange(rangeAddr);

    if (type === 'color_scale') {
      // 3-color scale: red → yellow → green
      const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.colorScale);
      cf.colorScale.criteria = JSON.stringify({
        minimum: { type: 'lowestValue', color: '#F8696B' },
        midpoint: { type: 'percentile', value: 50, color: '#FFEB84' },
        maximum: { type: 'highestValue', color: '#63BE7B' },
      });
    } else if (type === 'data_bar') {
      // Data bars
      const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.dataBar);
      cf.dataBar.barDirection = Excel.ConditionalDataBarDirection.context;
    } else if (type === 'icon_set') {
      // Traffic light icons
      const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.iconSet);
      cf.iconSet.style = Excel.IconSet.threeTrafficLights1;
    }
  } catch (e) {
    console.warn('[taskpane] Conditional formatting failed:', e.message);
  }
}

/**
 * Apply number formatting to detected numeric/currency/percentage columns.
 */
function applySmartNumberFormatting(sheet, headers, startRow, endRow) {
  try {
    for (let c = 0; c < headers.length; c++) {
      const h = (headers[c] || '').toLowerCase();
      const rangeAddr = `${colLetter(c)}${startRow}:${colLetter(c)}${endRow}`;
      const range = sheet.getRange(rangeAddr);

      if (h.includes('revenue') || h.includes('cost') || h.includes('price') ||
          h.includes('amount') || h.includes('profit') || h.includes('budget') ||
          h.includes('sales') || h.includes('asp') || h.includes('margin_value') ||
          h.includes('營收') || h.includes('金額') || h.includes('成本')) {
        range.numberFormat = [['#,##0.00']];
      } else if (h.includes('rate') || h.includes('ratio') || h.includes('margin') ||
                 h.includes('percent') || h.includes('%') || h.includes('比率') ||
                 h.includes('佔比')) {
        range.numberFormat = [['0.0%']];
      } else if (h.includes('count') || h.includes('qty') || h.includes('units') ||
                 h.includes('quantity') || h.includes('數量')) {
        range.numberFormat = [['#,##0']];
      } else if (h.includes('date') || h.includes('日期') || h.includes('month') ||
                 h.includes('year')) {
        range.numberFormat = [['yyyy-mm-dd']];
      }
    }
  } catch (e) {
    console.warn('[taskpane] Number formatting failed:', e.message);
  }
}

/**
 * Create an Excel chart from table data.
 * Auto-detects best chart type based on data shape.
 */
function createChart(sheet, headers, dataRows, chartTitle, options) {
  try {
    const opts = options || {};
    const maxCols = headers.length;
    const totalRows = dataRows.length + 1; // +1 for header
    const rangeAddr = `A1:${colLetter(maxCols - 1)}${totalRows}`;

    // Determine chart type
    let chartType = opts.chartType || Excel.ChartType.columnClustered;

    // Auto-detect: if we have a time-like first column + numeric columns → line chart
    const firstHeader = (headers[0] || '').toLowerCase();
    if (firstHeader.includes('month') || firstHeader.includes('date') ||
        firstHeader.includes('period') || firstHeader.includes('quarter') ||
        firstHeader.includes('year') || firstHeader.includes('月')) {
      chartType = Excel.ChartType.line;
    }

    // If only 2 columns and many rows → line chart
    if (maxCols === 2 && dataRows.length > 5) {
      chartType = Excel.ChartType.line;
    }

    // If few categories + 1 numeric → bar chart
    if (dataRows.length <= 10 && maxCols === 2) {
      chartType = Excel.ChartType.barClustered;
    }

    const chart = sheet.charts.add(
      chartType,
      sheet.getRange(rangeAddr),
      opts.seriesBy || Excel.ChartSeriesBy.columns
    );

    chart.title.text = chartTitle || 'Chart';
    chart.title.format.font.size = 14;
    chart.title.format.font.bold = true;

    // Position: below the data table
    chart.top = (totalRows + 2) * 20;
    chart.left = 10;
    chart.width = Math.min(700, maxCols * 120);
    chart.height = 350;

    // Style
    chart.legend.position = Excel.ChartLegendPosition.bottom;

    return chart;
  } catch (e) {
    console.warn('[taskpane] Chart creation failed:', e.message);
    return null;
  }
}

/**
 * Create a KPI dashboard sheet with formatted cards and sparklines.
 */
function writeKPIDashboard(sheet, kpis) {
  if (!kpis || Object.keys(kpis).length === 0) return;

  const entries = Object.entries(kpis).filter(([k]) =>
    k !== 'pdf_base64' && k !== 'html'
  );

  // Title
  const titleRange = sheet.getRange('A1:F1');
  titleRange.merge(true);
  titleRange.values = [['Key Performance Indicators']];
  titleRange.format.font.size = 18;
  titleRange.format.font.bold = true;
  titleRange.format.font.color = '#1F4E79';
  titleRange.format.horizontalAlignment = 'Center';

  // Timestamp
  const timeRange = sheet.getRange('A2:F2');
  timeRange.merge(true);
  timeRange.values = [[`Generated: ${new Date().toLocaleString()}`]];
  timeRange.format.font.size = 10;
  timeRange.format.font.color = '#888888';
  timeRange.format.horizontalAlignment = 'Center';

  // KPI cards in a 3-column grid
  const cols = 3;
  let row = 4;
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const col = (i % cols) * 2;
    const cellAddr = `${colLetter(col)}${row}`;
    const valueCellAddr = `${colLetter(col)}${row + 1}`;

    // KPI label
    const labelRange = sheet.getRange(cellAddr);
    labelRange.values = [[key.replace(/_/g, ' ').toUpperCase()]];
    labelRange.format.font.size = 9;
    labelRange.format.font.color = '#666666';
    labelRange.format.font.bold = true;

    // KPI value
    const valueRange = sheet.getRange(valueCellAddr);
    const displayVal = typeof value === 'number' ?
      (Math.abs(value) >= 1000 ? value.toLocaleString() : value) : value;
    valueRange.values = [[displayVal]];
    valueRange.format.font.size = 20;
    valueRange.format.font.bold = true;
    valueRange.format.font.color = '#1F4E79';

    // Card background
    const cardRange = sheet.getRange(`${colLetter(col)}${row}:${colLetter(col + 1)}${row + 1}`);
    cardRange.format.fill.color = '#F2F7FB';
    cardRange.format.borders.getItem('EdgeBottom').style = 'Thin';
    cardRange.format.borders.getItem('EdgeBottom').color = '#2E75B6';

    if ((i + 1) % cols === 0) row += 3;
  }

  sheet.getRange('A:F').format.autofitColumns();
}

/**
 * Sort a range by a specific column (descending by default for numeric).
 */
function sortByColumn(sheet, rangeAddr, colIndex, ascending) {
  try {
    const range = sheet.getRange(rangeAddr);
    range.sort.apply([{
      key: colIndex,
      ascending: ascending !== undefined ? ascending : false,
    }]);
  } catch (e) {
    console.warn('[taskpane] Sort failed:', e.message);
  }
}

/**
 * Freeze the header row (panes) for better scrolling.
 */
function freezeHeaderRow(sheet) {
  try {
    sheet.freezePanes.freezeRows(1);
  } catch (e) {
    console.warn('[taskpane] Freeze panes failed:', e.message);
  }
}

/**
 * Add data validation dropdown to a column.
 */
function addDropdownValidation(sheet, colIndex, startRow, endRow, allowedValues) {
  try {
    const rangeAddr = `${colLetter(colIndex)}${startRow}:${colLetter(colIndex)}${endRow}`;
    const range = sheet.getRange(rangeAddr);
    range.dataValidation.rule = {
      list: { inCellDropDown: true, source: allowedValues.join(',') },
    };
  } catch (e) {
    console.warn('[taskpane] Data validation failed:', e.message);
  }
}

function tryGetSheet(workbook, name) {
  try {
    const sheet = workbook.worksheets.getItemOrNullObject(name);
    return sheet.isNullObject ? null : sheet;
  } catch {
    return null;
  }
}

function colLetter(idx) {
  let s = '';
  let i = idx;
  while (i >= 0) {
    s = String.fromCharCode((i % 26) + 65) + s;
    i = Math.floor(i / 26) - 1;
  }
  return s;
}

// ── Data Helpers ────────────────────────────────────────────────────────────

function artifactsToRows(artifacts) {
  if (!artifacts?.length) return [];

  // Try to create a table from artifact payloads
  const rows = [];
  let headerSet = false;

  for (const artifact of artifacts) {
    const payload = artifact.payload || artifact.data || artifact;

    if (Array.isArray(payload)) {
      // Array of objects → table
      if (payload.length > 0 && typeof payload[0] === 'object') {
        if (!headerSet) {
          rows.push(Object.keys(payload[0]));
          headerSet = true;
        }
        for (const item of payload) {
          rows.push(Object.values(item).map(v =>
            typeof v === 'object' ? JSON.stringify(v) : v
          ));
        }
      }
    } else if (typeof payload === 'object' && payload !== null) {
      // Single object → key/value pairs
      if (!headerSet) {
        rows.push(['Field', 'Value']);
        headerSet = true;
      }
      for (const [k, v] of Object.entries(payload)) {
        rows.push([k, typeof v === 'object' ? JSON.stringify(v) : v]);
      }
    }
  }

  return rows;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function setStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

// ── Realtime Subscription ────────────────────────────────────────────────────
// Polls for task status changes. When a task completes, auto-pulls into Excel.

let _pollingInterval = null;
let _lastKnownTaskIds = new Set();

function startRealtimeSubscription() {
  if (_pollingInterval) return;

  // Initial load
  _pollForUpdates();

  // Poll every 10 seconds for task status changes
  _pollingInterval = setInterval(_pollForUpdates, 10000);
  setStatus('Live: watching for report updates...');
}

function stopRealtimeSubscription() {
  if (_pollingInterval) {
    clearInterval(_pollingInterval);
    _pollingInterval = null;
  }
}

async function _pollForUpdates() {
  try {
    const data = await callReportApi('list_reports', { limit: 5 });
    const reports = data?.reports || [];

    for (const report of reports) {
      // Detect newly completed tasks
      if (report.status === 'completed' && !_lastKnownTaskIds.has(report.id)) {
        _lastKnownTaskIds.add(report.id);

        // Show banner
        const banner = document.getElementById('live-banner');
        const bannerText = document.getElementById('live-banner-text');
        banner.classList.remove('hidden');
        bannerText.textContent = `Report ready: ${report.title || report.instruction?.slice(0, 40) || 'New Report'}`;

        // Auto-pull to Excel
        setStatus('Auto-pulling completed report...');
        try {
          const fullReport = await callReportApi('get_report', { task_id: report.id });
          await writeReportToExcel(fullReport);
          addChatMessage('system', `Report "${report.title || 'Untitled'}" auto-loaded into Excel.`);
          setStatus('Report auto-loaded.');
        } catch (err) {
          setStatus(`Auto-pull failed: ${err.message}`);
        }

        // Hide banner after 5s
        setTimeout(() => banner.classList.add('hidden'), 5000);

        // Refresh report list
        _reports = reports;
        renderReportList();
        return; // Process one at a time
      }
    }

    // Track in-progress tasks
    const inProgress = reports.find(r => r.status === 'running' || r.status === 'pending' || r.status === 'in_progress');
    const banner = document.getElementById('live-banner');
    if (inProgress) {
      banner.classList.remove('hidden');
      document.getElementById('live-banner-text').textContent =
        `AI Employee working: ${inProgress.title || inProgress.instruction?.slice(0, 40) || '...'}`;
      // Start step progress polling if not already running
      startStepProgressPolling();
    } else {
      banner.classList.add('hidden');
    }

    // Update known IDs
    for (const r of reports) {
      if (r.status === 'completed') _lastKnownTaskIds.add(r.id);
    }
  } catch { /* silent polling failure */ }
}

// ── Agent Loop Step Progress ─────────────────────────────────────────────────
// Shows real-time step-by-step progress when an AI Employee task is running.
// When a step completes with artifacts, auto-writes artifact data to new sheets.

let _activeTaskSteps = null;
let _stepPollingInterval = null;
let _autoPopulatedSheets = new Set();

function startStepProgressPolling() {
  if (_stepPollingInterval) return;
  _pollStepProgress();
  _stepPollingInterval = setInterval(_pollStepProgress, 5000); // Poll every 5s
}

function stopStepProgressPolling() {
  if (_stepPollingInterval) {
    clearInterval(_stepPollingInterval);
    _stepPollingInterval = null;
  }
  _activeTaskSteps = null;
  _autoPopulatedSheets.clear();
}

async function _pollStepProgress() {
  try {
    // Fetch active task with step details from report-api
    const data = await callReportApi('list_reports', { limit: 1 });
    const task = (data?.reports || [])[0];
    if (!task || (task.status !== 'running' && task.status !== 'in_progress')) {
      _hideStepProgress();
      return;
    }

    // Fetch full report to get step details
    const fullReport = await callReportApi('get_report', { task_id: task.id });
    const steps = fullReport?.steps || [];
    if (steps.length === 0) return;

    _activeTaskSteps = steps;
    _renderStepProgress(task, steps);

    // Auto-populate completed step artifacts
    for (const step of steps) {
      if (step.status === 'completed' && !_autoPopulatedSheets.has(step.step_name)) {
        _autoPopulatedSheets.add(step.step_name);
        await _autoPopulateStepArtifacts(step, fullReport.artifacts);
      }
    }

    // Stop polling when all steps are done
    const allDone = steps.every(s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped');
    if (allDone) {
      addChatMessage('system', `All ${steps.length} steps completed. Data sheets populated in Excel.`);
      stopStepProgressPolling();
    }
  } catch { /* silent polling failure */ }
}

function _renderStepProgress(task, steps) {
  let container = document.getElementById('step-progress-container');
  if (!container) {
    // Create the container dynamically
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
    container = document.createElement('div');
    container.id = 'step-progress-container';
    container.style.cssText = 'border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0;background:#fafbfc;';
    mainContent.insertBefore(container, mainContent.firstChild);
  }

  const completedCount = steps.filter(s => s.status === 'completed').length;
  const pct = Math.round((completedCount / steps.length) * 100);

  let html = `<div style="font-weight:bold;margin-bottom:8px;">Agent Task: ${task.title || 'Working...'}</div>`;
  html += `<div style="background:#e0e0e0;border-radius:4px;height:8px;margin-bottom:8px;"><div style="background:#2E75B6;height:100%;border-radius:4px;width:${pct}%;transition:width 0.3s;"></div></div>`;
  html += `<div style="font-size:11px;color:#666;margin-bottom:6px;">${completedCount}/${steps.length} steps (${pct}%)</div>`;

  for (const step of steps) {
    const icon = step.status === 'completed' ? '✅'
      : step.status === 'running' || step.status === 'in_progress' ? '🔄'
      : step.status === 'failed' ? '❌'
      : '⏳';
    const name = (step.step_name || '').replace(/_/g, ' ');
    const duration = step.duration_ms ? ` (${(step.duration_ms / 1000).toFixed(1)}s)` : '';
    html += `<div style="font-size:12px;padding:2px 0;"><span>${icon}</span> ${name}${duration}</div>`;
  }

  container.innerHTML = html;
  container.classList.remove('hidden');
}

function _hideStepProgress() {
  const container = document.getElementById('step-progress-container');
  if (container) container.classList.add('hidden');
}

async function _autoPopulateStepArtifacts(step, allArtifacts) {
  // Find artifacts for this step
  const stepArtifacts = allArtifacts?.[step.step_name] || [];
  if (!stepArtifacts.length) return;

  try {
    await Excel.run(async (context) => {
      const wb = context.workbook;
      const prefix = document.getElementById('pref-prefix')?.value || 'DI_';

      for (const artifact of stepArtifacts) {
        const data = artifact.data;
        if (!data) continue;

        const artType = (artifact.type || '').toLowerCase();
        const artLabel = artifact.label || artifact.type || step.step_name;

        // Determine sheet name
        const sheetName = `${prefix}${artLabel.replace(/[\\\/\*\?\[\]:]/g, '_').slice(0, 28)}`;

        // Create or get sheet
        let sheet = tryGetSheet(wb, sheetName);
        if (!sheet) sheet = wb.worksheets.add(sheetName);

        // ── KPI / Summary artifacts → Dashboard layout ──────────────────
        if (artType.includes('kpi') || artType.includes('summary') || artType === 'metrics') {
          if (typeof data === 'object' && !Array.isArray(data)) {
            writeKPIDashboard(sheet, data);
          } else if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
            // KPI rows (e.g. [{metric: "Revenue", value: 1234}, ...])
            const kpiObj = {};
            for (const row of data) {
              const key = row.metric || row.name || row.kpi || Object.values(row)[0];
              const val = row.value ?? row.amount ?? Object.values(row)[1];
              if (key) kpiObj[key] = val;
            }
            writeKPIDashboard(sheet, kpiObj);
          }
          await context.sync();
          continue;
        }

        // ── Tabular data → Excel Table with native features ─────────────
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
          const headers = Object.keys(data[0]);
          const rows = [headers];
          for (const row of data) {
            rows.push(headers.map(h => {
              const v = row[h];
              return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
            }));
          }

          // Use native Excel Table
          const tableName = `T_${step.step_name}_${artLabel}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
          writeAsExcelTable(sheet, rows, tableName);

          // Freeze header row for scrolling
          freezeHeaderRow(sheet);

          // Smart number formatting based on column names
          applySmartNumberFormatting(sheet, headers, 2, rows.length);

          // Conditional formatting on key numeric columns
          for (let c = 0; c < headers.length; c++) {
            const h = headers[c].toLowerCase();
            if (h.includes('score') || h.includes('risk') || h.includes('rate') ||
                h.includes('ratio') || h.includes('margin') || h.includes('percent')) {
              applyConditionalFormatting(sheet, c, 2, rows.length, 'color_scale');
            } else if (h.includes('revenue') || h.includes('sales') || h.includes('profit') ||
                       h.includes('amount') || h.includes('cost')) {
              applyConditionalFormatting(sheet, c, 2, rows.length, 'data_bar');
            }
          }

          // Auto-create chart if data has a good shape for visualization
          if (data.length >= 3 && data.length <= 50 && headers.length >= 2 && headers.length <= 8) {
            createChart(sheet, headers, data, artLabel);
          }

          await context.sync();
          continue;
        }

        // ── Key-value / nested object → formatted table ─────────────────
        if (typeof data === 'object' && !Array.isArray(data)) {
          const rows = [['Metric', 'Value']];
          for (const [k, v] of Object.entries(data)) {
            if (k === 'pdf_base64' || k === 'html' || k === 'image_base64') continue;
            rows.push([k, typeof v === 'object' ? JSON.stringify(v) : v]);
          }
          writeAsExcelTable(sheet, rows, `T_${step.step_name}_kv`.replace(/[^a-zA-Z0-9_]/g, '_'));
          await context.sync();
        }
      }

      await context.sync();
    });

    addChatMessage('system', `Step "${step.step_name}" → data written to Excel with charts & formatting.`);
  } catch (err) {
    console.warn('[taskpane] Auto-populate failed for', step.step_name, err.message);
  }
}

// ── Chat with AI ────────────────────────────────────────────────────────────
// Sends user questions to ai-proxy, with current report context.

let _chatHistory = [];
let _currentReportContext = null;

function addChatMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg chat-${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  if (role === 'user' || role === 'ai') {
    _chatHistory.push({ role: role === 'user' ? 'user' : 'assistant', content: text });
  }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  addChatMessage('user', message);

  // Check for "write to sheet" commands
  if (message.toLowerCase().includes('write to sheet') || message.toLowerCase().includes('to sheet')) {
    await handleSheetCommand(message);
    return;
  }

  setStatus('AI is thinking...');
  try {
    // Build context from current report data
    let contextStr = '';
    if (_selectedReportId && _currentReportContext) {
      const ctx = _currentReportContext;
      contextStr = `Current report: "${ctx.task?.title || ctx.task?.instruction || 'Untitled'}"
Status: ${ctx.task?.status || 'unknown'}
Steps: ${ctx.steps?.map(s => `${s.step_name}(${s.status})`).join(', ') || 'none'}
Reviews: ${ctx.reviews?.map(r => `${r.step_name}: score=${r.score}`).join(', ') || 'none'}
Artifacts: ${JSON.stringify(Object.keys(ctx.artifacts || {}))}\n\n`;
    }

    // Call ai-proxy via Edge Function
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_accessToken}`,
      },
      body: JSON.stringify({
        mode: 'anthropic_chat',
        payload: {
          message: message,
          systemPrompt: `You are a supply chain report assistant embedded in Excel. Help the user understand and work with their AI-generated reports. Be concise. If the user asks you to write data to a sheet, tell them to use the "To Sheet" quick action.\n\n${contextStr}`,
          model: 'claude-sonnet-4-6',
          temperature: 0.5,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!res.ok) throw new Error(`AI error (${res.status})`);
    const data = await res.json();
    const reply = data.text || data.content || 'No response.';
    addChatMessage('ai', reply);
    setStatus('Ready');
  } catch (err) {
    addChatMessage('ai', `Error: ${err.message}. Make sure ai-proxy Edge Function is deployed.`);
    setStatus('Chat error.');
  }
}

function quickChat(message) {
  document.getElementById('chat-input').value = message;
  sendChat();
}

async function handleSheetCommand(message) {
  // Parse target like "write to Sheet A1" or just write the last AI response
  const lastAiMsg = _chatHistory.filter(m => m.role === 'assistant').pop();
  if (!lastAiMsg) {
    addChatMessage('ai', 'Nothing to write yet. Ask me a question first.');
    return;
  }

  try {
    await Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange('A1');
      range.values = [[lastAiMsg.content]];
      range.format.autofitColumns();
      await context.sync();
    });
    addChatMessage('system', 'Written to active sheet cell A1.');
    setStatus('Data written to sheet.');
  } catch (err) {
    addChatMessage('ai', `Failed to write: ${err.message}`);
  }
}

// ── Enhanced pullSelectedReport with context caching ────────────────────────

const _originalPullSelectedReport = pullSelectedReport;
async function pullSelectedReportWithContext() {
  if (!_selectedReportId) {
    setStatus('Select a report first.');
    return;
  }

  setStatus('Fetching report data...');
  try {
    const data = await callReportApi('get_report', { task_id: _selectedReportId });
    _currentReportContext = data; // Cache for chat context
    await writeReportToExcel(data);
    addChatMessage('system', `Report loaded into Excel. You can now ask questions about it.`);
    setStatus('Report written to Excel.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// Override the original
pullSelectedReport = pullSelectedReportWithContext;

// ── Auto Mode: AI Employee drives Excel via command queue ─────────────────────
// Polls excel_ops_queue for pending operations and executes them via Office.js.
// This makes the AI Employee operate Excel like a real person — creating sheets,
// writing data, formatting cells, building charts in real time.

let _autoModeActive = false;
let _autoModeInterval = null;
let _autoModeOpsExecuted = 0;
let _autoModeOpsTotal = 0;
let _autoModeCurrentBatch = null;

function toggleAutoMode() {
  if (_autoModeActive) {
    stopAutoMode();
  } else {
    startAutoMode();
  }
}

function startAutoMode() {
  if (_autoModeActive) return;
  _autoModeActive = true;
  _autoModeOpsExecuted = 0;
  _autoModeOpsTotal = 0;

  _addAutoModeLog('info', 'Auto Mode started — polling for Excel operations...');
  setStatus('Auto Mode active');

  // Poll immediately, then every 2 seconds
  _pollExcelOps();
  _autoModeInterval = setInterval(_pollExcelOps, 2000);
}

function stopAutoMode() {
  _autoModeActive = false;
  if (_autoModeInterval) {
    clearInterval(_autoModeInterval);
    _autoModeInterval = null;
  }
  _addAutoModeLog('info', 'Auto Mode stopped.');
  setStatus('Auto Mode stopped.');
}

async function _pollExcelOps() {
  if (!_autoModeActive || !_accessToken) return;

  try {
    // Fetch pending ops from report-api
    const data = await callReportApi('get_excel_ops', { limit: 50 });
    const ops = data?.ops || [];

    if (ops.length === 0) return;

    _autoModeOpsTotal += ops.length;
    _addAutoModeLog('info', `Found ${ops.length} pending operation(s). Executing...`);

    // Group by batch_id for efficient execution
    const batches = {};
    for (const op of ops) {
      const bid = op.batch_id || 'default';
      if (!batches[bid]) batches[bid] = [];
      batches[bid].push(op);
    }

    for (const [batchId, batchOps] of Object.entries(batches)) {
      _autoModeCurrentBatch = batchId;
      _addAutoModeLog('batch', `Batch: ${batchId} (${batchOps.length} ops)`);

      // Sort by sequence
      batchOps.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

      // Execute in Excel.run()
      await _executeAutoModeOps(batchOps);

      // Report status back
      await _reportOpsStatus(batchOps);

      // Auto-save workbook after batch completes (if enabled in Settings)
      const autoSaveEnabled = document.getElementById('pref-autosave')?.checked;
      if (autoSaveEnabled) {
        await _autoSaveWorkbook();
      }

      // Auto-upload workbook as artifact if enabled in Settings
      const autoUploadEnabled = document.getElementById('pref-autoupload')?.checked;
      const taskId = batchOps[0]?.task_id;
      if (autoUploadEnabled && taskId) {
        await _uploadExcelArtifact(taskId, batchId);
      }
    }

    _autoModeCurrentBatch = null;

  } catch (err) {
    _addAutoModeLog('error', `Poll error: ${err.message}`);
  }
}

async function _executeAutoModeOps(ops) {
  await Excel.run(async (context) => {
    const wb = context.workbook;

    for (const cmd of ops) {
      // Skip markers
      if (cmd.op === 'batch_start') {
        const summary = cmd.payload?.summary || '';
        _addAutoModeLog('info', `Starting: ${summary}`);
        cmd._status = 'succeeded';
        _autoModeOpsExecuted++;
        _updateAutoModeProgress();
        continue;
      }
      if (cmd.op === 'batch_end') {
        const summary = cmd.payload?.summary || '';
        _addAutoModeLog('success', `Completed: ${summary}`);
        cmd._status = 'succeeded';
        _autoModeOpsExecuted++;
        _updateAutoModeProgress();
        continue;
      }

      try {
        _addAutoModeLog('op', `${cmd.op} → ${cmd.target_sheet || ''}${cmd.range_addr ? ':' + cmd.range_addr : ''}`);

        // Dispatch to the appropriate handler
        await _dispatchAutoModeOp(context, wb, cmd);
        cmd._status = 'succeeded';
      } catch (err) {
        cmd._status = 'failed';
        cmd._error = err.message;
        _addAutoModeLog('error', `Failed: ${cmd.op} — ${err.message}`);
      }

      _autoModeOpsExecuted++;
      _updateAutoModeProgress();
    }

    await context.sync();
  });
}

async function _dispatchAutoModeOp(context, wb, cmd) {
  const { op, target_sheet, range_addr, payload } = cmd;
  const p = payload || {};

  switch (op) {
    case 'create_sheet': {
      let sheet;
      try {
        sheet = wb.worksheets.getItemOrNullObject(target_sheet);
        await context.sync();
        if (sheet.isNullObject) sheet = wb.worksheets.add(target_sheet);
      } catch { sheet = wb.worksheets.add(target_sheet); }
      if (p.activate) sheet.activate();
      break;
    }

    case 'delete_sheet': {
      try {
        const sheet = wb.worksheets.getItem(target_sheet);
        sheet.delete();
      } catch { /* ok */ }
      break;
    }

    case 'write_values': {
      const sheet = wb.worksheets.getItem(target_sheet);
      const values = p.values;
      if (!values?.length) break;
      const maxCols = Math.max(...values.map(r => Array.isArray(r) ? r.length : 1));
      const padded = values.map(r => {
        const row = Array.isArray(r) ? [...r] : [r];
        while (row.length < maxCols) row.push('');
        return row;
      });
      const addr = range_addr || `A1:${colLetter(maxCols - 1)}${padded.length}`;
      const range = sheet.getRange(addr);
      range.values = padded;
      break;
    }

    case 'write_formula': {
      const sheet = wb.worksheets.getItem(target_sheet);
      const range = sheet.getRange(range_addr);
      range.formulas = [[p.formula]];
      break;
    }

    case 'write_formulas': {
      const sheet = wb.worksheets.getItem(target_sheet);
      const range = sheet.getRange(range_addr);
      range.formulas = p.formulas;
      break;
    }

    case 'format_cells': {
      const sheet = wb.worksheets.getItem(target_sheet);
      const range = sheet.getRange(range_addr);
      if (p.font) {
        if (p.font.bold !== undefined) range.format.font.bold = p.font.bold;
        if (p.font.size) range.format.font.size = p.font.size;
        if (p.font.color) range.format.font.color = p.font.color;
        if (p.font.name) range.format.font.name = p.font.name;
        if (p.font.italic !== undefined) range.format.font.italic = p.font.italic;
      }
      if (p.fill?.color) range.format.fill.color = p.fill.color;
      if (p.alignment?.horizontal) range.format.horizontalAlignment = p.alignment.horizontal;
      if (p.alignment?.vertical) range.format.verticalAlignment = p.alignment.vertical;
      if (p.numberFormat) range.numberFormat = [[p.numberFormat]];
      if (p.border?.bottom) {
        const edge = range.format.borders.getItem('EdgeBottom');
        edge.style = p.border.bottom.style || 'Thin';
        if (p.border.bottom.color) edge.color = p.border.bottom.color;
      }
      break;
    }

    case 'create_table': {
      const sheet = wb.worksheets.getItem(target_sheet);
      try {
        const safeName = (p.tableName || 'Table1').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
        const table = sheet.tables.add(range_addr, p.hasHeaders !== false);
        table.name = safeName;
        table.style = p.style || 'TableStyleMedium2';
        table.showFilterButton = true;
        const range = sheet.getRange(range_addr);
        range.format.autofitColumns();
        range.format.autofitRows();
      } catch (e) {
        // Fallback
        const range = sheet.getRange(range_addr);
        range.format.autofitColumns();
      }
      break;
    }

    case 'create_chart': {
      const sheet = wb.worksheets.getItem(target_sheet);
      const chartTypeMap = {
        line: Excel.ChartType.line,
        columnClustered: Excel.ChartType.columnClustered,
        barClustered: Excel.ChartType.barClustered,
        pie: Excel.ChartType.pie,
        area: Excel.ChartType.area,
      };
      const chartType = chartTypeMap[p.chartType] || Excel.ChartType.columnClustered;
      const chart = sheet.charts.add(chartType, sheet.getRange(range_addr), Excel.ChartSeriesBy.columns);
      chart.title.text = p.title || 'Chart';
      chart.title.format.font.size = 14;
      chart.title.format.font.bold = true;
      chart.width = p.width || 600;
      chart.height = p.height || 350;
      chart.legend.position = Excel.ChartLegendPosition.bottom;
      break;
    }

    case 'autofit_columns': {
      const sheet = wb.worksheets.getItem(target_sheet);
      sheet.getRange(range_addr || 'A:Z').format.autofitColumns();
      break;
    }

    case 'autofit_rows': {
      const sheet = wb.worksheets.getItem(target_sheet);
      sheet.getRange(range_addr || 'A:Z').format.autofitRows();
      break;
    }

    case 'merge_cells': {
      const sheet = wb.worksheets.getItem(target_sheet);
      sheet.getRange(range_addr).merge(true);
      break;
    }

    case 'conditional_format': {
      const sheet = wb.worksheets.getItem(target_sheet);
      const range = sheet.getRange(range_addr);
      if (p.type === 'color_scale') {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.colorScale);
        cf.colorScale.criteria = JSON.stringify({
          minimum: { type: 'lowestValue', color: '#F8696B' },
          midpoint: { type: 'percentile', value: 50, color: '#FFEB84' },
          maximum: { type: 'highestValue', color: '#63BE7B' },
        });
      } else if (p.type === 'data_bar') {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.dataBar);
        cf.dataBar.barDirection = Excel.ConditionalDataBarDirection.context;
      } else if (p.type === 'icon_set') {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.iconSet);
        cf.iconSet.style = Excel.IconSet.threeTrafficLights1;
      }
      break;
    }

    case 'freeze_panes': {
      const sheet = wb.worksheets.getItem(target_sheet);
      if (p.rows) sheet.freezePanes.freezeRows(p.rows);
      if (p.cols) sheet.freezePanes.freezeColumns(p.cols);
      break;
    }

    case 'set_column_width': {
      const sheet = wb.worksheets.getItem(target_sheet);
      sheet.getRange(range_addr).format.columnWidth = p.width;
      break;
    }

    case 'sort_range': {
      const sheet = wb.worksheets.getItem(target_sheet);
      sheet.getRange(range_addr).sort.apply([{
        key: p.colIndex || 0,
        ascending: p.ascending !== undefined ? p.ascending : false,
      }]);
      break;
    }

    case 'kpi_dashboard': {
      const sheet = wb.worksheets.getItem(target_sheet);
      writeKPIDashboard(sheet, p.kpis || {});
      break;
    }

    default:
      console.warn('[autoMode] Unknown op:', op);
  }
}

// ── Auto-save: save workbook after batch execution ─────────────────────────

async function _autoSaveWorkbook() {
  try {
    await Excel.run(async (context) => {
      context.workbook.save(Excel.SaveBehavior.save);
      await context.sync();
    });
    _addAutoModeLog('success', 'Workbook auto-saved.');
  } catch (err) {
    // Save may fail if file is new/untitled — that's OK
    _addAutoModeLog('info', `Auto-save skipped: ${err.message}`);
  }
}

// ── Auto-upload: export workbook as artifact to Supabase Storage ─────────
// Uses Office.js getFileAsync() to get the workbook binary, then uploads
// via report-api Edge Function → Supabase Storage. The agent loop workflow
// handles any downstream publishing (OpenCloud, etc.) as a separate step.

async function _uploadExcelArtifact(taskId, batchId) {
  try {
    _addAutoModeLog('info', 'Uploading workbook as artifact...');

    // Get workbook binary via Office.js
    const fileData = await _getWorkbookBinary();
    if (!fileData) {
      _addAutoModeLog('info', 'Workbook export not available in this environment.');
      return;
    }

    // Convert to base64 for JSON transport
    const base64 = _arrayBufferToBase64(fileData);

    // Upload via report-api → Supabase Storage
    const result = await callReportApi('upload_excel_artifact', {
      task_id: taskId,
      batch_id: batchId,
      filename: `MBR_${new Date().toISOString().slice(0, 10)}.xlsx`,
      content_base64: base64,
      content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    if (result?.artifact) {
      _addAutoModeLog('success', `Artifact saved: ${result.artifact.filename}`);
      if (result.artifact.publicUrl) {
        _addAutoModeLog('info', `URL: ${result.artifact.publicUrl}`);
      }
    } else {
      _addAutoModeLog('info', 'Artifact upload completed.');
    }
  } catch (err) {
    _addAutoModeLog('error', `Artifact upload failed: ${err.message}`);
    // Best-effort — don't break the flow
  }
}

function _getWorkbookBinary() {
  return new Promise((resolve) => {
    try {
      // Office.js getFileAsync returns the workbook as binary
      Office.context.document.getFileAsync(
        Office.FileType.Compressed,
        { sliceSize: 4 * 1024 * 1024 }, // 4MB slices
        (result) => {
          if (result.status !== Office.AsyncResultStatus.Succeeded) {
            resolve(null);
            return;
          }

          const file = result.value;
          const sliceCount = file.sliceCount;

          if (sliceCount === 0) {
            file.closeAsync();
            resolve(null);
            return;
          }

          // Read all slices and concatenate
          const slices = [];
          let slicesRead = 0;

          for (let i = 0; i < sliceCount; i++) {
            file.getSliceAsync(i, (sliceResult) => {
              if (sliceResult.status === Office.AsyncResultStatus.Succeeded) {
                slices[i] = sliceResult.value.data;
              }
              slicesRead++;

              if (slicesRead === sliceCount) {
                file.closeAsync();
                // Concatenate all slices into one ArrayBuffer
                const totalSize = slices.reduce((s, slice) => s + (slice?.byteLength || 0), 0);
                const combined = new Uint8Array(totalSize);
                let offset = 0;
                for (const slice of slices) {
                  if (slice) {
                    combined.set(new Uint8Array(slice), offset);
                    offset += slice.byteLength;
                  }
                }
                resolve(combined.buffer);
              }
            });
          }
        }
      );
    } catch {
      resolve(null);
    }
  });
}

function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function _reportOpsStatus(ops) {
  try {
    const updates = ops.map(op => ({
      id: op.id,
      status: op._status || 'succeeded',
      error: op._error || null,
      executed_at: new Date().toISOString(),
    }));
    await callReportApi('update_excel_ops', { updates });
  } catch (err) {
    console.warn('[autoMode] Status report failed:', err.message);
  }
}

function _addAutoModeLog(level, message) {
  const container = document.getElementById('automode-log');
  if (!container) return;

  const colors = {
    info: 'var(--text-muted)',
    success: 'var(--success)',
    error: 'var(--danger)',
    op: 'var(--primary)',
    batch: 'var(--warning)',
  };

  const icons = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    op: '⚙️',
    batch: '📦',
  };

  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.style.cssText = `padding:2px 0;color:${colors[level] || 'inherit'};`;
  div.textContent = `${time} ${icons[level] || ''} ${message}`;

  // Remove placeholder
  if (container.children.length === 1 && container.children[0].textContent.includes('No operations')) {
    container.innerHTML = '';
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function _updateAutoModeProgress() {
  const bar = document.getElementById('automode-progress-bar');
  const text = document.getElementById('automode-progress-text');
  if (bar) bar.style.width = _autoModeOpsTotal > 0 ? `${Math.round((_autoModeOpsExecuted / _autoModeOpsTotal) * 100)}%` : '0%';
  if (text) text.textContent = `${_autoModeOpsExecuted} / ${_autoModeOpsTotal}`;

  // Update status bar ops count
  const opsCount = document.getElementById('ops-count');
  if (opsCount) opsCount.textContent = `${_autoModeOpsExecuted} ops`;
}

// ── MBR Analysis ─────────────────────────────────────────────────────────────
// Reads active worksheet data → calls ML API /agent/run → writes 9 MBR sheets
// directly via Office.js (no Supabase queue needed — Add-in has direct access).

const ML_API_URL = 'http://localhost:8000';

let _mbrRunning = false;

/**
 * Read worksheet data from the active workbook via Office.js.
 * Returns { sheets: { sheetName: [{col: val, ...}, ...] } }
 */
async function _readWorksheetData(source) {
  return Excel.run(async (context) => {
    const wb = context.workbook;
    const sheets = {};

    if (source === 'all') {
      const worksheets = wb.worksheets;
      worksheets.load('items/name');
      await context.sync();

      for (const ws of worksheets.items) {
        const data = await _readSingleSheet(context, ws);
        if (data.length > 0) sheets[ws.name] = data;
      }
    } else {
      const activeSheet = wb.worksheets.getActiveWorksheet();
      activeSheet.load('name');
      await context.sync();

      const data = await _readSingleSheet(context, activeSheet);
      if (data.length > 0) sheets[activeSheet.name] = data;
    }

    return { sheets };
  });
}

async function _readSingleSheet(context, worksheet) {
  const usedRange = worksheet.getUsedRangeOrNullObject(true);
  usedRange.load('values');
  await context.sync();

  if (usedRange.isNullObject) return [];

  const values = usedRange.values;
  if (!values || values.length < 2) return [];

  // First row = headers, rest = data rows → array of objects
  const headers = values[0].map((h, i) => (h != null && h !== '') ? String(h) : `Column_${i + 1}`);
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = values[r][c] != null ? values[r][c] : '';
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Main MBR analysis flow: read data → agent/run → write results to Excel.
 */
async function runMbrAnalysis() {
  if (_mbrRunning) return;
  _mbrRunning = true;

  const btn = document.getElementById('mbr-run-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing...';

  const progressCard = document.getElementById('mbr-progress');
  const resultCard = document.getElementById('mbr-result');
  progressCard.classList.remove('hidden');
  resultCard.classList.add('hidden');
  _updateMbrStep(0, 'pending');
  setStatus('MBR: Reading worksheet data...');

  try {
    // 1. Read data from Excel
    const source = document.getElementById('mbr-source').value;
    const inputData = await _readWorksheetData(source);
    const sheetNames = Object.keys(inputData.sheets);

    if (sheetNames.length === 0) {
      throw new Error('No data found in the worksheet. Please ensure the active sheet has data with headers in row 1.');
    }

    const totalRows = Object.values(inputData.sheets).reduce((s, rows) => s + rows.length, 0);
    _addMbrLog(`Read ${totalRows} rows from ${sheetNames.length} sheet(s): ${sheetNames.join(', ')}`);
    setStatus(`MBR: Read ${totalRows} rows. Sending to AI agent...`);

    // 2. Call ML API /agent/mbr-analysis (convenience endpoint with pre-configured steps)
    const customPrompt = document.getElementById('mbr-prompt').value.trim();
    const taskId = `mbr_excel_${Date.now()}`;
    _updateMbrStep(0, 'running');

    const agentRes = await fetch(`${ML_API_URL}/agent/mbr-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: taskId,
        input_data: inputData,
        focus: customPrompt,
        max_retries: 2,
      }),
    });

    if (!agentRes.ok) {
      const errBody = await agentRes.text();
      throw new Error(`Agent API error (${agentRes.status}): ${errBody.slice(0, 200)}`);
    }

    const result = await agentRes.json();

    // 4. Update progress from step results
    const stepResults = result.step_results || [];
    for (let i = 0; i < stepResults.length; i++) {
      _updateMbrStep(i, stepResults[i].status === 'succeeded' ? 'done' : 'failed');
    }

    const succeeded = stepResults.filter(s => s.status === 'succeeded').length;
    if (succeeded === 0) {
      throw new Error('All analysis steps failed. Check ML API logs for details.');
    }

    _addMbrLog(`Agent completed: ${succeeded}/${stepResults.length} steps succeeded`);
    setStatus(`MBR: Writing results to Excel (${succeeded} steps)...`);

    // 5. Write results back to Excel as 9 MBR sheets
    await _writeMbrResults(stepResults);

    // 6. Show success
    _showMbrResult(true, stepResults, result.total_execution_ms);
    setStatus('MBR Analysis complete!');

  } catch (err) {
    _showMbrResult(false, [], 0, err.message);
    setStatus(`MBR Error: ${err.message}`);
  } finally {
    _mbrRunning = false;
    btn.disabled = false;
    btn.textContent = 'Run MBR Analysis';
  }
}

/**
 * Write agent loop artifacts directly into Excel as 9 MBR sheets.
 */
async function _writeMbrResults(stepResults) {
  await Excel.run(async (context) => {
    const wb = context.workbook;
    const period = new Date().toISOString().slice(0, 7);
    const title = `Monthly Business Review — ${period}`;

    // Collect artifacts from all steps
    const allArtifacts = {};
    for (const sr of stepResults) {
      if (sr.status !== 'succeeded') continue;
      allArtifacts[sr.step_name] = sr.artifacts || [];
    }

    // Helper: find artifact data by keyword match
    function findData(keywords) {
      for (const arts of Object.values(allArtifacts)) {
        for (const art of arts) {
          const type = (art.type || '').toLowerCase();
          const label = (art.label || '').toLowerCase();
          for (const kw of keywords) {
            if (type.includes(kw) || label.includes(kw)) {
              return art.data || art.content || null;
            }
          }
        }
      }
      return null;
    }

    // Helper: extract KPIs
    function extractKPIs() {
      const kpis = {};
      for (const arts of Object.values(allArtifacts)) {
        for (const art of arts) {
          const t = (art.type || '').toLowerCase();
          const d = art.data || art.content;
          if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
          if (t.includes('kpi') || t.includes('metric') || (art.label || '').toLowerCase().includes('kpi')) {
            Object.assign(kpis, d);
          }
        }
      }
      return kpis;
    }

    // Helper: create or get sheet
    async function getOrCreateSheet(name) {
      let sheet;
      try {
        sheet = wb.worksheets.getItemOrNullObject(name);
        await context.sync();
        if (sheet.isNullObject) {
          sheet = wb.worksheets.add(name);
        } else {
          sheet.getRange().clear();
        }
      } catch {
        sheet = wb.worksheets.add(name);
      }
      return sheet;
    }

    // Helper: write array-of-objects as table
    async function writeDataTable(sheetName, data, tableName, chartConfig) {
      if (!Array.isArray(data) || data.length === 0) return;
      const sheet = await getOrCreateSheet(sheetName);
      const headers = Object.keys(data[0]);
      const values = [headers];
      for (const row of data) {
        values.push(headers.map(h => {
          const v = row[h];
          if (v == null) return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        }));
      }
      const endCol = colLetter(headers.length - 1);
      const range = `A1:${endCol}${values.length}`;
      sheet.getRange(range).values = values;

      // Format header
      const headerRange = sheet.getRange(`A1:${endCol}1`);
      headerRange.format.font.bold = true;
      headerRange.format.fill.color = '#E2E8F0';
      headerRange.format.autofitColumns();

      // Create table
      try {
        const safeName = (tableName || 'Table1').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
        const table = sheet.tables.add(range, true);
        table.name = safeName;
        table.style = 'TableStyleMedium2';
      } catch { /* table creation can fail if name collision */ }

      sheet.getRange(`A:${endCol}`).format.autofitColumns();

      // Optional chart
      if (chartConfig && data.length >= 3 && data.length <= 50) {
        try {
          const chartTypeMap = {
            line: Excel.ChartType.line,
            bar: Excel.ChartType.barClustered,
            column: Excel.ChartType.columnClustered,
          };
          const ct = chartTypeMap[chartConfig.type] || Excel.ChartType.columnClustered;
          const chart = sheet.charts.add(ct, sheet.getRange(range), Excel.ChartSeriesBy.columns);
          chart.title.text = chartConfig.title || sheetName;
          chart.width = 600;
          chart.height = 350;
        } catch { /* chart creation best-effort */ }
      }
    }

    // ── Sheet 1: Cover ──
    {
      const sheet = await getOrCreateSheet('MBR_Cover');
      sheet.getRange('A1:F1').values = [[title, '', '', '', '', '']];
      sheet.getRange('A1:F1').merge(true);
      sheet.getRange('A1:F1').format.font.size = 24;
      sheet.getRange('A1:F1').format.font.bold = true;
      sheet.getRange('A1:F1').format.font.color = '#1F4E79';
      sheet.getRange('A1:F1').format.horizontalAlignment = 'Center';

      sheet.getRange('A2:F2').values = [[`Generated: ${new Date().toLocaleString()}`, '', '', '', '', '']];
      sheet.getRange('A2:F2').merge(true);
      sheet.getRange('A2:F2').format.font.size = 10;
      sheet.getRange('A2:F2').format.font.color = '#888888';
      sheet.getRange('A2:F2').format.horizontalAlignment = 'Center';

      const toc = [
        ['Sheet', 'Description'],
        ['MBR_KPIs', 'Key Performance Indicators'],
        ['MBR_Cleaned_Data', 'Cleaned & standardized dataset'],
        ['MBR_Data_Issues', 'Data quality issues log'],
        ['MBR_Analysis', 'Pivot analysis & insights'],
        ['MBR_Dashboard', 'One-page management dashboard'],
      ];
      sheet.getRange(`A4:B${4 + toc.length - 1}`).values = toc;
      sheet.getRange('A4:B4').format.font.bold = true;
      sheet.getRange('A4:B4').format.fill.color = '#E2E8F0';
      sheet.getRange('A:F').format.autofitColumns();
      sheet.activate();
    }

    // ── Sheet 2: KPIs ──
    {
      const kpis = extractKPIs();
      const sheet = await getOrCreateSheet('MBR_KPIs');
      const entries = Object.entries(kpis);
      if (entries.length > 0) {
        writeKPIDashboard(sheet, kpis);
      } else {
        sheet.getRange('A1').values = [['KPI data will be populated by the analysis.']];
      }
    }

    // ── Sheet 3: Cleaned Data ──
    {
      const data = findData(['cleaned', 'clean', 'standardized']);
      await writeDataTable('MBR_Cleaned_Data', data, 'T_CleanedData');
      if (!data || !Array.isArray(data) || data.length === 0) {
        const sheet = await getOrCreateSheet('MBR_Cleaned_Data');
        sheet.getRange('A1').values = [['Cleaned data not available.']];
      }
    }

    // ── Sheet 4: Data Issues ──
    {
      const data = findData(['issue', 'quality', 'log', 'problem']);
      await writeDataTable('MBR_Data_Issues', data, 'T_DataIssues');
      if (!data || !Array.isArray(data) || data.length === 0) {
        const sheet = await getOrCreateSheet('MBR_Data_Issues');
        sheet.getRange('A1:C1').values = [['Issue', 'Description', 'Resolution']];
        sheet.getRange('A1:C1').format.font.bold = true;
      }
    }

    // ── Sheet 5: Analysis (Pivots + Insights) ──
    {
      const pivotData = findData(['pivot', 'analysis', 'summary', 'breakdown']);
      const insights = findData(['insight', 'observation', 'finding']);
      const sheet = await getOrCreateSheet('MBR_Analysis');

      let row = 1;

      // Write pivot/analysis data if available
      if (Array.isArray(pivotData) && pivotData.length > 0) {
        const headers = Object.keys(pivotData[0]);
        const vals = [headers, ...pivotData.map(r => headers.map(h => {
          const v = r[h];
          return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
        }))];
        const endCol = colLetter(headers.length - 1);
        sheet.getRange(`A1:${endCol}${vals.length}`).values = vals;
        sheet.getRange(`A1:${endCol}1`).format.font.bold = true;
        sheet.getRange(`A1:${endCol}1`).format.fill.color = '#E2E8F0';
        row = vals.length + 2;
      }

      // Write insights
      const insightList = Array.isArray(insights) ? insights : [];
      if (insightList.length > 0) {
        sheet.getRange(`A${row}`).values = [['Management Insights']];
        sheet.getRange(`A${row}`).format.font.size = 14;
        sheet.getRange(`A${row}`).format.font.bold = true;
        row++;
        for (let i = 0; i < insightList.length; i++) {
          const text = typeof insightList[i] === 'string' ? insightList[i] : JSON.stringify(insightList[i]);
          sheet.getRange(`A${row + i}`).values = [[`${i + 1}. ${text}`]];
        }
      }

      sheet.getRange('A:H').format.autofitColumns();
    }

    // ── Sheet 6: Dashboard ──
    {
      const kpis = extractKPIs();
      const sheet = await getOrCreateSheet('MBR_Dashboard');

      // Title
      sheet.getRange('A1:H1').values = [[title, '', '', '', '', '', '', '']];
      sheet.getRange('A1:H1').merge(true);
      sheet.getRange('A1:H1').format.font.size = 20;
      sheet.getRange('A1:H1').format.font.bold = true;
      sheet.getRange('A1:H1').format.font.color = '#1F4E79';
      sheet.getRange('A1:H1').format.horizontalAlignment = 'Center';
      sheet.getRange('A1:H1').format.fill.color = '#F2F7FB';

      // KPI cards row
      const kpiEntries = Object.entries(kpis).slice(0, 8);
      if (kpiEntries.length > 0) {
        const labels = kpiEntries.map(([k]) => k);
        const vals = kpiEntries.map(([, v]) => v);
        const endCol = colLetter(kpiEntries.length - 1);
        sheet.getRange(`A3:${endCol}3`).values = [labels];
        sheet.getRange(`A4:${endCol}4`).values = [vals];
        sheet.getRange(`A3:${endCol}3`).format.font.size = 9;
        sheet.getRange(`A3:${endCol}3`).format.font.bold = true;
        sheet.getRange(`A3:${endCol}3`).format.font.color = '#666666';
        sheet.getRange(`A4:${endCol}4`).format.font.size = 18;
        sheet.getRange(`A4:${endCol}4`).format.font.bold = true;
        sheet.getRange(`A4:${endCol}4`).format.font.color = '#1F4E79';
      }

      // Insights section
      const insights = findData(['insight', 'observation', 'finding']);
      const insightList = Array.isArray(insights) ? insights : [];
      sheet.getRange('A7:H7').values = [['Key Observations & Management Insights', '', '', '', '', '', '', '']];
      sheet.getRange('A7:H7').merge(true);
      sheet.getRange('A7:H7').format.font.size = 14;
      sheet.getRange('A7:H7').format.font.bold = true;
      sheet.getRange('A7:H7').format.font.color = '#1F4E79';

      for (let i = 0; i < Math.min(insightList.length, 5); i++) {
        const text = typeof insightList[i] === 'string' ? insightList[i] : JSON.stringify(insightList[i]);
        sheet.getRange(`A${8 + i}:H${8 + i}`).values = [[`${i + 1}. ${text}`, '', '', '', '', '', '', '']];
        sheet.getRange(`A${8 + i}:H${8 + i}`).merge(true);
      }

      sheet.getRange('A:H').format.autofitColumns();
    }

    await context.sync();
    _addMbrLog('All MBR sheets written to workbook.');
  });
}

// ── MBR UI helpers ──

function _updateMbrStep(stepIndex, status) {
  const container = document.getElementById('mbr-steps');
  if (!container) return;

  const stepNames = ['Clean Data', 'Calculate KPIs', 'Pivot Analysis'];
  const icons = { pending: '\u25CB', running: '\u25D4', done: '\u2713', failed: '\u2717' };
  const colors = { pending: 'var(--text-muted)', running: 'var(--primary)', done: 'var(--success)', failed: 'var(--danger)' };

  // Rebuild all steps
  let html = '';
  for (let i = 0; i < stepNames.length; i++) {
    const st = i < stepIndex ? 'done' : i === stepIndex ? status : 'pending';
    html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;color:${colors[st]};">
      <span style="font-size:14px;">${icons[st]}</span>
      <span>Step ${i + 1}: ${stepNames[i]}</span>
      ${st === 'running' ? '<span class="spinner" style="margin-left:auto;"></span>' : ''}
    </div>`;
  }
  container.innerHTML = html;

  // Update progress bar
  const completed = stepIndex + (status === 'done' || status === 'failed' ? 1 : 0);
  const pct = Math.round((completed / stepNames.length) * 100);
  const bar = document.getElementById('mbr-progress-bar');
  const text = document.getElementById('mbr-progress-text');
  if (bar) bar.style.width = `${pct}%`;
  if (text) text.textContent = `${completed} / ${stepNames.length} steps`;
}

function _showMbrResult(success, stepResults, totalMs, errorMsg) {
  const card = document.getElementById('mbr-result');
  const titleEl = document.getElementById('mbr-result-title');
  const bodyEl = document.getElementById('mbr-result-body');
  card.classList.remove('hidden');

  if (success) {
    titleEl.textContent = 'Analysis Complete';
    titleEl.style.color = 'var(--success)';

    const totalArtifacts = stepResults.reduce((s, r) => s + (r.artifacts?.length || 0), 0);
    const secs = totalMs ? `${(totalMs / 1000).toFixed(1)}s` : '';
    bodyEl.innerHTML = `
      <div style="margin-bottom:6px;"><strong>${stepResults.filter(s => s.status === 'succeeded').length}</strong> steps completed, <strong>${totalArtifacts}</strong> artifacts generated ${secs ? `in ${secs}` : ''}</div>
      <div style="color:var(--text-muted);">Results written to MBR_Cover, MBR_KPIs, MBR_Cleaned_Data, MBR_Data_Issues, MBR_Analysis, MBR_Dashboard sheets.</div>
    `;
  } else {
    titleEl.textContent = 'Analysis Failed';
    titleEl.style.color = 'var(--danger)';
    bodyEl.innerHTML = `<div style="color:var(--danger);">${escHtml(errorMsg || 'Unknown error')}</div>`;
  }
}

function _addMbrLog(msg) {
  console.log(`[MBR] ${msg}`);
}

// ── Expose to global scope (for onclick handlers in HTML) ───────────────────

window.doLogin = doLogin;
window.doLogout = doLogout;
window.sendChat = sendChat;
window.quickChat = quickChat;

// Legacy exports (kept for backward compat, no longer in UI)
window.loadReports = loadReports;
window.selectReport = selectReport;
window.pullSelectedReport = typeof pullSelectedReportWithContext !== 'undefined' ? pullSelectedReportWithContext : function(){};
window.loadKPIs = typeof loadKPIs !== 'undefined' ? loadKPIs : function(){};
window.pullKPIsToSheet = typeof pullKPIsToSheet !== 'undefined' ? pullKPIsToSheet : function(){};
window.loadMonthly = typeof loadMonthly !== 'undefined' ? loadMonthly : function(){};
window.pullMonthlyToSheet = typeof pullMonthlyToSheet !== 'undefined' ? pullMonthlyToSheet : function(){};
window.switchTab = typeof switchTab !== 'undefined' ? switchTab : function(){};
window.toggleAutoMode = toggleAutoMode;
window.runMbrAnalysis = typeof runMbrAnalysis !== 'undefined' ? runMbrAnalysis : function(){};
