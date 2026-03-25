/**
 * chartTemplateLoader.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lazy-loads pre-compiled chart templates via React.lazy.
 * Part of Layer C (Template) in the A+C hybrid chart architecture.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { lazy } from 'react';

const TEMPLATE_LOADERS = {
  'bar-gradient':          lazy(() => import('../../components/charts/templates/BarGradientTemplate.jsx')),
  'bar-horizontal-ranked': lazy(() => import('../../components/charts/templates/BarHorizontalRankedTemplate.jsx')),
  'line-area-smooth':      lazy(() => import('../../components/charts/templates/LineAreaSmoothTemplate.jsx')),
  'pie-donut-modern':      lazy(() => import('../../components/charts/templates/PieDonutModernTemplate.jsx')),
  'stacked-grouped':       lazy(() => import('../../components/charts/templates/StackedGroupedTemplate.jsx')),
};

export function getTemplateComponent(templateId) {
  return TEMPLATE_LOADERS[templateId] || null;
}
