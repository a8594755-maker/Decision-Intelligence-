import { describe, expect, it } from 'vitest';
import { resolveAgentExecutionStrategy, computeQueryComplexity } from './agentExecutionStrategyService.js';

describe('agentExecutionStrategyService', () => {
  it('forces judge and dual generation for data-heavy analysis requests', () => {
    const strategy = resolveAgentExecutionStrategy({
      userMessage: '請用 Python 分析賣家營收分布，畫直方圖並標示分位數',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
      },
      mode: 'analysis',
      hasAttachments: false,
    });

    expect(strategy.mustJudge).toBe(true);
    expect(strategy.dualGenerate).toBe(true);
    expect(strategy.triggerReasons).toEqual(expect.arrayContaining(['data_analysis', 'numeric_reasoning']));
    expect(strategy.riskLevel).toBe('high');
  });

  it('disables dual generation for mutating actions even when judge is still required', () => {
    const strategy = resolveAgentExecutionStrategy({
      userMessage: 'Review the SQL results and then approve the workflow execution',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['workflow', 'approval'],
        required_outputs: ['recommendation', 'caveat'],
      },
      mode: 'default',
      hasAttachments: false,
    });

    expect(strategy.mustJudge).toBe(true);
    expect(strategy.dualGenerate).toBe(false);
    expect(strategy.triggerReasons).toContain('mutating_action');
    expect(strategy.riskLevel).toBe('medium');
  });

  it('keeps analytical replenishment strategy prompts in dual-agent mode', () => {
    const strategy = resolveAgentExecutionStrategy({
      userMessage: '假設 Olist 明年需求成長 20%，我的補貨策略、庫存水位、和資金需求分別要怎麼調整？給我具體建議和風險分析。',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['replenishment_strategy', 'inventory_level', 'capital_requirement', 'risk_analysis'],
        required_outputs: ['recommendation', 'caveat', 'table'],
      },
      mode: 'analysis',
      hasAttachments: false,
    });

    expect(strategy.mustJudge).toBe(true);
    expect(strategy.dualGenerate).toBe(true);
    expect(strategy.triggerReasons).not.toContain('mutating_action');
    expect(strategy.triggerReasons).toEqual(expect.arrayContaining(['data_analysis', 'numeric_reasoning']));
    expect(strategy.riskLevel).toBe('high');
  });

  // ── Complexity scoring ──────────────────────────────────────────────────

  describe('computeQueryComplexity', () => {
    it('scores simple lookup as low complexity', () => {
      const score = computeQueryComplexity('What is the total order count?', {
        task_type: 'lookup',
        required_dimensions: ['orders'],
        required_outputs: [],
      });
      expect(score).toBeLessThan(3);
    });

    it('scores multi-dimension comparison as high complexity', () => {
      const score = computeQueryComplexity('Compare high vs low rated categories on revenue, delivery, return rate', {
        task_type: 'comparison',
        required_dimensions: ['revenue', 'delivery_days', 'return_rate'],
        required_outputs: ['chart', 'table', 'caveat'],
      });
      expect(score).toBeGreaterThanOrEqual(3);
    });

    it('awards points for long messages', () => {
      const shortScore = computeQueryComplexity('revenue?', { task_type: 'lookup', required_dimensions: ['revenue'] });
      const longScore = computeQueryComplexity('A'.repeat(250), { task_type: 'lookup', required_dimensions: ['revenue'] });
      expect(longScore).toBeGreaterThan(shortScore);
    });

    it('awards points for analysis depth', () => {
      const shallow = computeQueryComplexity('test', { task_type: 'mixed', required_dimensions: ['revenue'], analysis_depth: [] });
      const deep = computeQueryComplexity('test', { task_type: 'mixed', required_dimensions: ['revenue'], analysis_depth: ['methodology_disclosure', 'relative_metrics'] });
      expect(deep).toBeGreaterThan(shallow);
    });
  });

  describe('complexity-based dual-agent trigger', () => {
    it('does NOT trigger dual for simple single-dimension lookup', () => {
      const strategy = resolveAgentExecutionStrategy({
        userMessage: 'What is the total revenue?',
        answerContract: {
          task_type: 'lookup',
          required_dimensions: ['revenue'],
          required_outputs: [],
        },
        mode: 'analysis',
        hasAttachments: false,
      });
      expect(strategy.dualGenerate).toBe(false);
      expect(strategy.complexityScore).toBeLessThan(3);
    });

    it('triggers dual for multi-dimension analysis', () => {
      const strategy = resolveAgentExecutionStrategy({
        userMessage: 'Analyze seller revenue distribution with histogram and quantiles',
        answerContract: {
          task_type: 'ranking',
          required_dimensions: ['revenue', 'quantiles', 'sellers'],
          required_outputs: ['chart', 'table'],
        },
        mode: 'analysis',
        hasAttachments: false,
      });
      expect(strategy.dualGenerate).toBe(true);
      expect(strategy.complexityScore).toBeGreaterThanOrEqual(5);
    });

    it('does NOT trigger dual for low-complexity query with single signal even with attachments', () => {
      const strategy = resolveAgentExecutionStrategy({
        userMessage: 'Analyze this data',
        answerContract: {
          task_type: 'mixed',
          required_dimensions: ['revenue'],
          required_outputs: [],
        },
        mode: 'default',
        hasAttachments: true,
      });
      // With tightened mustJudge (requires 2+ signals), single data_analysis signal
      // is not enough to trigger dual-agent even with attachments.
      expect(strategy.dualGenerate).toBe(false);
    });

    it('triggers dual for attachment query with multiple signals', () => {
      const strategy = resolveAgentExecutionStrategy({
        userMessage: 'Calculate revenue forecast from this data',
        answerContract: {
          task_type: 'diagnostic',
          required_dimensions: ['revenue', 'forecast'],
          required_outputs: ['chart', 'table'],
        },
        mode: 'analysis',
        hasAttachments: true,
      });
      // data_analysis + numeric_reasoning → 2 signals → mustJudge=true, attachments → dual
      expect(strategy.dualGenerate).toBe(true);
    });

    it('never triggers dual for mutating actions regardless of complexity', () => {
      const strategy = resolveAgentExecutionStrategy({
        userMessage: 'Approve and execute the replenishment plan for all 15 SKUs',
        answerContract: {
          task_type: 'recommendation',
          required_dimensions: ['replenishment_strategy', 'inventory_level', 'capital_requirement'],
          required_outputs: ['recommendation', 'table', 'caveat'],
        },
        mode: 'analysis',
        hasAttachments: false,
      });
      expect(strategy.dualGenerate).toBe(false);
    });

    it('returns complexityScore in the strategy object', () => {
      const strategy = resolveAgentExecutionStrategy({
        userMessage: 'test',
        answerContract: { task_type: 'mixed', required_dimensions: ['revenue', 'orders'] },
        mode: 'default',
      });
      expect(typeof strategy.complexityScore).toBe('number');
    });
  });
});
