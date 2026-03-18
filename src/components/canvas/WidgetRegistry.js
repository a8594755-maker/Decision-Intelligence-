/**
 * WidgetRegistry — Maps artifact types to canvas widget components.
 *
 * The DynamicCanvas uses this registry to resolve which widget to render
 * when an artifact is produced by a backend tool.
 *
 * Each entry:
 *  - component: lazy-importable React component (props-driven, no internal fetching)
 *  - title: default display title
 *  - icon: lucide icon name (optional)
 *  - defaultSize: 'full' | 'half' | 'popup'
 *  - category: grouping for UI
 */

import { lazy } from 'react';

// Lazy-load widgets for code splitting
const ForecastWidget    = lazy(() => import('./widgets/ForecastWidget'));
const RiskWidget        = lazy(() => import('./widgets/RiskWidget'));
const PlanTableWidget   = lazy(() => import('./widgets/PlanTableWidget'));
const BOMWidget         = lazy(() => import('./widgets/BOMWidget'));
const InventoryWidget   = lazy(() => import('./widgets/InventoryWidget'));
const ScenarioWidget    = lazy(() => import('./widgets/ScenarioWidget'));
const NegotiationWidget = lazy(() => import('./widgets/NegotiationWidget'));
const ApprovalWidget    = lazy(() => import('./widgets/ApprovalWidget'));

/**
 * @typedef {object} WidgetRegistryEntry
 * @property {React.LazyExoticComponent} component
 * @property {string} title
 * @property {string} [icon]
 * @property {'full'|'half'|'popup'} defaultSize
 * @property {string} category
 */

/** @type {Record<string, WidgetRegistryEntry>} */
export const WIDGET_REGISTRY = {
  // ── Forecast ────────────────────────────────────────────────────────────
  forecast_series: {
    component: ForecastWidget,
    title: 'Demand Forecast',
    icon: 'TrendingUp',
    defaultSize: 'full',
    category: 'planning',
  },
  forecast_csv: {
    component: ForecastWidget,
    title: 'Forecast Data',
    icon: 'TrendingUp',
    defaultSize: 'full',
    category: 'planning',
  },
  metrics: {
    component: ForecastWidget,
    title: 'Forecast Metrics',
    icon: 'BarChart3',
    defaultSize: 'half',
    category: 'planning',
  },

  // ── Plan ────────────────────────────────────────────────────────────────
  plan_table: {
    component: PlanTableWidget,
    title: 'Replenishment Plan',
    icon: 'ClipboardList',
    defaultSize: 'full',
    category: 'planning',
  },
  plan_csv: {
    component: PlanTableWidget,
    title: 'Plan Data',
    icon: 'ClipboardList',
    defaultSize: 'full',
    category: 'planning',
  },
  risk_plan_table: {
    component: PlanTableWidget,
    title: 'Risk-Adjusted Plan',
    icon: 'ClipboardList',
    defaultSize: 'full',
    category: 'planning',
  },
  risk_plan_csv: {
    component: PlanTableWidget,
    title: 'Risk Plan Data',
    icon: 'ClipboardList',
    defaultSize: 'full',
    category: 'planning',
  },
  solver_meta: {
    component: PlanTableWidget,
    title: 'Solver Details',
    icon: 'Calculator',
    defaultSize: 'half',
    category: 'planning',
  },

  // ── Risk ────────────────────────────────────────────────────────────────
  risk_scores: {
    component: RiskWidget,
    title: 'Risk Analysis',
    icon: 'ShieldAlert',
    defaultSize: 'full',
    category: 'risk',
  },
  risk_adjustments: {
    component: RiskWidget,
    title: 'Risk Adjustments',
    icon: 'ShieldAlert',
    defaultSize: 'full',
    category: 'risk',
  },
  risk_delta_summary: {
    component: RiskWidget,
    title: 'Risk Delta',
    icon: 'ShieldAlert',
    defaultSize: 'half',
    category: 'risk',
  },

  // ── Inventory ───────────────────────────────────────────────────────────
  inventory_projection: {
    component: InventoryWidget,
    title: 'Inventory Projection',
    icon: 'Package',
    defaultSize: 'full',
    category: 'inventory',
  },
  risk_inventory_projection: {
    component: InventoryWidget,
    title: 'Risk Inventory Projection',
    icon: 'Package',
    defaultSize: 'full',
    category: 'inventory',
  },

  // ── BOM ─────────────────────────────────────────────────────────────────
  bom_explosion: {
    component: BOMWidget,
    title: 'BOM Structure',
    icon: 'Network',
    defaultSize: 'full',
    category: 'bom',
  },
  component_plan_table: {
    component: BOMWidget,
    title: 'Component Plan',
    icon: 'Network',
    defaultSize: 'full',
    category: 'bom',
  },
  bottlenecks: {
    component: BOMWidget,
    title: 'Bottleneck Analysis',
    icon: 'AlertTriangle',
    defaultSize: 'half',
    category: 'bom',
  },

  // ── Scenario ────────────────────────────────────────────────────────────
  scenario_comparison: {
    component: ScenarioWidget,
    title: 'Scenario Comparison',
    icon: 'GitCompare',
    defaultSize: 'full',
    category: 'scenario',
  },
  plan_comparison: {
    component: ScenarioWidget,
    title: 'Plan Comparison',
    icon: 'GitCompare',
    defaultSize: 'full',
    category: 'scenario',
  },

  // ── Negotiation ─────────────────────────────────────────────────────────
  negotiation_report: {
    component: NegotiationWidget,
    title: 'Negotiation Report',
    icon: 'Handshake',
    defaultSize: 'full',
    category: 'negotiation',
  },
  cfr_negotiation_strategy: {
    component: NegotiationWidget,
    title: 'CFR Strategy',
    icon: 'Handshake',
    defaultSize: 'full',
    category: 'negotiation',
  },
  negotiation_evaluation: {
    component: NegotiationWidget,
    title: 'Negotiation Evaluation',
    icon: 'Handshake',
    defaultSize: 'full',
    category: 'negotiation',
  },
  cfr_param_adjustment: {
    component: NegotiationWidget,
    title: 'CFR Parameter Adjustments',
    icon: 'Handshake',
    defaultSize: 'half',
    category: 'negotiation',
  },

  // ── Review / Approval ───────────────────────────────────────────────────
  decision_bundle: {
    component: ApprovalWidget,
    title: 'Decision Review',
    icon: 'FileText',
    defaultSize: 'full',
    category: 'review',
  },
  ai_review_result: {
    component: ApprovalWidget,
    title: 'AI Review Result',
    icon: 'CheckCircle',
    defaultSize: 'full',
    category: 'review',
  },
};

/**
 * Resolve a widget for a given artifact type.
 * @param {string} artifactType
 * @returns {WidgetRegistryEntry|null}
 */
export function resolveWidget(artifactType) {
  return WIDGET_REGISTRY[artifactType] || null;
}

/**
 * Check if an artifact type has a registered canvas widget.
 * @param {string} artifactType
 * @returns {boolean}
 */
export function hasWidget(artifactType) {
  return artifactType in WIDGET_REGISTRY;
}

/**
 * Get all registered artifact types.
 * @returns {string[]}
 */
export function getRegisteredArtifactTypes() {
  return Object.keys(WIDGET_REGISTRY);
}

/**
 * Get widgets by category.
 * @param {string} category
 * @returns {Array<[string, WidgetRegistryEntry]>}
 */
export function getWidgetsByCategory(category) {
  return Object.entries(WIDGET_REGISTRY).filter(([, entry]) => entry.category === category);
}

// ── Deep Link Map ──────────────────────────────────────────────────────────
// Maps friendly URL names (?widget=risk) → canonical artifact types
export const DEEP_LINK_MAP = {
  forecast:    'forecast_series',
  risk:        'risk_scores',
  bom:         'bom_explosion',
  plan:        'plan_table',
  inventory:   'inventory_projection',
  scenario:    'scenario_comparison',
  negotiation: 'negotiation_report',
  approval:    'decision_bundle',
};

/**
 * Resolve a deep-link friendly name to an artifact type.
 * Falls through to identity if already a valid artifact type.
 * @param {string} name - friendly name or artifact type
 * @returns {string|null}
 */
export function resolveDeepLink(name) {
  if (!name) return null;
  if (DEEP_LINK_MAP[name]) return DEEP_LINK_MAP[name];
  if (WIDGET_REGISTRY[name]) return name; // already an artifact type
  return null;
}
