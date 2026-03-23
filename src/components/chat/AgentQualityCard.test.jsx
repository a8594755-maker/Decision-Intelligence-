/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import AgentQualityCard from './AgentQualityCard.jsx';

function buildQa(overrides = {}) {
  return {
    status: 'warning',
    score: 7.4,
    pass_threshold: 8,
    blockers: ['Missing caveat'],
    issues: ['Missing caveat', 'Evidence table is low value'],
    repair_instructions: ['Add caveat'],
    dimension_scores: {
      correctness: 8.2,
      completeness: 7.4,
      evidence_alignment: 6.8,
      visualization_fit: 8.5,
      caveat_quality: 4.0,
      clarity: 8.1,
    },
    reviewers: [{
      stage: 'self',
      provider: 'openai',
      model: 'gpt-5.4',
      score: 7.3,
      issues: ['Missing caveat'],
    }],
    repair_attempted: true,
    ...overrides,
  };
}

describe('AgentQualityCard', () => {
  it('starts collapsed and expands to show issues and reviewer details', async () => {
    const user = userEvent.setup();

    render(<AgentQualityCard qa={buildQa()} />);

    expect(screen.getByText(/Answer Quality/i)).toBeInTheDocument();
    expect(screen.queryByText(/Top Issues/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Answer Quality/i }));

    expect(screen.getByText(/Top Issues/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Missing caveat/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Reviewer Details/i)).toBeInTheDocument();
    expect(screen.getByText(/gpt-5.4/i)).toBeInTheDocument();
  });

  it('shows pass state and cross-model usage when cross review is present', async () => {
    const user = userEvent.setup();

    render(
      <AgentQualityCard
        qa={buildQa({
          status: 'pass',
          score: 8.6,
          repair_attempted: false,
          reviewers: [
            {
              stage: 'self',
              provider: 'openai',
              model: 'gpt-5.4',
              score: 8.5,
              issues: [],
            },
            {
              stage: 'cross_model',
              provider: 'gemini',
              model: 'gemini-3.1-pro-preview',
              score: 8.7,
              issues: [],
            },
          ],
        })}
      />
    );

    expect(screen.getByText(/pass/i)).toBeInTheDocument();
    expect(screen.getByText(/Cross-model review used/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Answer Quality/i }));
    expect(screen.getByText(/^gemini$/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini-3.1-pro-preview/i)).toBeInTheDocument();
  });
});
