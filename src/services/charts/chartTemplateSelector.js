/**
 * chartTemplateSelector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Selects the best pre-compiled chart template for a given chart spec.
 * Part of Layer C (Template) in the A+C hybrid chart architecture.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TEMPLATE_REGISTRY = [
  {
    id: 'bar-gradient',
    types: ['bar', 'histogram'],
    match: (chart) => (chart.data?.length || 0) <= 20,
    priority: 10,
  },
  {
    id: 'bar-horizontal-ranked',
    types: ['horizontal_bar'],
    match: () => true,
    priority: 10,
  },
  {
    id: 'line-area-smooth',
    types: ['line', 'area'],
    match: (chart) => (chart.data?.length || 0) >= 5,
    priority: 10,
  },
  {
    id: 'pie-donut-modern',
    types: ['pie', 'donut'],
    match: (chart) => (chart.data?.length || 0) <= 12,
    priority: 10,
  },
  {
    id: 'stacked-grouped',
    types: ['stacked_bar', 'grouped_bar'],
    match: (chart) => Array.isArray(chart.series) && chart.series.length > 1,
    priority: 10,
  },
];

export function selectTemplate(chart) {
  if (!chart?.type) return null;
  const candidates = TEMPLATE_REGISTRY
    .filter(t => t.types.includes(chart.type) && t.match(chart))
    .sort((a, b) => b.priority - a.priority);
  return candidates[0]?.id || null;
}
