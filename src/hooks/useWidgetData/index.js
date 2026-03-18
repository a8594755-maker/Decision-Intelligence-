/**
 * useWidgetData hooks — Domain-specific data hooks for widget live mode.
 * Each hook encapsulates the data-fetching + computation logic
 * from legacy views for reuse by enhanced dual-mode widgets.
 */

export { default as useBOMData } from './useBOMData';
export { default as useRiskData } from './useRiskData';
export { default as useForecastData } from './useForecastData';
