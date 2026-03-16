/**
 * Style Extraction Service
 *
 * Extracts style fingerprints from Excel files and documents.
 * Uses programmatic parsing (SheetJS) for 90% of features,
 * LLM only for text tone/wording analysis.
 *
 * Pipeline: File → Parse → Extract Features → Style Fingerprint JSON
 */
import * as XLSX from 'xlsx';

// ─── Constants ───────────────────────────────────────────────
const MAX_TEXT_SAMPLE_CHARS = 2000;  // max text sent to LLM for tone analysis
const MAX_SAMPLE_ROWS = 50;

// ─── Main Entry ──────────────────────────────────────────────

/**
 * Extract a complete style fingerprint from an Excel workbook buffer.
 * @param {ArrayBuffer|Uint8Array} fileBuffer - raw file bytes
 * @param {string} filename - original filename
 * @param {object} [opts] - options
 * @param {Function} [opts.llmFn] - async (prompt) => string, for text style analysis
 * @returns {StyleFingerprint}
 */
export function extractStyleFromExcel(fileBuffer, filename, _opts = {}) {
  const wb = XLSX.read(fileBuffer, { type: 'array', cellStyles: true, cellDates: true });

  const structure = extractStructure(wb);
  const formatting = extractFormatting(wb);
  const charts = extractCharts(wb);
  const kpiLayout = extractKpiLayout(wb);
  const textSamples = extractTextSamples(wb);

  return {
    source_file: filename,
    extracted_at: new Date().toISOString(),
    structure,
    formatting,
    charts,
    kpi_layout: kpiLayout,
    text_samples: textSamples,  // raw samples; text_style populated async via enrichTextStyle()
    text_style: null,
  };
}

/**
 * Enrich a fingerprint with LLM-based text style analysis.
 * Separated so bulk extraction can batch LLM calls.
 * @param {StyleFingerprint} fingerprint
 * @param {Function} llmFn - async (prompt) => string
 * @returns {StyleFingerprint} mutated fingerprint with text_style populated
 */
export async function enrichTextStyle(fingerprint, llmFn) {
  if (!llmFn || !fingerprint.text_samples?.length) {
    fingerprint.text_style = buildFallbackTextStyle(fingerprint.text_samples);
    return fingerprint;
  }

  const sampleText = fingerprint.text_samples.join('\n---\n').slice(0, MAX_TEXT_SAMPLE_CHARS);

  const prompt = `Analyze the writing style of the following text samples extracted from a business document.
Return a JSON object with these fields:
- language: primary language code (e.g. "zh-TW", "en", "mixed")
- tone: one of "formal_business", "casual_business", "technical", "executive_summary"
- bullet_style: one of "dash", "dot", "number", "none"
- kpi_naming: describe naming convention for KPIs (e.g. "Chinese name + English abbreviation")
- sample_phrases: array of 3-5 characteristic phrases that represent this style
- avg_sentence_length: "short" (<15 words), "medium" (15-30), "long" (>30)
- uses_headers: boolean

Text samples:
${sampleText}

Respond ONLY with valid JSON.`;

  try {
    const raw = await llmFn(prompt);
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    fingerprint.text_style = {
      language: parsed.language || 'unknown',
      tone: parsed.tone || 'formal_business',
      bullet_style: parsed.bullet_style || 'none',
      kpi_naming: parsed.kpi_naming || '',
      sample_phrases: parsed.sample_phrases || [],
      avg_sentence_length: parsed.avg_sentence_length || 'medium',
      uses_headers: parsed.uses_headers ?? true,
    };
  } catch {
    fingerprint.text_style = buildFallbackTextStyle(fingerprint.text_samples);
  }

  return fingerprint;
}

// ─── Structure Extraction ────────────────────────────────────

function extractStructure(wb) {
  const sheetNames = wb.SheetNames || [];
  return {
    sheet_count: sheetNames.length,
    sheet_names: sheetNames,
    has_cover_sheet: sheetNames.some(n => /cover|封面|首頁/i.test(n)),
    has_dashboard_sheet: sheetNames.some(n => /dashboard|儀表|總覽|summary/i.test(n)),
    has_data_sheet: sheetNames.some(n => /data|資料|cleaned/i.test(n)),
    has_chart_sheet: sheetNames.some(n => /chart|圖表/i.test(n)),
    sheet_row_counts: sheetNames.reduce((acc, name) => {
      const ws = wb.Sheets[name];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      acc[name] = range.e.r - range.s.r + 1;
      return acc;
    }, {}),
  };
}

// ─── Formatting Extraction ───────────────────────────────────

function extractFormatting(wb) {
  const result = {
    header_bg_colors: [],
    header_font_colors: [],
    header_fonts: [],
    number_formats: new Set(),
    has_alternating_rows: false,
    alternating_colors: [],
    merge_cell_count: 0,
    has_freeze_panes: false,
  };

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;

    // Merge cells
    if (ws['!merges']?.length) {
      result.merge_cell_count += ws['!merges'].length;
    }

    // Freeze panes
    if (ws['!freeze'] || ws['!pane']) {
      result.has_freeze_panes = true;
    }

    // Scan first row for header styles
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    if (!range) continue;

    for (let c = range.s.c; c <= Math.min(range.e.c, 25); c++) {
      const addr = XLSX.utils.encode_cell({ r: range.s.r, c });
      const cell = ws[addr];
      if (!cell) continue;

      // Cell style (if available)
      if (cell.s) {
        if (cell.s.fgColor?.rgb) result.header_bg_colors.push('#' + cell.s.fgColor.rgb);
        if (cell.s.color?.rgb) result.header_font_colors.push('#' + cell.s.color.rgb);
        if (cell.s.font?.name) result.header_fonts.push(cell.s.font.name);
      }

      // Number format
      if (cell.z) result.number_formats.add(cell.z);
    }

    // Check for alternating row colors (rows 2-6)
    const rowColors = [];
    for (let r = range.s.r + 1; r <= Math.min(range.s.r + 6, range.e.r); r++) {
      const addr = XLSX.utils.encode_cell({ r, c: range.s.c });
      const cell = ws[addr];
      if (cell?.s?.fgColor?.rgb) rowColors.push(cell.s.fgColor.rgb);
    }
    if (rowColors.length >= 4) {
      const unique = [...new Set(rowColors)];
      if (unique.length === 2) {
        result.has_alternating_rows = true;
        result.alternating_colors = unique.map(c => '#' + c);
      }
    }
  }

  return {
    header_bg_color: mostCommon(result.header_bg_colors) || null,
    header_font_color: mostCommon(result.header_font_colors) || null,
    header_font: mostCommon(result.header_fonts) || null,
    number_formats: [...result.number_formats].slice(0, 10),
    has_alternating_rows: result.has_alternating_rows,
    alternating_colors: result.alternating_colors,
    merge_cell_count: result.merge_cell_count,
    has_freeze_panes: result.has_freeze_panes,
  };
}

// ─── Chart Extraction ────────────────────────────────────────

function extractCharts(wb) {
  // SheetJS community edition has limited chart support.
  // We extract what we can from sheet structure (chart sheets, named ranges).
  const chartSheets = (wb.SheetNames || []).filter(n => /chart|圖/i.test(n));

  return {
    chart_sheet_count: chartSheets.length,
    chart_sheet_names: chartSheets,
    // Deeper chart extraction requires xlsx-chart or openpyxl on server side.
    // Placeholder for enrichment via Python backend.
    preferred_types: [],
    color_palette: [],
    has_data_labels: null,
  };
}

// ─── KPI Layout Extraction ───────────────────────────────────

function extractKpiLayout(wb) {
  const kpiPatterns = {
    position: null,
    style: null,
    conditional_format: null,
    kpi_keywords_found: [],
  };

  const KPI_KEYWORDS = [
    'kpi', 'metric', 'target', 'actual', 'variance', 'ytd', 'mtd',
    '指標', '目標', '實際', '達成率', '差異', '累計',
    'mape', 'service_level', 'ito', 'otd', 'fill_rate',
  ];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;

    const range = XLSX.utils.decode_range(ws['!ref']);
    const scanRows = Math.min(range.e.r, 20);
    const scanCols = Math.min(range.e.c, 15);

    for (let r = range.s.r; r <= scanRows; r++) {
      for (let c = range.s.c; c <= scanCols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell?.v) continue;
        const val = String(cell.v).toLowerCase();
        for (const kw of KPI_KEYWORDS) {
          if (val.includes(kw) && !kpiPatterns.kpi_keywords_found.includes(kw)) {
            kpiPatterns.kpi_keywords_found.push(kw);
          }
        }
      }
    }

    // Detect KPI position (top of sheet if KPIs found in first 5 rows)
    if (/kpi|dashboard|儀表|指標/i.test(name)) {
      kpiPatterns.position = 'dedicated_sheet';
      kpiPatterns.style = detectKpiStyle(ws, range);
    }
  }

  if (!kpiPatterns.position && kpiPatterns.kpi_keywords_found.length > 0) {
    kpiPatterns.position = 'inline';
  }

  return kpiPatterns;
}

function detectKpiStyle(ws, range) {
  // Heuristic: if merge cells in first 3 rows → card_grid style
  const merges = ws['!merges'] || [];
  const topMerges = merges.filter(m => m.s.r <= 3);
  if (topMerges.length >= 3) return 'card_grid';

  // If first row has many columns filled → table_row
  let firstRowFilled = 0;
  for (let c = range.s.c; c <= Math.min(range.e.c, 10); c++) {
    if (ws[XLSX.utils.encode_cell({ r: 0, c })]?.v) firstRowFilled++;
  }
  if (firstRowFilled >= 4) return 'table_row';

  return 'header_band';
}

// ─── Text Sample Extraction ─────────────────────────────────

function extractTextSamples(wb) {
  const samples = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);

    for (let r = range.s.r; r <= Math.min(range.e.r, MAX_SAMPLE_ROWS); r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, 15); c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell?.v || cell.t !== 's') continue; // only string cells
        const val = String(cell.v).trim();
        // Only collect meaningful text (>10 chars, not just numbers/dates)
        if (val.length > 10 && !/^\d+[\d.,/%\s]*$/.test(val)) {
          samples.push(val);
        }
      }
    }
  }

  // Deduplicate and limit
  return [...new Set(samples)].slice(0, 50);
}

// ─── Batch Processing ────────────────────────────────────────

/**
 * Process multiple files in batch, returning fingerprints.
 * @param {Array<{buffer: ArrayBuffer, filename: string}>} files
 * @param {object} [opts]
 * @param {Function} [opts.llmFn]
 * @param {Function} [opts.onProgress] - (processed, total) => void
 * @returns {Array<StyleFingerprint>}
 */
export async function extractStyleBatch(files, opts = {}) {
  const results = [];
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    try {
      const fp = extractStyleFromExcel(files[i].buffer, files[i].filename, opts);
      results.push(fp);
    } catch (err) {
      errors.push({ filename: files[i].filename, error: err.message });
    }
    opts.onProgress?.(i + 1, files.length);
  }

  // Batch LLM enrichment (collect all, send in parallel batches of 5)
  if (opts.llmFn) {
    const BATCH_SIZE = 5;
    for (let i = 0; i < results.length; i += BATCH_SIZE) {
      const batch = results.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(fp => enrichTextStyle(fp, opts.llmFn)));
    }
  }

  return { fingerprints: results, errors };
}

// ─── Helpers ─────────────────────────────────────────────────

function mostCommon(arr) {
  if (!arr.length) return null;
  const freq = {};
  for (const v of arr) freq[v] = (freq[v] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

function buildFallbackTextStyle(samples = []) {
  if (!samples.length) return { language: 'unknown', tone: 'formal_business' };

  const allText = samples.join(' ');
  const hasChinese = /[\u4e00-\u9fff]/.test(allText);
  const hasEnglish = /[a-zA-Z]{3,}/.test(allText);

  return {
    language: hasChinese && hasEnglish ? 'mixed' : hasChinese ? 'zh-TW' : 'en',
    tone: 'formal_business',
    bullet_style: allText.includes('- ') ? 'dash' : allText.includes('• ') ? 'dot' : 'none',
    kpi_naming: '',
    sample_phrases: samples.slice(0, 5),
    avg_sentence_length: 'medium',
    uses_headers: true,
  };
}

export const _testExports = { extractStructure, extractFormatting, extractCharts, extractKpiLayout, extractTextSamples, mostCommon, buildFallbackTextStyle };
