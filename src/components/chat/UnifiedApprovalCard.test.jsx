/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import UnifiedApprovalCard from './UnifiedApprovalCard.jsx';

describe('UnifiedApprovalCard', () => {
  it('treats uppercase resolved statuses as resolved and hides decision buttons', () => {
    render(
      <UnifiedApprovalCard
        payload={{
          approval_id: 'ap-1',
          approval_type: 'plan_commit',
          run_id: 42,
          status: 'APPROVED',
          title: 'Plan approved',
        }}
      />
    );

    expect(screen.getByText('APPROVED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('emits decision payload when user approves a pending approval', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();

    render(
      <UnifiedApprovalCard
        payload={{
          approval_id: 'ap-2',
          approval_type: 'plan_commit',
          run_id: 99,
          status: 'PENDING',
          title: 'Approval required',
        }}
        onDecision={onDecision}
      />
    );

    await user.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(onDecision).toHaveBeenCalledWith('ap-2', 'approve');
  });
});
