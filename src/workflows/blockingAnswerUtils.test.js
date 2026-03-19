import { describe, expect, it } from 'vitest';

import { applyBlockingAnswerBindings } from './blockingAnswerUtils.js';

describe('applyBlockingAnswerBindings', () => {
  it('applies settings and contract bindings using question ids or positional answers', () => {
    const result = applyBlockingAnswerBindings({
      questions: [
        {
          id: 'Q1',
          question: 'What lead time should we use?',
          answer_type: 'number',
          bind_to: 'settings.plan.constraints.lead_time_days',
        },
        {
          id: 'Q2',
          question: 'Which column is quantity?',
          answer_type: 'text',
          bind_to: 'contract.datasets.0.mapping.qty',
        },
        {
          id: 'Q3',
          question: 'Confirm MOQ source',
          answer_type: 'single_choice',
          options: ['erp', 'manual'],
          bind_to: 'mapping.defaults.moq_source',
        },
      ],
      answers: {
        Q1: '14',
        1: 'required_qty',
        q_2: 'erp',
      },
      settings: {
        plan: {
          constraints: {
            service_level_target: 0.95,
          },
        },
      },
      contractJson: {
        datasets: [
          {
            mapping: {
              sku: 'sku_code',
            },
          },
        ],
      },
    });

    expect(result.validationErrors).toEqual([]);
    expect(result.nextSettings.plan.constraints).toEqual({
      service_level_target: 0.95,
      lead_time_days: 14,
    });
    expect(result.nextContractJson.datasets[0].mapping).toEqual({
      sku: 'sku_code',
      qty: 'required_qty',
    });
    expect(result.nextContractJson.mapping.defaults.moq_source).toBe('erp');
    expect(result.answeredQuestions).toHaveLength(3);
    expect(result.appliedBindings.map((item) => item.bind_to)).toEqual([
      'settings.plan.constraints.lead_time_days',
      'contract.datasets.0.mapping.qty',
      'mapping.defaults.moq_source',
    ]);
  });

  it('reports invalid number and invalid option answers without mutating bindings', () => {
    const result = applyBlockingAnswerBindings({
      questions: [
        {
          id: 'Q1',
          question: 'Lead time days?',
          answer_type: 'number',
          bind_to: 'settings.plan.lead_time_days',
        },
        {
          id: 'Q2',
          question: 'Source?',
          answer_type: 'single_choice',
          options: ['erp', 'manual'],
          bind_to: 'mapping.defaults.source',
        },
      ],
      answers: {
        Q1: 'abc',
        Q2: 'spreadsheet',
      },
      settings: {},
      contractJson: {},
    });

    expect(result.nextSettings).toEqual({});
    expect(result.nextContractJson).toEqual({});
    expect(result.appliedBindings).toEqual([]);
    expect(result.validationErrors).toEqual([
      { id: 'Q1', question: 'Lead time days?', reason: 'invalid_number' },
      { id: 'Q2', question: 'Source?', reason: 'invalid_option' },
    ]);
  });
});
