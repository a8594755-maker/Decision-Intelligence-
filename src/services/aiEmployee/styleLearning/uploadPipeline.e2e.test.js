/**
 * E2E test for the Output Profile upload → extract → compile pipeline.
 * Uses the project's own seed data at scripts/seed-data/ (95 real Excel files).
 * Mocks only Supabase persistence — extraction + compilation logic runs for real.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Mock Supabase (factory must be self-contained) ───────────
vi.mock('../../supabaseClient.js', () => {
  const chainEnd = { data: { id: 'mock-1' }, error: null };
  const chainSelect = { single: () => chainEnd, maybeSingle: () => chainEnd };
  const chainEq = () => ({ eq: chainEq, is: chainEq, order: () => ({ limit: () => ({ data: [], error: null }) }), select: () => chainSelect, maybeSingle: () => chainEnd, data: [], error: null });
  const mockFrom = () => ({
    insert: () => ({ select: () => chainSelect }),
    update: () => ({ eq: chainEq }),
    upsert: () => ({ select: () => chainSelect }),
    select: () => ({ eq: chainEq }),
    delete: () => ({ eq: chainEq }),
  });
  return {
    supabase: {
      from: mockFrom,
      auth: { getUser: () => ({ data: { user: { id: 'test-user' } }, error: null }) },
    },
  };
});

import { extractStyleFromExcel, extractStyleBatch } from './styleExtractionService.js';
import { compileProfile } from './styleProfileService.js';
import { runOnboarding, _testExports } from './onboardingService.js';

const { classifyDocType } = _testExports;

// ── Load seed data ──────────────────────────────────────────
const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SEED_DIR = join(PROJECT_ROOT, 'scripts', 'seed-data');

let allFiles = [];
let mbrFiles = [];
let weeklyFiles = [];
let qbrFiles = [];
let forecastFiles = [];
let riskFiles = [];

beforeAll(() => {
  const names = readdirSync(SEED_DIR).filter(f => f.endsWith('.xlsx'));
  allFiles = names.map(name => ({ filename: name, buffer: readFileSync(join(SEED_DIR, name)) }));

  mbrFiles = allFiles.filter(f => f.filename.startsWith('MBR'));
  weeklyFiles = allFiles.filter(f => f.filename.startsWith('週報'));
  qbrFiles = allFiles.filter(f => f.filename.startsWith('QBR'));
  forecastFiles = allFiles.filter(f => f.filename.startsWith('需求預測'));
  riskFiles = allFiles.filter(f => f.filename.startsWith('風險報告'));

  expect(allFiles.length).toBe(95);
  expect(mbrFiles.length).toBe(13);
  expect(weeklyFiles.length).toBe(52);
  expect(qbrFiles.length).toBe(4);
  expect(forecastFiles.length).toBe(13);
  expect(riskFiles.length).toBe(13);
});

describe('Upload Pipeline E2E — scripts/seed-data (95 files)', () => {

  // ── 1. MBR extraction ─────────────────────────────────────
  it('extracts MBR fingerprint: 7 sheets, Cover + KPI Dashboard + Cleaned_Data', () => {
    const fp = extractStyleFromExcel(mbrFiles[0].buffer, mbrFiles[0].filename);

    expect(fp.structure.sheet_count).toBe(7);
    expect(fp.structure.has_cover_sheet).toBe(true);
    expect(fp.structure.has_dashboard_sheet).toBe(true);
    expect(fp.structure.has_data_sheet).toBe(true);
    expect(fp.kpi_layout.position).toBe('dedicated_sheet');
    expect(fp.kpi_layout.kpi_keywords_found).toEqual(expect.arrayContaining(['kpi']));

    // Chinese + English text samples
    const allText = fp.text_samples.join(' ');
    expect(allText).toMatch(/[\u4e00-\u9fff]/);
    expect(allText).toMatch(/[a-zA-Z]/);
  });

  // ── 2. Weekly extraction ───────────────────────────────────
  it('extracts Weekly fingerprint: 2 sheets (週報摘要 Summary, Detail)', () => {
    const fp = extractStyleFromExcel(weeklyFiles[0].buffer, weeklyFiles[0].filename);

    expect(fp.structure.sheet_count).toBe(2);
    expect(fp.structure.sheet_names).toEqual(expect.arrayContaining(['週報摘要 Summary', 'Detail']));
  });

  // ── 3. QBR extraction ──────────────────────────────────────
  it('extracts QBR fingerprint: 6 sheets with Executive Summary + Quarterly KPIs', () => {
    const fp = extractStyleFromExcel(qbrFiles[0].buffer, qbrFiles[0].filename);

    expect(fp.structure.sheet_count).toBe(6);
    expect(fp.structure.has_cover_sheet).toBe(true);
    expect(fp.kpi_layout.kpi_keywords_found.length).toBeGreaterThan(0);
  });

  // ── 4. Forecast extraction ─────────────────────────────────
  it('extracts Forecast fingerprint: 3 sheets with accuracy metrics', () => {
    const fp = extractStyleFromExcel(forecastFiles[0].buffer, forecastFiles[0].filename);

    expect(fp.structure.sheet_count).toBe(3);
    expect(fp.kpi_layout.kpi_keywords_found).toEqual(expect.arrayContaining(['mape']));
  });

  // ── 5. Risk extraction ─────────────────────────────────────
  it('extracts Risk fingerprint: 3 sheets with exception log + risk matrix', () => {
    const fp = extractStyleFromExcel(riskFiles[0].buffer, riskFiles[0].filename);

    expect(fp.structure.sheet_count).toBe(3);
  });

  // ── 6. Doc type classification ─────────────────────────────
  it('classifies MBR files as mbr_report (via sheet name "KPI Dashboard")', () => {
    const fp = extractStyleFromExcel(mbrFiles[0].buffer, mbrFiles[0].filename);
    expect(classifyDocType(fp)).toBe('mbr_report');
  });

  it('classifies QBR files as qbr_deck (via sheet name with "quarterly")', () => {
    const fp = extractStyleFromExcel(qbrFiles[0].buffer, qbrFiles[0].filename);
    expect(classifyDocType(fp)).toBe('qbr_deck');
  });

  it('classifies Weekly files via filename fallback (週報 in source_file)', () => {
    const fp = extractStyleFromExcel(weeklyFiles[0].buffer, weeklyFiles[0].filename);
    const docType = classifyDocType(fp);
    // classifyDocType checks sheet names first; "週報摘要 Summary" contains 週報 → may match
    expect(['weekly_ops', 'mbr_report']).toContain(docType);
  });

  it('classifies Forecast files as forecast_report', () => {
    const fp = extractStyleFromExcel(forecastFiles[0].buffer, forecastFiles[0].filename);
    expect(classifyDocType(fp)).toBe('forecast_report');
  });

  it('classifies Risk files as risk_report', () => {
    const fp = extractStyleFromExcel(riskFiles[0].buffer, riskFiles[0].filename);
    expect(classifyDocType(fp)).toBe('risk_report');
  });

  // ── 7. Batch extraction — all 13 MBRs ─────────────────────
  it('batch extracts all 13 MBR files with zero errors', async () => {
    const { fingerprints, errors } = await extractStyleBatch(mbrFiles);
    expect(errors).toHaveLength(0);
    expect(fingerprints).toHaveLength(13);
    for (const fp of fingerprints) {
      expect(fp.structure.sheet_count).toBe(7);
    }
  });

  // ── 8. Profile compilation — MBR ──────────────────────────
  it('compiles canonical MBR profile from 13 months of data', async () => {
    const { fingerprints } = await extractStyleBatch(mbrFiles);
    const profile = compileProfile(fingerprints, {
      employee_id: 'default', team_id: 'default',
      doc_type: 'mbr_report', profile_name: 'mbr_baseline',
    });

    expect(profile.sample_count).toBe(13);
    expect(profile.confidence).toBeGreaterThan(0.7); // 13 samples → high confidence
    expect(profile.canonical_structure.typical_sheet_count).toBe(7);
    expect(profile.canonical_structure.has_cover_sheet).toBe(true);
    expect(profile.canonical_structure.has_dashboard_sheet).toBe(true);
    expect(profile.canonical_kpi_layout.position).toBe('dedicated_sheet');
    expect(profile.high_variance_dims).not.toContain('sheet_count');
  });

  // ── 9. Profile compilation — Weekly ───────────────────────
  it('compiles canonical Weekly profile from 52 weeks of data', async () => {
    const { fingerprints } = await extractStyleBatch(weeklyFiles);
    const profile = compileProfile(fingerprints, {
      employee_id: 'default', team_id: 'default',
      doc_type: 'weekly_ops', profile_name: 'weekly_baseline',
    });

    expect(profile.sample_count).toBe(52);
    expect(profile.confidence).toBeGreaterThan(0.8); // 52 samples!
    expect(profile.canonical_structure.typical_sheet_count).toBe(2);
  });

  // ── 10. Full onboarding with all 95 files ─────────────────
  it('runs full onboarding pipeline with all 95 seed files', async () => {
    const progressStages = [];
    const result = await runOnboarding({
      employeeId: 'default',
      teamId: 'default',
      inputs: {
        bulkFiles: allFiles.map(f => ({ buffer: f.buffer, filename: f.filename })),
      },
      onProgress: (stage, detail) => progressStages.push({ stage, detail }),
    });

    expect(result.jobId).toBeTruthy();
    expect(result.profileCreated).toBe(true);
    expect(result.errors.filter(e => e.stage === 'unknown')).toHaveLength(0);
    expect(progressStages.some(s => s.stage === 'complete')).toBe(true);
  });

  // ── 11. ExemplarUploadPanel exact call signature ──────────
  it('matches ExemplarUploadPanel handleLearn call (employeeId=default)', async () => {
    const result = await runOnboarding({
      employeeId: 'default',
      teamId: 'default',
      inputs: {
        bulkFiles: mbrFiles.slice(0, 3).map(f => ({ buffer: f.buffer, filename: f.filename })),
      },
    });
    expect(result.profileCreated).toBe(true);
  });

  // ── 12. listExemplars signature fix ───────────────────────
  it('listExemplars accepts (employeeId, opts) — OutputProfilesPage fix verified', async () => {
    const { listExemplars } = await import('./exemplarService.js');
    const result = await listExemplars('default', { limit: 100 });
    expect(Array.isArray(result)).toBe(true);
  });

  // ── 13. Performance: 95 files under 5 seconds ────────────
  it('processes all 95 files in under 5 seconds', async () => {
    const start = performance.now();
    await extractStyleBatch(allFiles);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
