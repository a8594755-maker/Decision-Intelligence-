import { describe, expect, it } from 'vitest';
import { resolveAgentExecutionStrategy } from './agentExecutionStrategyService.js';

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
});
