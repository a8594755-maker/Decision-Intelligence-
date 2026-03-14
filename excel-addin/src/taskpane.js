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
  document.getElementById('settings-url').textContent = SUPABASE_URL;
  document.getElementById('settings-user').textContent = _userEmail;

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
  const bar = document.getElementById('status-bar');
  if (bar) bar.textContent = msg;
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

// ── Expose to global scope (for onclick handlers in HTML) ───────────────────

window.doLogin = doLogin;
window.doLogout = doLogout;
window.loadReports = loadReports;
window.selectReport = selectReport;
window.pullSelectedReport = pullSelectedReportWithContext;
window.loadKPIs = loadKPIs;
window.pullKPIsToSheet = pullKPIsToSheet;
window.loadMonthly = loadMonthly;
window.pullMonthlyToSheet = pullMonthlyToSheet;
window.switchTab = switchTab;
window.sendChat = sendChat;
window.quickChat = quickChat;
