/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import ExecutionTraceCard from './ExecutionTraceCard.jsx';

describe('ExecutionTraceCard', () => {
  it('starts collapsed and reveals failure SQL only after expanding the trace and attempt', async () => {
    const user = userEvent.setup();

    render(
      <ExecutionTraceCard
        trace={{
          failed_attempts: [{
            id: 'sql-fail-1',
            name: 'query_sap_data',
            error: 'strftime() not supported',
            summary: 'strftime() not supported',
            sql: 'SELECT strftime(\'%w\', order_purchase_timestamp) FROM orders',
            result: { success: false, error: 'strftime() not supported' },
          }],
          successful_queries: [],
          raw_narrative: null,
        }}
      />
    );

    expect(screen.queryByText(/strftime/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Execution Trace/i }));
    expect(screen.getByText(/Failed Attempts/i)).toBeInTheDocument();
    expect(screen.queryByText(/SELECT strftime/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /query_sap_data/i }));
    await user.click(screen.getByRole('button', { name: /query_sap_data SQL/i }));
    expect(screen.getByText(/SELECT strftime/)).toBeInTheDocument();
  });

  it('keeps the full narrative collapsed until explicitly opened', async () => {
    const user = userEvent.setup();

    render(
      <ExecutionTraceCard
        trace={{
          failed_attempts: [],
          successful_queries: [{
            id: 'tool-1',
            name: 'generate_chart',
            summary: 'Generated chart artifact',
            rowCount: 0,
            result: { success: true },
          }],
          raw_narrative: 'This is the hidden narrative.',
        }}
      />
    );

    await user.click(screen.getByRole('button', { name: /Execution Trace/i }));
    expect(screen.queryByText('This is the hidden narrative.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Full Narrative/i }));
    expect(screen.getByText('This is the hidden narrative.')).toBeInTheDocument();
  });

  it('renders provider overload categories with a readable label', async () => {
    const user = userEvent.setup();

    render(
      <ExecutionTraceCard
        trace={{
          failed_attempts: [{
            id: 'provider-overloaded-1',
            name: 'Challenger Agent',
            category: 'provider_overloaded',
            error: 'The engine is currently overloaded, please try again later',
            summary: 'Challenger Agent failed because the provider is overloaded.',
          }],
          successful_queries: [],
          raw_narrative: '',
        }}
      />
    );

    await user.click(screen.getByRole('button', { name: /Execution Trace/i }));
    expect(screen.getByText(/failed · provider overloaded/i)).toBeInTheDocument();
  });
});
