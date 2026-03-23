/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import AgentAlternativeCard from './AgentAlternativeCard.jsx';

describe('AgentAlternativeCard', () => {
  it('renders a compact failure summary when the alternative candidate did not produce a brief', async () => {
    const user = userEvent.setup();

    render(
      <AgentAlternativeCard
        candidate={{
          label: 'Challenger Agent',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          status: 'failed',
          failedReason: 'Tool execution failed before a usable brief was produced.',
          trace: {
            failed_attempts: [{ id: 'alt-fail', name: 'Challenger Agent', error: 'Tool execution failed before a usable brief was produced.' }],
            successful_queries: [],
            raw_narrative: '',
          },
        }}
      />
    );

    expect(screen.getByText(/Alternative Answer/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Alternative Answer/i }));

    expect(screen.getByText(/Tool execution failed before a usable brief was produced/i)).toBeInTheDocument();
    expect(screen.getByText(/Execution Trace/i)).toBeInTheDocument();
  });
});
