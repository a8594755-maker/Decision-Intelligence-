/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import ModelConfigTab from './ModelConfigTab.jsx';
import { getActiveThinkingMode, resetModelConfig } from '../../services/modelConfigService.js';

describe('ModelConfigTab', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelConfig();
  });

  it('renders the simplified settings layout without execution mode tabs', () => {
    render(<ModelConfigTab />);

    expect(screen.getByText('Thinking Mode Default')).toBeInTheDocument();
    expect(screen.getByText('Primary Model')).toBeInTheDocument();
    expect(screen.getByText('Advanced Comparison Models')).toBeInTheDocument();
    expect(screen.queryByText('Execution Mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Single Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Dual Agent')).not.toBeInTheDocument();
  });

  it('keeps advanced comparison models collapsed by default and allows toggling thinking mode', async () => {
    const user = userEvent.setup();
    render(<ModelConfigTab />);

    expect(screen.queryByText('Challenger Model')).not.toBeInTheDocument();
    expect(getActiveThinkingMode()).toBe('single');

    await user.click(screen.getByText('On').closest('button'));
    expect(getActiveThinkingMode()).toBe('full');

    await user.click(screen.getByRole('button', { name: /advanced comparison models/i }));
    expect(screen.getByText('Challenger Model')).toBeInTheDocument();
    expect(screen.getByText('Judge Model')).toBeInTheDocument();
  });
});
