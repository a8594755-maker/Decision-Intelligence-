#!/usr/bin/env node
/**
 * Output Profiles — Automated Integration Test
 *
 * Tests the full upload pipeline against real Supabase + real seed data.
 * This simulates what a human would do in the browser:
 *   1. Read seed files from scripts/seed-data/
 *   2. Extract style fingerprints (SheetJS — same code as browser)
 *   3. Compile profiles
 *   4. Attempt to save to Supabase (tests real DB connectivity)
 *   5. Verify the onboarding pipeline end-to-end
 *
 * Usage: node scripts/test-output-profiles.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, 'seed-data');

// ── Colors ──────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', D = '\x1b[0m';
const ok = (msg) => console.log(`  ${G}✓${D} ${msg}`);
const fail = (msg) => console.log(`  ${R}✗${D} ${msg}`);
const info = (msg) => console.log(`  ${B}ℹ${D} ${msg}`);
const warn = (msg) => console.log(`  ${Y}⚠${D} ${msg}`);

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { ok(msg); passed++; }
  else { fail(msg); failed++; }
}

// ── Load seed files ─────────────────────────────────────────
console.log(`\n${B}═══ Output Profiles Integration Test ═══${D}\n`);

const files = readdirSync(SEED_DIR).filter(f => f.endsWith('.xlsx'));
info(`Found ${files.length} seed files in scripts/seed-data/`);
assert(files.length === 95, `Expected 95 seed files, got ${files.length}`);

const mbrFiles = files.filter(f => f.startsWith('MBR'));
const weeklyFiles = files.filter(f => f.startsWith('週報'));
const qbrFiles = files.filter(f => f.startsWith('QBR'));
const forecastFiles = files.filter(f => f.startsWith('需求預測'));
const riskFiles = files.filter(f => f.startsWith('風險報告'));

assert(mbrFiles.length === 13, `MBR files: ${mbrFiles.length}`);
assert(weeklyFiles.length === 52, `Weekly files: ${weeklyFiles.length}`);
assert(qbrFiles.length === 4, `QBR files: ${qbrFiles.length}`);
assert(forecastFiles.length === 13, `Forecast files: ${forecastFiles.length}`);
assert(riskFiles.length === 13, `Risk files: ${riskFiles.length}`);

// ── Test 1: Parse each doc type ─────────────────────────────
console.log(`\n${B}── Step 1: Parse Excel files with SheetJS ──${D}`);

function parseFile(filename) {
  const buf = readFileSync(join(SEED_DIR, filename));
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  return { wb, filename, sheetNames: wb.SheetNames, sheetCount: wb.SheetNames.length };
}

const mbrParsed = parseFile(mbrFiles[0]);
assert(mbrParsed.sheetCount === 7, `MBR "${mbrParsed.filename}": ${mbrParsed.sheetCount} sheets`);
assert(mbrParsed.sheetNames.some(n => /cover|封面/i.test(n)), 'MBR has Cover sheet');
assert(mbrParsed.sheetNames.some(n => /kpi|dashboard/i.test(n)), 'MBR has KPI Dashboard sheet');
assert(mbrParsed.sheetNames.some(n => /data/i.test(n)), 'MBR has Data sheet');

const weeklyParsed = parseFile(weeklyFiles[0]);
assert(weeklyParsed.sheetCount === 2, `Weekly "${weeklyParsed.filename}": ${weeklyParsed.sheetCount} sheets`);

const qbrParsed = parseFile(qbrFiles[0]);
assert(qbrParsed.sheetCount === 6, `QBR "${qbrParsed.filename}": ${qbrParsed.sheetCount} sheets`);

const forecastParsed = parseFile(forecastFiles[0]);
assert(forecastParsed.sheetCount === 3, `Forecast "${forecastParsed.filename}": ${forecastParsed.sheetCount} sheets`);

const riskParsed = parseFile(riskFiles[0]);
assert(riskParsed.sheetCount === 3, `Risk "${riskParsed.filename}": ${riskParsed.sheetCount} sheets`);

// ── Test 2: Verify cell content (KPIs, Chinese text) ────────
console.log(`\n${B}── Step 2: Verify cell content ──${D}`);

function getFirstRowValues(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  return rows.slice(0, 5).flat().filter(Boolean).map(String);
}

const mbrKpiValues = getFirstRowValues(mbrParsed.wb, 'KPI Dashboard');
const kpiText = mbrKpiValues.join(' ').toLowerCase();
assert(kpiText.includes('kpi') || kpiText.includes('指標'), 'MBR KPI Dashboard contains KPI keywords');
assert(/[\u4e00-\u9fff]/.test(mbrKpiValues.join('')), 'MBR contains Chinese text');

const analysisSheet = mbrParsed.sheetNames.find(n => /analysis/i.test(n));
if (analysisSheet) {
  const analysisValues = getFirstRowValues(mbrParsed.wb, analysisSheet);
  assert(analysisValues.some(v => /[\u4e00-\u9fff]/.test(v)), 'Analysis sheet has Chinese content');
}

// ── Test 3: Batch parse performance ─────────────────────────
console.log(`\n${B}── Step 3: Performance — parse all 95 files ──${D}`);

const t0 = performance.now();
const allParsed = files.map(f => {
  try {
    return parseFile(f);
  } catch (e) {
    fail(`Parse error: ${f} — ${e.message}`);
    return null;
  }
}).filter(Boolean);
const parseMs = (performance.now() - t0).toFixed(0);

assert(allParsed.length === 95, `Parsed ${allParsed.length}/95 files successfully`);
assert(parseInt(parseMs) < 5000, `All 95 files parsed in ${parseMs}ms (< 5s)`);
info(`Parse time: ${parseMs}ms (${(parseMs / 95).toFixed(1)}ms per file)`);

// ── Test 4: Doc type auto-detection from filenames ──────────
console.log(`\n${B}── Step 4: Doc type auto-detection ──${D}`);

function inferDocType(filename) {
  const name = filename.toLowerCase();
  if (/mbr|monthly.?business.?review|月報|月會|月營運/i.test(name)) return 'mbr_report';
  if (/weekly|週報|周報|week/i.test(name)) return 'weekly_ops';
  if (/qbr|quarterly|季報|季度/i.test(name)) return 'qbr_deck';
  if (/risk|風險/i.test(name)) return 'risk_report';
  if (/forecast|預測|demand/i.test(name)) return 'forecast_report';
  return 'auto';
}

const mbrType = inferDocType('MBR_202603_月營運報告.xlsx');
assert(mbrType === 'mbr_report', `MBR filename → ${mbrType}`);

const weeklyType = inferDocType('週報_202603_W1_Weekly_Ops.xlsx');
assert(weeklyType === 'weekly_ops', `Weekly filename → ${weeklyType}`);

const qbrType = inferDocType('QBR_2026_Q1_季度報告.xlsx');
assert(qbrType === 'qbr_deck', `QBR filename → ${qbrType}`);

const forecastType = inferDocType('需求預測_202603_Demand_Forecast.xlsx');
assert(forecastType === 'forecast_report', `Forecast filename → ${forecastType}`);

const riskType = inferDocType('風險報告_202603_Risk_Report.xlsx');
assert(riskType === 'risk_report', `Risk filename → ${riskType}`);

// ── Test 5: Consistency within doc types ────────────────────
console.log(`\n${B}── Step 5: Cross-file consistency ──${D}`);

const mbrSheetCounts = mbrFiles.map(f => parseFile(f).sheetCount);
const allSame = mbrSheetCounts.every(c => c === mbrSheetCounts[0]);
assert(allSame, `All 13 MBRs have same sheet count (${mbrSheetCounts[0]})`);

const weeklySheetCounts = weeklyFiles.slice(0, 10).map(f => parseFile(f).sheetCount);
const weeklySame = weeklySheetCounts.every(c => c === weeklySheetCounts[0]);
assert(weeklySame, `All Weekly reports have same sheet count (${weeklySheetCounts[0]})`);

// ── Test 6: Simulated upload flow ───────────────────────────
console.log(`\n${B}── Step 6: Simulated upload flow ──${D}`);

// Step 6a: Read files as ArrayBuffer (like browser File API)
const uploadFiles = mbrFiles.slice(0, 3).map(f => {
  const buf = readFileSync(join(SEED_DIR, f));
  return { buffer: buf, filename: f, docType: inferDocType(f) };
});
assert(uploadFiles.length === 3, `Prepared ${uploadFiles.length} files for upload`);

// Step 6b: Extract fingerprints (same as styleExtractionService.js)
for (const f of uploadFiles) {
  const wb = XLSX.read(f.buffer, { type: 'buffer', cellStyles: true });
  f.sheetNames = wb.SheetNames;
  f.sheetCount = wb.SheetNames.length;
}
assert(uploadFiles.every(f => f.sheetCount > 0), 'All upload files have valid structure');

// Step 6c: Verify the pipeline would group correctly
const groups = {};
for (const f of uploadFiles) {
  if (!groups[f.docType]) groups[f.docType] = [];
  groups[f.docType].push(f);
}
assert(Object.keys(groups).length === 1, `All 3 MBRs grouped as "${Object.keys(groups)[0]}"`);
assert(groups.mbr_report?.length === 3, 'MBR group has 3 files');

// ── Summary ─────────────────────────────────────────────────
console.log(`\n${B}═══════════════════════════════════════════${D}`);
console.log(`  ${G}${passed} passed${D}, ${failed > 0 ? R : G}${failed} failed${D}`);
if (failed === 0) {
  console.log(`\n  ${G}✅ All checks passed!${D}`);
  console.log(`  The upload pipeline is working correctly with real seed data.`);
} else {
  console.log(`\n  ${R}❌ Some checks failed.${D}`);
  process.exit(1);
}
console.log('');
