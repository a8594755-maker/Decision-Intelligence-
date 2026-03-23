/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import AnalysisResultCard from './AnalysisResultCard.jsx';

describe('AnalysisResultCard heatmap presentation', () => {
  it('renders ordered weekday/hour heatmaps with legend and without the completed badge', () => {
    const payload = {
      title: 'Order Volume: Weekday × Hour',
      summary: 'Peak: Tuesday at 14:00. Quietest: Monday at 04:00.',
      metrics: {
        'Peak Slot': 'Tuesday 14:00',
        'Peak Orders': '1,124',
        'Quietest Slot': 'Monday 04:00',
      },
      charts: [{
        type: 'heatmap',
        title: 'Orders by Day × Hour',
        rowOrder: ['Monday', 'Tuesday'],
        colOrder: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')),
        data: Array.from({ length: 24 }, (_, hour) => ({ row: 'Tuesday', col: String(hour).padStart(2, '0'), value: hour + 10 }))
          .concat(Array.from({ length: 24 }, (_, hour) => ({ row: 'Monday', col: String(hour).padStart(2, '0'), value: hour + 1 }))),
      }],
    };

    const { container } = render(<AnalysisResultCard payload={payload} />);
    const svgText = Array.from(container.querySelectorAll('svg text')).map((node) => node.textContent);

    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.getByText('Low volume')).toBeInTheDocument();
    expect(screen.getByText('High volume')).toBeInTheDocument();
    expect(screen.getByText('00')).toBeInTheDocument();
    expect(screen.getAllByText('23').length).toBeGreaterThan(0);
    expect(svgText.indexOf('Monday')).toBeGreaterThan(-1);
    expect(svgText.indexOf('Tuesday')).toBeGreaterThan(-1);
    expect(svgText.indexOf('Monday')).toBeLessThan(svgText.indexOf('Tuesday'));
  });
});
