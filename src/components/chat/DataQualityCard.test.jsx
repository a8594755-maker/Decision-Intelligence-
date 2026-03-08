// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import DataQualityCard from './DataQualityCard';

const basePayload = {
  coverage_level: 'full',
  available_datasets: ['demand_fg', 'inventory_snapshots'],
  missing_datasets: [],
  fallbacks_used: [],
  dataset_fallbacks: [],
};

describe('DataQualityCard', () => {
  it('renders null when payload is null', () => {
    const { container } = render(<DataQualityCard payload={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders full coverage without errors', () => {
    render(<DataQualityCard payload={basePayload} />);
    expect(screen.getByText('Full Coverage')).toBeDefined();
    expect(screen.getByText('Data Quality Report')).toBeDefined();
  });

  it('renders partial coverage', () => {
    const payload = {
      ...basePayload,
      coverage_level: 'partial',
      missing_datasets: ['po_open_lines'],
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Partial Coverage')).toBeDefined();
  });

  it('renders minimal coverage', () => {
    const payload = {
      ...basePayload,
      coverage_level: 'minimal',
      missing_datasets: ['po_open_lines', 'fg_financials', 'bom_edge'],
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Minimal Coverage')).toBeDefined();
  });

  it('renders capabilities with new shape { available, level }', () => {
    const payload = {
      ...basePayload,
      capabilities: {
        forecast: { available: true, level: 'full' },
        basic_plan: { available: true, level: 'partial' },
        profit_at_risk: { available: false, level: 'unavailable' },
      },
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Capabilities')).toBeDefined();
    expect(screen.getByText('forecast')).toBeDefined();
    expect(screen.getByText('basic plan')).toBeDefined();
    expect(screen.getByText('profit at risk')).toBeDefined();
  });

  it('renders capabilities with old string shape', () => {
    const payload = {
      ...basePayload,
      capabilities: {
        forecast: 'full',
        basic_plan: 'unavailable',
      },
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('forecast')).toBeDefined();
  });

  it('renders without capabilities', () => {
    render(<DataQualityCard payload={basePayload} />);
    expect(screen.queryByText('Capabilities')).toBeNull();
  });

  it('renders fallback audit', () => {
    const payload = {
      ...basePayload,
      fallbacks_used: [
        { field: 'lead_time_days', source: 'global_default', value: 7, description: 'System default (7 days)', count: 10 },
      ],
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Estimated Fields')).toBeDefined();
  });

  it('renders dataset fallback hints', () => {
    const payload = {
      ...basePayload,
      dataset_fallbacks: [
        { dataset: 'open_pos', action: 'empty_array', degradesCapability: 'inbound_aware_plan', message: 'Open PO data missing.' },
      ],
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Open PO data missing.')).toBeDefined();
  });

  it('renders row_stats', () => {
    const payload = {
      ...basePayload,
      row_stats: { total: 100, clean: 80, with_fallback: 15, quarantined: 5, dropped: 0 },
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Total rows: 100')).toBeDefined();
    expect(screen.getByText('Clean: 80')).toBeDefined();
  });

  it('renders import_quality section when present', () => {
    const payload = {
      ...basePayload,
      import_quality: { totalWarnings: 5, totalQuarantined: 3, totalRejected: 2 },
    };
    render(<DataQualityCard payload={payload} />);
    expect(screen.getByText('Import Quality')).toBeDefined();
    expect(screen.getByText('3 quarantined')).toBeDefined();
    expect(screen.getByText('2 rejected')).toBeDefined();
  });

  it('renders without import_quality', () => {
    render(<DataQualityCard payload={basePayload} />);
    expect(screen.queryByText('Import Quality')).toBeNull();
  });
});
