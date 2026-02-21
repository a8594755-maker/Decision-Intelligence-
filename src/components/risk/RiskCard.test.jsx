/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import RiskCard from './RiskCard.jsx';

const MOCK_RISK = {
  materialCode: 'MAT-001',
  plant: 'Plant-A',
  description: 'Test Material',
  status: 'critical',
  profitAtRisk: 15000,
  marginAtRisk: 5000,
  daysToStockout: 2,
  stockoutDate: '2026-03-01',
  netAvailable: 100,
  gapQty: 50,
  actions: { canExpedite: true, canSubstitute: true },
};

describe('RiskCard — rendering', () => {
  it('renders material code', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('MAT-001')).toBeInTheDocument();
  });

  it('renders plant name', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('Plant-A')).toBeInTheDocument();
  });

  it('renders description', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('Test Material')).toBeInTheDocument();
  });

  it('shows Critical status badge', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('shows Warning status badge for warning risk', () => {
    render(<RiskCard risk={{ ...MOCK_RISK, status: 'warning' }} />);
    expect(screen.getByText('Warning')).toBeInTheDocument();
  });

  it('shows OK status badge for ok risk', () => {
    render(<RiskCard risk={{ ...MOCK_RISK, status: 'ok' }} />);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('displays profit at risk formatted as currency', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('$15,000')).toBeInTheDocument();
  });

  it('displays days to stockout', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows Stockout label when daysToStockout is 0', () => {
    render(<RiskCard risk={{ ...MOCK_RISK, daysToStockout: 0 }} />);
    expect(screen.getByText('Stockout')).toBeInTheDocument();
  });

  it('shows dash when daysToStockout is null', () => {
    render(<RiskCard risk={{ ...MOCK_RISK, daysToStockout: null }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows gap quantity when > 0', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('Gap: 50')).toBeInTheDocument();
  });

  it('renders Simulate Expedite button', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('Simulate Expedite')).toBeInTheDocument();
  });

  it('renders Substitutes button', () => {
    render(<RiskCard risk={MOCK_RISK} />);
    expect(screen.getByText('Substitutes')).toBeInTheDocument();
  });

  it('hides expedite button when canExpedite is false', () => {
    render(<RiskCard risk={{ ...MOCK_RISK, actions: { canExpedite: false, canSubstitute: true } }} />);
    expect(screen.queryByText('Simulate Expedite')).not.toBeInTheDocument();
  });
});

describe('RiskCard — interactions', () => {
  it('calls onClick when card body is clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<RiskCard risk={MOCK_RISK} onClick={onClick} />);

    await user.click(screen.getByText('MAT-001'));
    expect(onClick).toHaveBeenCalledWith(MOCK_RISK);
  });

  it('calls onExpedite when expedite button is clicked', async () => {
    const user = userEvent.setup();
    const onExpedite = vi.fn();
    render(<RiskCard risk={MOCK_RISK} onExpedite={onExpedite} />);

    await user.click(screen.getByText('Simulate Expedite'));
    expect(onExpedite).toHaveBeenCalledWith(MOCK_RISK);
  });

  it('calls onSubstitute when substitute button is clicked', async () => {
    const user = userEvent.setup();
    const onSubstitute = vi.fn();
    render(<RiskCard risk={MOCK_RISK} onSubstitute={onSubstitute} />);

    await user.click(screen.getByText('Substitutes'));
    expect(onSubstitute).toHaveBeenCalledWith(MOCK_RISK);
  });

  it('does not call onClick when a button is clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onExpedite = vi.fn();
    render(<RiskCard risk={MOCK_RISK} onClick={onClick} onExpedite={onExpedite} />);

    await user.click(screen.getByText('Simulate Expedite'));
    expect(onExpedite).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies ring class when selected', () => {
    const { container } = render(<RiskCard risk={MOCK_RISK} selected={true} />);
    expect(container.firstChild).toHaveClass('ring-2');
  });
});
