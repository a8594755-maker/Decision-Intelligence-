/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Badge } from './Badge.jsx';

describe('Badge', () => {
  it('renders children text', () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders with default info type', () => {
    const { container } = render(<Badge>Test</Badge>);
    expect(container.firstChild).toHaveClass('bg-indigo-50');
  });

  it('renders success type', () => {
    const { container } = render(<Badge type="success">OK</Badge>);
    expect(container.firstChild).toHaveClass('bg-emerald-50');
  });

  it('renders warning type', () => {
    const { container } = render(<Badge type="warning">Warning</Badge>);
    expect(container.firstChild).toHaveClass('bg-amber-50');
  });

  it('renders danger type', () => {
    const { container } = render(<Badge type="danger">Critical</Badge>);
    expect(container.firstChild).toHaveClass('bg-red-50');
  });

  it('renders as a span element', () => {
    const { container } = render(<Badge>Test</Badge>);
    expect(container.firstChild.tagName).toBe('SPAN');
  });

  it('has rounded-full and text-xs classes', () => {
    const { container } = render(<Badge>Test</Badge>);
    expect(container.firstChild).toHaveClass('rounded-full', 'text-xs', 'font-medium');
  });
});
