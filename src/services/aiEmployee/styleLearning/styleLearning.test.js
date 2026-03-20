/**
 * Style Learning Pipeline — Tests
 */
import { describe, it, expect, vi } from 'vitest';

// Mock supabase before any service imports
vi.mock('../../supabaseClient', () => ({ supabase: null }));

// ─── Style Extraction ────────────────────────────────────────
import {
  enrichTextStyle,
  _testExports as extractionExports,
} from './styleExtractionService.js';

// ─── Style Profile ───────────────────────────────────────────
import {
  _testExports as profileExports,
} from './styleProfileService.js';

// ─── Exemplar ────────────────────────────────────────────────
import { _testExports as exemplarExports } from './exemplarService.js';

// ─── Feedback Extractor ──────────────────────────────────────
import { _testExports as feedbackExports } from './feedbackStyleExtractor.js';

// ─── Style Retrieval Composer ────────────────────────────────
import { _testExports as composerExports } from './styleRetrievalComposer.js';

// ─── Trust Metrics ───────────────────────────────────────────
import { _testExports as trustExports } from './trustMetricsService.js';

// ─── Company Output Profiles ─────────────────────────────────
import {
  _testExports as companyProfileExports,
  listCompanyOutputProfiles,
} from './companyOutputProfileService.js';

// ─── Onboarding ──────────────────────────────────────────────
import { _testExports as onboardingExports } from './onboardingService.js';

// ─── Policy ──────────────────────────────────────────────────
import { buildPolicySummary, POLICY_TYPES } from './policyIngestionService.js';

// ═══════════════════════════════════════════════════════════════
// Style Extraction Tests
// ═══════════════════════════════════════════════════════════════

describe('styleExtractionService', () => {
  const { mostCommon, buildFallbackTextStyle } = extractionExports;

  describe('mostCommon', () => {
    it('returns the most frequent element', () => {
      expect(mostCommon(['a', 'b', 'a', 'c', 'a'])).toBe('a');
    });

    it('returns null for empty array', () => {
      expect(mostCommon([])).toBeNull();
    });

    it('returns first winner on tie', () => {
      const result = mostCommon(['a', 'b']);
      expect(['a', 'b']).toContain(result);
    });
  });

  describe('buildFallbackTextStyle', () => {
    it('detects Chinese text', () => {
      const result = buildFallbackTextStyle(['這是中文測試文字']);
      expect(result.language).toBe('zh-TW');
    });

    it('detects English text', () => {
      const result = buildFallbackTextStyle(['This is an English test sample']);
      expect(result.language).toBe('en');
    });

    it('detects mixed text', () => {
      const result = buildFallbackTextStyle(['This is 混合 text 測試']);
      expect(result.language).toBe('mixed');
    });

    it('returns default for empty samples', () => {
      const result = buildFallbackTextStyle([]);
      expect(result.language).toBe('unknown');
      expect(result.tone).toBe('formal_business');
    });

    it('detects dash bullet style', () => {
      const result = buildFallbackTextStyle(['- First item here', '- Second item here']);
      expect(result.bullet_style).toBe('dash');
    });
  });

  describe('enrichTextStyle', () => {
    it('uses fallback when no llmFn provided', async () => {
      const fp = { text_samples: ['Some English text here'], text_style: null };
      const result = await enrichTextStyle(fp, null);
      expect(result.text_style).toBeTruthy();
      expect(result.text_style.language).toBe('en');
    });

    it('uses LLM when provided', async () => {
      const mockLlm = vi.fn().mockResolvedValue(JSON.stringify({
        language: 'zh-TW',
        tone: 'executive_summary',
        bullet_style: 'dash',
        kpi_naming: 'Chinese + English abbreviation',
        sample_phrases: ['較上期成長', '建議追蹤'],
        avg_sentence_length: 'medium',
        uses_headers: true,
      }));

      const fp = { text_samples: ['較上期成長 5%，建議持續追蹤'], text_style: null };
      const result = await enrichTextStyle(fp, mockLlm);
      expect(result.text_style.language).toBe('zh-TW');
      expect(result.text_style.tone).toBe('executive_summary');
      expect(mockLlm).toHaveBeenCalledOnce();
    });

    it('falls back on LLM error', async () => {
      const mockLlm = vi.fn().mockRejectedValue(new Error('API error'));
      const fp = { text_samples: ['Some text'], text_style: null };
      const result = await enrichTextStyle(fp, mockLlm);
      expect(result.text_style).toBeTruthy(); // fallback should work
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Style Profile Tests
// ═══════════════════════════════════════════════════════════════

describe('styleProfileService', () => {
  const { compileProfile, mode, median, majority, detectHighVariance, computeConfidence } = profileExports;

  describe('mode', () => {
    it('returns most frequent value', () => {
      expect(mode(['a', 'b', 'a', 'c'])).toBe('a');
    });
    it('returns null for empty', () => {
      expect(mode([])).toBeNull();
    });
  });

  describe('median', () => {
    it('returns median of odd-length array', () => {
      expect(median([1, 3, 5])).toBe(3);
    });
    it('returns median of even-length array', () => {
      expect(median([1, 3, 5, 7])).toBe(4);
    });
    it('returns 0 for empty', () => {
      expect(median([])).toBe(0);
    });
  });

  describe('majority', () => {
    it('returns true when majority true', () => {
      expect(majority([true, true, false])).toBe(true);
    });
    it('returns false when majority false', () => {
      expect(majority([true, false, false])).toBe(false);
    });
  });

  describe('compileProfile', () => {
    it('returns empty profile for no fingerprints', () => {
      const result = compileProfile([], { employee_id: 'e1', doc_type: 'test' });
      expect(result.sample_count).toBe(0);
      expect(result.confidence).toBe(0);
    });

    it('compiles profile from fingerprints', () => {
      const fps = [
        {
          structure: { sheet_count: 5, sheet_names: ['Cover', 'KPIs', 'Data'], has_cover_sheet: true, has_dashboard_sheet: true, has_data_sheet: true },
          formatting: { header_bg_color: '#1F4E79', header_font_color: '#FFF', header_font: 'Calibri', number_formats: ['#,##0'], has_alternating_rows: true, has_freeze_panes: true, merge_cell_count: 3 },
          charts: { chart_sheet_count: 1, preferred_types: ['bar'], color_palette: ['#1F4E79'] },
          kpi_layout: { position: 'dedicated_sheet', style: 'card_grid', kpi_keywords_found: ['kpi', 'target'] },
          text_style: { language: 'zh-TW', tone: 'formal_business', bullet_style: 'dash', sample_phrases: ['較上期成長'] },
        },
        {
          structure: { sheet_count: 5, sheet_names: ['Cover', 'KPIs', 'Detail'], has_cover_sheet: true, has_dashboard_sheet: true, has_data_sheet: false },
          formatting: { header_bg_color: '#1F4E79', header_font_color: '#FFF', header_font: 'Calibri', number_formats: ['#,##0'], has_alternating_rows: true, has_freeze_panes: true, merge_cell_count: 2 },
          charts: { chart_sheet_count: 1, preferred_types: ['bar'], color_palette: ['#1F4E79'] },
          kpi_layout: { position: 'dedicated_sheet', style: 'card_grid', kpi_keywords_found: ['kpi', 'actual'] },
          text_style: { language: 'zh-TW', tone: 'formal_business', bullet_style: 'dash', sample_phrases: ['建議追蹤'] },
        },
      ];

      const result = compileProfile(fps, { employee_id: 'e1', doc_type: 'mbr' });
      expect(result.sample_count).toBe(2);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.canonical_structure.typical_sheet_count).toBe(5);
      expect(result.canonical_formatting.header_bg_color).toBe('#1F4E79');
      expect(result.canonical_text_style.language).toBe('zh-TW');
    });
  });

  describe('detectHighVariance', () => {
    it('detects no variance in consistent fingerprints', () => {
      const fps = Array.from({ length: 5 }, () => ({
        structure: { sheet_count: 5 },
        formatting: { header_bg_color: '#1F4E79' },
        charts: { preferred_types: ['bar'] },
        text_style: { tone: 'formal_business' },
        kpi_layout: { position: 'dedicated_sheet' },
      }));
      const result = detectHighVariance(fps);
      expect(result).toEqual([]);
    });

    it('detects high variance in inconsistent fingerprints', () => {
      const fps = [
        { structure: { sheet_count: 2 }, formatting: { header_bg_color: '#FFF' }, charts: { preferred_types: ['bar'] }, text_style: { tone: 'formal' }, kpi_layout: { position: 'top' } },
        { structure: { sheet_count: 10 }, formatting: { header_bg_color: '#000' }, charts: { preferred_types: ['line'] }, text_style: { tone: 'casual' }, kpi_layout: { position: 'bottom' } },
        { structure: { sheet_count: 20 }, formatting: { header_bg_color: '#123' }, charts: { preferred_types: ['pie'] }, text_style: { tone: 'technical' }, kpi_layout: { position: 'side' } },
      ];
      const result = detectHighVariance(fps);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('sheet_count');
    });
  });

  describe('computeConfidence', () => {
    it('returns 0.5 for single fingerprint', () => {
      expect(computeConfidence([{}], [])).toBe(0.5);
    });

    it('increases with more samples', () => {
      const small = computeConfidence(Array(5).fill({}), []);
      const large = computeConfidence(Array(100).fill({}), []);
      expect(large).toBeGreaterThan(small);
    });

    it('decreases with high variance', () => {
      const noVar = computeConfidence(Array(10).fill({}), []);
      const highVar = computeConfidence(Array(10).fill({}), ['sheet_count', 'chart_type', 'header_color']);
      expect(noVar).toBeGreaterThan(highVar);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Exemplar Service Tests
// ═══════════════════════════════════════════════════════════════

describe('exemplarService', () => {
  const { buildSkeleton } = exemplarExports;

  describe('buildSkeleton', () => {
    it('extracts sheet layout from fingerprint', () => {
      const fp = {
        structure: { sheet_names: ['Cover', 'Data'], sheet_row_counts: { Cover: 5, Data: 100 } },
        kpi_layout: { kpi_keywords_found: ['kpi', 'target'] },
        formatting: { header_bg_color: '#1F4E79', number_formats: ['#,##0', '0.0%'], has_alternating_rows: true, has_freeze_panes: true },
        text_style: { language: 'zh-TW', tone: 'formal_business', sample_phrases: ['較上期成長', '建議追蹤', '完成度'] },
      };

      const skeleton = buildSkeleton(fp);
      expect(skeleton.sheet_layout).toHaveLength(2);
      expect(skeleton.sheet_layout[0].name).toBe('Cover');
      expect(skeleton.kpi_keywords).toContain('kpi');
      expect(skeleton.formatting_hints.header_bg).toBe('#1F4E79');
      expect(skeleton.text_hints.language).toBe('zh-TW');
      expect(skeleton.text_hints.sample_phrases).toHaveLength(3);
    });

    it('handles empty fingerprint gracefully', () => {
      const skeleton = buildSkeleton({});
      expect(skeleton.sheet_layout).toEqual([]);
      expect(skeleton.kpi_keywords).toEqual([]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Feedback Style Extractor Tests
// ═══════════════════════════════════════════════════════════════

describe('feedbackStyleExtractor', () => {
  const { clusterFeedbackDeterministic, textSimilarity, findSimilarRule, MIN_EVIDENCE_FOR_RULE } = feedbackExports;

  describe('textSimilarity', () => {
    it('returns 1 for identical strings', () => {
      expect(textSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('returns 0 for completely different strings', () => {
      expect(textSimilarity('hello world', 'foo bar baz')).toBe(0);
    });

    it('returns partial similarity for overlapping words', () => {
      const sim = textSimilarity('the quick brown fox', 'the slow brown cat');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it('handles null/empty inputs', () => {
      expect(textSimilarity(null, 'hello')).toBe(0);
      expect(textSimilarity('hello', '')).toBe(0);
    });
  });

  describe('clusterFeedbackDeterministic', () => {
    it('clusters formatting feedback', () => {
      const feedbacks = [
        { task_id: 't1', manager_feedback: 'Please fix the color scheme and font size' },
        { task_id: 't2', manager_feedback: 'The format is wrong, use bold headers' },
        { task_id: 't3', manager_feedback: 'Color should be blue, not red' },
      ];

      const clusters = clusterFeedbackDeterministic(feedbacks);
      const formattingCluster = clusters.find(c => c.rule_type === 'formatting');
      expect(formattingCluster).toBeTruthy();
      expect(formattingCluster.evidence_count).toBeGreaterThanOrEqual(2);
    });

    it('clusters KPI feedback', () => {
      const feedbacks = [
        { task_id: 't1', manager_feedback: 'KPI 指標定義不對' },
        { task_id: 't2', manager_feedback: '目標值需要更新' },
      ];

      const clusters = clusterFeedbackDeterministic(feedbacks);
      const kpiCluster = clusters.find(c => c.rule_type === 'kpi');
      expect(kpiCluster).toBeTruthy();
    });

    it('returns empty for feedbacks without keywords', () => {
      const feedbacks = [{ task_id: 't1', manager_feedback: 'ok' }];
      const clusters = clusterFeedbackDeterministic(feedbacks);
      expect(clusters).toEqual([]);
    });

    it('handles empty feedback', () => {
      const clusters = clusterFeedbackDeterministic([]);
      expect(clusters).toEqual([]);
    });
  });

  describe('findSimilarRule', () => {
    it('finds a similar existing rule', () => {
      const rules = [
        { rule_type: 'formatting', rule_text: 'Use blue header colors in all reports' },
        { rule_type: 'tone', rule_text: 'Use formal business tone' },
      ];
      const cluster = { rule_type: 'formatting', rule_text: 'Use blue header colors for reports' };
      const found = findSimilarRule(rules, cluster);
      expect(found).toBeTruthy();
      expect(found.rule_type).toBe('formatting');
    });

    it('returns undefined when no similar rule', () => {
      const rules = [{ rule_type: 'tone', rule_text: 'Use formal tone' }];
      const cluster = { rule_type: 'formatting', rule_text: 'Use blue headers' };
      expect(findSimilarRule(rules, cluster)).toBeUndefined();
    });
  });

  it('MIN_EVIDENCE_FOR_RULE is at least 2', () => {
    expect(MIN_EVIDENCE_FOR_RULE).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// Style Retrieval Composer Tests
// ═══════════════════════════════════════════════════════════════

describe('styleRetrievalComposer', () => {
  const { buildProfileBlock, buildOverrideBlock, checkStyleCompliance, truncate } = composerExports;

  describe('truncate', () => {
    it('returns text unchanged if within limit', () => {
      expect(truncate('hello', 100)).toBe('hello');
    });

    it('truncates text exceeding limit', () => {
      const result = truncate('a'.repeat(200), 100);
      expect(result.length).toBeLessThanOrEqual(115); // 100 + truncation notice
      expect(result).toContain('[...truncated]');
    });

    it('handles empty text', () => {
      expect(truncate('', 100)).toBe('');
      expect(truncate(null, 100)).toBe('');
    });
  });

  describe('buildProfileBlock', () => {
    it('builds readable profile block', () => {
      const profile = {
        doc_type: 'mbr_report',
        confidence: 0.85,
        sample_count: 50,
        canonical_structure: { typical_sheet_count: 5, common_sheet_names: ['Cover', 'KPIs'], has_cover_sheet: true },
        canonical_formatting: { header_bg_color: '#1F4E79', header_font: 'Calibri' },
        canonical_kpi_layout: { position: 'dedicated_sheet', style: 'card_grid' },
        canonical_text_style: { language: 'zh-TW', tone: 'formal_business', kpi_naming: '中文+英文縮寫' },
        high_variance_dims: ['chart_type'],
      };

      const block = buildProfileBlock(profile);
      expect(block).toContain('mbr_report');
      expect(block).toContain('0.85');
      expect(block).toContain('#1F4E79');
      expect(block).toContain('zh-TW');
      expect(block).toContain('chart_type');
    });
  });

  describe('buildOverrideBlock', () => {
    it('formats overrides', () => {
      const block = buildOverrideBlock({ tone: 'executive', language: 'en' });
      expect(block).toContain('tone: executive');
      expect(block).toContain('language: en');
    });
  });

  describe('checkStyleCompliance', () => {
    it('detects prohibited terms', () => {
      const output = { text: 'The profit margin is terrible this quarter' };
      const profile = {};
      const policies = [{
        policy_type: 'prohibited_terms',
        title: 'No negative language',
        content: 'Do not use negative terms',
        structured: { terms: ['terrible', 'awful'] },
      }];

      const violations = checkStyleCompliance(output, profile, policies);
      expect(violations.some(v => v.dimension === 'prohibited_terms')).toBe(true);
    });

    it('returns empty for compliant output', () => {
      const violations = checkStyleCompliance({ text: 'Good report' }, {}, []);
      expect(violations).toEqual([]);
    });

    it('warns on language mismatch', () => {
      const output = 'This is all in English without any Chinese';
      const profile = { canonical_text_style: { language: 'zh-TW' } };
      const violations = checkStyleCompliance(output, profile, []);
      expect(violations.some(v => v.dimension === 'language')).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Trust Metrics Tests
// ═══════════════════════════════════════════════════════════════

describe('trustMetricsService', () => {
  const { determineAutonomyLevel, computeFirstPassRate, computeRevisionRate, computeAvgReviewScore, AUTONOMY_THRESHOLDS } = trustExports;

  describe('determineAutonomyLevel', () => {
    it('returns A1 for new worker with no tasks', () => {
      expect(determineAutonomyLevel({
        firstPassAcceptanceRate: 0,
        revisionRate: 0,
        tasksCompleted: 0,
        policyViolationRate: 0,
      })).toBe('A1');
    });

    it('returns A2 with moderate performance', () => {
      expect(determineAutonomyLevel({
        firstPassAcceptanceRate: 0.60,
        revisionRate: 0.30,
        tasksCompleted: 15,
        policyViolationRate: 0,
      })).toBe('A2');
    });

    it('returns A3 with good performance', () => {
      expect(determineAutonomyLevel({
        firstPassAcceptanceRate: 0.80,
        revisionRate: 0.15,
        tasksCompleted: 50,
        policyViolationRate: 0,
      })).toBe('A3');
    });

    it('returns A4 with excellent performance', () => {
      expect(determineAutonomyLevel({
        firstPassAcceptanceRate: 0.90,
        revisionRate: 0.05,
        tasksCompleted: 150,
        policyViolationRate: 0.01,
      })).toBe('A4');
    });

    it('does not promote to A4 with high violation rate', () => {
      expect(determineAutonomyLevel({
        firstPassAcceptanceRate: 0.90,
        revisionRate: 0.05,
        tasksCompleted: 150,
        policyViolationRate: 0.10,  // too high
      })).not.toBe('A4');
    });
  });

  describe('computeFirstPassRate', () => {
    it('returns 0 for no tasks', () => {
      expect(computeFirstPassRate([], [])).toBe(0);
    });

    it('returns 1 when all tasks approved first try', () => {
      const tasks = [{ id: 't1', status: 'done' }, { id: 't2', status: 'done' }];
      const reviews = [
        { task_id: 't1', decision: 'approved', created_at: '2026-01-01' },
        { task_id: 't2', decision: 'approved', created_at: '2026-01-02' },
      ];
      expect(computeFirstPassRate(reviews, tasks)).toBe(1);
    });

    it('returns 0.5 when half need revision first', () => {
      const tasks = [{ id: 't1', status: 'done' }, { id: 't2', status: 'done' }];
      const reviews = [
        { task_id: 't1', decision: 'approved', created_at: '2026-01-01' },
        { task_id: 't2', decision: 'needs_revision', created_at: '2026-01-01' },
        { task_id: 't2', decision: 'approved', created_at: '2026-01-02' },
      ];
      expect(computeFirstPassRate(reviews, tasks)).toBe(0.5);
    });
  });

  describe('computeRevisionRate', () => {
    it('returns 0 for no tasks', () => {
      expect(computeRevisionRate([], [])).toBe(0);
    });

    it('computes correctly', () => {
      const tasks = [{ id: 't1', status: 'done' }, { id: 't2', status: 'done' }];
      const reviews = [{ task_id: 't1', decision: 'needs_revision' }];
      expect(computeRevisionRate(reviews, tasks)).toBe(0.5);
    });
  });

  describe('computeAvgReviewScore', () => {
    it('returns 0 for no reviews', () => {
      expect(computeAvgReviewScore([])).toBe(0);
    });

    it('computes average', () => {
      const reviews = [{ score: 80 }, { score: 90 }, { score: 70 }];
      expect(computeAvgReviewScore(reviews)).toBe(80);
    });
  });

  describe('AUTONOMY_THRESHOLDS', () => {
    it('A4 requires higher bar than A3', () => {
      expect(AUTONOMY_THRESHOLDS.A4.first_pass_rate).toBeGreaterThan(AUTONOMY_THRESHOLDS.A3.first_pass_rate);
      expect(AUTONOMY_THRESHOLDS.A4.min_tasks).toBeGreaterThan(AUTONOMY_THRESHOLDS.A3.min_tasks);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Policy Service Tests
// ═══════════════════════════════════════════════════════════════

describe('policyIngestionService', () => {
  describe('buildPolicySummary', () => {
    it('returns empty string for no policies', () => {
      expect(buildPolicySummary([])).toBe('');
    });

    it('groups policies by type', () => {
      const policies = [
        { policy_type: 'glossary', title: 'ITO', content: 'Inventory Turnover' },
        { policy_type: 'glossary', title: 'OTD', content: 'On Time Delivery' },
        { policy_type: 'tone_guide', title: 'Formal', content: 'Use formal business tone' },
      ];

      const summary = buildPolicySummary(policies);
      expect(summary).toContain('GLOSSARY');
      expect(summary).toContain('TONE GUIDE');
      expect(summary).toContain('ITO');
      expect(summary).toContain('Formal');
    });
  });

  describe('POLICY_TYPES', () => {
    it('contains expected types', () => {
      expect(POLICY_TYPES.GLOSSARY).toBe('glossary');
      expect(POLICY_TYPES.KPI_DEFINITION).toBe('kpi_definition');
      expect(POLICY_TYPES.PROHIBITED_TERMS).toBe('prohibited_terms');
      expect(POLICY_TYPES.TONE_GUIDE).toBe('tone_guide');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Onboarding Tests
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Company Output Profile Tests
// ═══════════════════════════════════════════════════════════════

describe('companyOutputProfileService', () => {
  const { normalizeCandidateProfile, buildProfileInsert, mapCompanyProfileRowToOutputProfile } = companyProfileExports;

  describe('normalizeCandidateProfile', () => {
    it('fills missing fields from defaults', () => {
      const result = normalizeCandidateProfile(
        { profile_name: 'test' },
        { docType: 'mbr_report', confidence: 0.8 },
      );
      expect(result.profile_name).toBe('test');
      expect(result.confidence).toBe(0.8);
    });

    it('prefers candidate values over defaults', () => {
      const result = normalizeCandidateProfile(
        { confidence: 0.9 },
        { confidence: 0.5 },
      );
      expect(result.confidence).toBe(0.9);
    });
  });

  describe('buildProfileInsert', () => {
    it('produces valid insert payload', () => {
      const payload = buildProfileInsert({
        scope: { employeeId: 'e1', docType: 'mbr_report', teamId: null },
        version: 1,
        candidateProfile: { profile_name: 'test', confidence: 0.7 },
      });
      expect(payload.employee_id).toBe('e1');
      expect(payload.doc_type).toBe('mbr_report');
      expect(payload.version).toBe(1);
      expect(payload.confidence).toBe(0.7);
    });
  });

  describe('mapCompanyProfileRowToOutputProfile', () => {
    it('maps DB row to output profile shape', () => {
      const row = {
        id: 'abc', employee_id: 'e1', doc_type: 'mbr_report',
        profile_name: 'MBR', status: 'active', version: 2,
        confidence: 0.85, sample_count: 5,
        canonical_structure: { sheets: 3 },
      };
      const out = mapCompanyProfileRowToOutputProfile(row);
      expect(out.id).toBe('abc');
      expect(out.docType).toBe('mbr_report');
      expect(out.canonical.structure).toEqual({ sheets: 3 });
      expect(out.source).toBe('company_output_profiles');
    });
  });

  describe('listCompanyOutputProfiles', () => {
    it('accepts doc_type as alias for docType', async () => {
      const calls = [];
      const mockDb = {
        from: (table) => {
          const chain = {
            select: () => chain,
            eq: (col, val) => { calls.push({ col, val }); return chain; },
            is: () => chain,
            order: () => chain,
            then: (resolve) => resolve({ data: [{ id: '1', doc_type: 'mbr_report' }], error: null }),
          };
          // Make chain thenable (Supabase returns a PromiseLike)
          return chain;
        },
      };
      const result = await listCompanyOutputProfiles({ doc_type: 'mbr_report', db: mockDb });
      expect(result).toHaveLength(1);
      expect(calls.some(c => c.col === 'doc_type' && c.val === 'mbr_report')).toBe(true);
    });

    it('falls back to style_profiles when company_output_profiles is empty', async () => {
      const tables = {};
      const mockDb = {
        from: (table) => {
          const chain = {
            select: () => chain,
            eq: () => chain,
            is: () => chain,
            order: () => chain,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            limit: () => ({
              then: (resolve) => resolve({ data: [], error: null }),
            }),
            insert: (payload) => ({
              select: () => ({
                single: () => {
                  const row = { id: 'bridged_1', ...payload };
                  return Promise.resolve({ data: row, error: null });
                },
              }),
            }),
            update: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
            then: (resolve) => {
              if (table === 'company_output_profiles') {
                return resolve({ data: [], error: null });
              }
              // style_profiles returns data
              return resolve({
                data: [{ id: 'sp1', employee_id: 'e1', doc_type: 'mbr_report', team_id: null, profile_name: 'MBR', sample_count: 5, confidence: 0.8, canonical_structure: {} }],
                error: null,
              });
            },
          };
          return chain;
        },
      };

      const result = await listCompanyOutputProfiles({ db: mockDb });
      // Should have auto-bridged from style_profiles
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].doc_type).toBe('mbr_report');
    });
  });
});

describe('onboardingService', () => {
  const { classifyDocType, groupFingerprints, ONBOARDING_STAGES } = onboardingExports;

  describe('classifyDocType', () => {
    it('classifies MBR report', () => {
      const fp = { structure: { sheet_names: ['Cover', 'KPIs', 'Dashboard', 'Data'] } };
      expect(classifyDocType(fp)).toBe('mbr_report');
    });

    it('classifies forecast report', () => {
      const fp = { structure: { sheet_names: ['Forecast', 'Params'] } };
      expect(classifyDocType(fp)).toBe('forecast_report');
    });

    it('classifies risk report', () => {
      const fp = { structure: { sheet_names: ['Risk Analysis', 'Details'] } };
      expect(classifyDocType(fp)).toBe('risk_report');
    });

    it('classifies single-sheet as ad_hoc', () => {
      const fp = { structure: { sheet_names: ['Sheet1'], sheet_count: 1 } };
      expect(classifyDocType(fp)).toBe('ad_hoc_analysis');
    });

    it('defaults to general_report', () => {
      const fp = { structure: { sheet_names: ['Alpha', 'Beta'], sheet_count: 2 } };
      expect(classifyDocType(fp)).toBe('general_report');
    });
  });

  describe('groupFingerprints', () => {
    it('groups all to default doc type when provided', () => {
      const fps = [{}, {}, {}];
      const groups = groupFingerprints(fps, 'mbr_report');
      expect(groups.mbr_report).toHaveLength(3);
    });

    it('auto-classifies when no default provided', () => {
      const fps = [
        { structure: { sheet_names: ['Cover', 'KPIs'], sheet_count: 2 } },
        { structure: { sheet_names: ['Forecast'], sheet_count: 1 } },
      ];
      const groups = groupFingerprints(fps, null);
      expect(Object.keys(groups).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ONBOARDING_STAGES', () => {
    it('has expected stages', () => {
      expect(ONBOARDING_STAGES.NOT_STARTED).toBe('not_started');
      expect(ONBOARDING_STAGES.COMPLETE).toBe('complete');
      expect(ONBOARDING_STAGES.POLICIES).toBe('ingesting_policies');
      expect(ONBOARDING_STAGES.BULK_STYLE).toBe('learning_style');
    });
  });
});
