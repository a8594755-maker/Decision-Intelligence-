import { describe, expect, it } from 'vitest';

import {
  buildAgentBriefResponseSchema,
  buildAgentBriefSynthesisPrompt,
  buildAgentQaSelfReviewPrompt,
  buildAgentQaRepairSynthesisPrompt,
} from './agentResponsePrompt.js';

describe('agentResponsePrompt', () => {
  it('keeps the brief schema stable while adding the new synthesis contract text', () => {
    const prompt = buildAgentBriefSynthesisPrompt({
      userMessage: 'Compare 2016-2018 top states by revenue, annual change, and CAGR.',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['revenue', 'annual change', 'top regions', 'cagr'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'analysis',
        analysis_depth: ['relative_metrics', 'trend_context', 'methodology_disclosure'],
      },
      toolCalls: [],
      finalAnswerText: '',
      mode: 'analysis',
      repairInstructions: [],
    });

    const schema = buildAgentBriefResponseSchema();
    expect(schema.required).toEqual([
      'headline',
      'summary',
      'metric_pills',
      'tables',
      'charts',
      'key_findings',
      'implications',
      'caveats',
      'next_steps',
    ]);

    expect(prompt).toContain('DEDUP RULE:');
    expect(prompt).toContain('A metric pill value may appear verbatim in one additional section only if needed to satisfy a required dimension.');
    expect(prompt).toContain('If a required dimension would be missing without one exact value, keep the value in key_findings and remove it from summary.');
    expect(prompt).toContain('PRIMARY GROWTH BASELINE RULE (MANDATORY):');
    expect(prompt).toContain('choose ONE primary growth basis');
    expect(prompt).toContain('SUBSTITUTE METRIC DISCLOSURE (MANDATORY):');
    expect(prompt).toContain('2016-2018 CAGR is not reliable because 2016 covers only 3 months; using 2017-2018 comparable growth instead.');
    expect(prompt).toContain('SUMMARY DENSITY RULE:');
    expect(prompt).toContain('LIMITED COVERAGE RULE:');
    expect(prompt).toContain('"limited annual coverage", "three yearly observations", or "insufficient periods for time-series inference".');
    expect(prompt).toContain('FORMAT DISCIPLINE:');
    expect(prompt).toContain('"ratio_multiplier" → keep the raw ratio-like value or "Nx" form');
    expect(prompt).not.toContain('convert to % explicitly (1,118%)');
  });

  it('adds the English repair order and ambiguous-unit cleanup rules', () => {
    const prompt = buildAgentQaRepairSynthesisPrompt({
      userMessage: 'Compare annual change and CAGR for the top 3 states.',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['annual change', 'revenue', 'cagr'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'analysis',
        analysis_depth: ['relative_metrics', 'trend_context', 'methodology_disclosure'],
      },
      brief: {},
      toolCalls: [],
      finalAnswerText: '',
      deterministicQa: null,
      qaScorecard: null,
      artifactSummary: '',
      mode: 'analysis',
    });

    expect(prompt).toContain('FIRST-PASS REWRITE ORDER:');
    expect(prompt).toContain('1. Restore missing required dimensions.');
    expect(prompt).toContain('2. Fix unit inconsistencies.');
    expect(prompt).toContain('4. Normalize caveats to validator vocabulary.');
    expect(prompt).toContain('PRIMARY GROWTH BASELINE REPAIR:');
    expect(prompt).toContain('If CAGR or YoY is unreliable, say that explicitly and name the substitute metric in English.');
    expect(prompt).toContain('SUMMARY SIMPLIFICATION:');
    expect(prompt).toContain('If both annual growth and normalized monthly growth appear, keep the metric that best answers the user\'s request in summary');
    expect(prompt).toContain('DEDUP RULE:');
    expect(prompt).toContain('LIMITED COVERAGE RULE:');
    expect(prompt).toContain('If a metric\'s unit is ambiguous, remove it from metric_pills before leaving it inconsistent across sections.');
  });

  it('treats deterministic heuristic findings as advisory in the reviewer prompt', () => {
    const prompt = buildAgentQaSelfReviewPrompt({
      userMessage: 'Compare annual trend and CAGR for the top states.',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['annual trend', 'cagr', 'revenue'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'analysis',
      },
      brief: {
        headline: 'Top states diverged.',
        summary: 'SP stayed ahead while RJ slowed.',
        metric_pills: [],
        tables: [],
        key_findings: [],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [],
      finalAnswerText: '',
      deterministicQa: {
        blockers: [],
        heuristic_findings: ['Magnitude mismatch between SQL evidence and narrative: ...'],
      },
      artifactSummary: '',
    });

    expect(prompt).toContain('Treat deterministic blockers / hard findings as strong evidence.');
    expect(prompt).toContain('Treat deterministic heuristic_findings and non-blocking issues as ADVISORY only');
    expect(prompt).toContain('you SHOULD override heuristic deterministic suspicions');
    expect(prompt).toContain('Metric hierarchy');
    expect(prompt).toContain('mixes competing growth baselines');
    expect(prompt).not.toContain('Do NOT re-check numbers or data');
  });
});
