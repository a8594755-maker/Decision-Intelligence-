/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import ThinkingStepsDisplay from './ThinkingStepsDisplay.jsx';

describe('ThinkingStepsDisplay', () => {
  it('groups visible reasoning by agent with separate labels', async () => {
    const user = userEvent.setup();

    render(
      <ThinkingStepsDisplay
        completed
        defaultCollapsed
        steps={[
          { step: 1, type: 'preamble', content: 'Inspecting the revenue distribution.', agentKey: 'primary', agentLabel: 'Primary Agent', agentTone: 'primary', provider: 'openai', model: 'gpt-5.4' },
          { step: 2, type: 'summary', status: 'completed', content: 'Primary completed with a usable answer.', agentKey: 'primary', agentLabel: 'Primary Agent', agentTone: 'primary', provider: 'openai', model: 'gpt-5.4' },
          { step: 1, type: 'preamble', content: 'Building an independent comparison.', agentKey: 'secondary', agentLabel: 'Challenger Agent', agentTone: 'secondary', provider: 'anthropic', model: 'claude-opus-4-6' },
          { step: 2, type: 'summary', status: 'timed_out', content: 'Challenger timed out before producing a full brief.', agentKey: 'secondary', agentLabel: 'Challenger Agent', agentTone: 'secondary', provider: 'anthropic', model: 'claude-opus-4-6' },
          { step: 1, type: 'summary', status: 'completed', content: 'Selecting the answer with stronger caveats.', agentKey: 'judge', agentLabel: 'Judge', agentTone: 'judge', provider: 'gemini', model: 'gemini-3.1-pro-preview' },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: /thinking/i }));

    expect(screen.getByText('Primary Agent')).toBeInTheDocument();
    expect(screen.getByText('Challenger Agent')).toBeInTheDocument();
    expect(screen.getByText('Judge')).toBeInTheDocument();
    expect(screen.getByText(/Inspecting the revenue distribution/i)).toBeInTheDocument();
    expect(screen.getByText(/Selecting the answer with stronger caveats/i)).toBeInTheDocument();
    expect(screen.getByText(/^timed out$/i)).toBeInTheDocument();
  });
});
