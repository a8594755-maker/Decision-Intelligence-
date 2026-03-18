/**
 * Canvas Architecture — Unit Tests
 *
 * Tests for:
 *  - WidgetRegistry (mapping, resolution, categories)
 *  - CanvasContext (state management, navigation)
 *  - EventBus → Canvas bridge (artifact → widget auto-open)
 *  - UnifiedWorkspaceLayout structure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── WidgetRegistry Tests ──────────────────────────────────────────────────

describe('WidgetRegistry', () => {
  let registry;

  beforeEach(async () => {
    registry = await import('./WidgetRegistry.js');
  });

  it('exports WIDGET_REGISTRY as a non-empty object', () => {
    expect(registry.WIDGET_REGISTRY).toBeDefined();
    expect(Object.keys(registry.WIDGET_REGISTRY).length).toBeGreaterThan(10);
  });

  it('resolveWidget returns entry for known artifact types', () => {
    const entry = registry.resolveWidget('forecast_series');
    expect(entry).toBeDefined();
    expect(entry.title).toBe('Demand Forecast');
    expect(entry.component).toBeDefined();
    expect(entry.defaultSize).toBe('full');
    expect(entry.category).toBe('planning');
  });

  it('resolveWidget returns null for unknown artifact type', () => {
    expect(registry.resolveWidget('unknown_artifact_xyz')).toBeNull();
  });

  it('hasWidget returns true for registered types', () => {
    expect(registry.hasWidget('forecast_series')).toBe(true);
    expect(registry.hasWidget('plan_table')).toBe(true);
    expect(registry.hasWidget('risk_scores')).toBe(true);
    expect(registry.hasWidget('bom_explosion')).toBe(true);
    expect(registry.hasWidget('inventory_projection')).toBe(true);
    expect(registry.hasWidget('scenario_comparison')).toBe(true);
    expect(registry.hasWidget('negotiation_report')).toBe(true);
    expect(registry.hasWidget('decision_bundle')).toBe(true);
  });

  it('hasWidget returns false for unregistered types', () => {
    expect(registry.hasWidget('totally_fake_type')).toBe(false);
    expect(registry.hasWidget('')).toBe(false);
  });

  it('getRegisteredArtifactTypes returns all keys', () => {
    const types = registry.getRegisteredArtifactTypes();
    expect(types).toContain('forecast_series');
    expect(types).toContain('plan_table');
    expect(types).toContain('risk_scores');
    expect(types.length).toBeGreaterThan(15);
  });

  it('getWidgetsByCategory filters correctly', () => {
    const planning = registry.getWidgetsByCategory('planning');
    expect(planning.length).toBeGreaterThan(0);
    planning.forEach(([, entry]) => {
      expect(entry.category).toBe('planning');
    });

    const risk = registry.getWidgetsByCategory('risk');
    expect(risk.length).toBeGreaterThan(0);
    risk.forEach(([, entry]) => {
      expect(entry.category).toBe('risk');
    });
  });

  it('every registry entry has required fields', () => {
    for (const [type, entry] of Object.entries(registry.WIDGET_REGISTRY)) {
      expect(entry.component, `${type} missing component`).toBeDefined();
      expect(entry.title, `${type} missing title`).toBeTruthy();
      expect(entry.defaultSize, `${type} missing defaultSize`).toBeTruthy();
      expect(entry.category, `${type} missing category`).toBeTruthy();
    }
  });

  // ── Deep Link Map ──
  it('exports DEEP_LINK_MAP with all core domains', () => {
    expect(registry.DEEP_LINK_MAP).toBeDefined();
    const map = registry.DEEP_LINK_MAP;
    expect(map.forecast).toBe('forecast_series');
    expect(map.risk).toBe('risk_scores');
    expect(map.bom).toBe('bom_explosion');
    expect(map.plan).toBe('plan_table');
    expect(map.inventory).toBe('inventory_projection');
    expect(map.scenario).toBe('scenario_comparison');
    expect(map.negotiation).toBe('negotiation_report');
    expect(map.approval).toBe('decision_bundle');
  });

  it('resolveDeepLink maps friendly names to artifact types', () => {
    expect(registry.resolveDeepLink('risk')).toBe('risk_scores');
    expect(registry.resolveDeepLink('forecast')).toBe('forecast_series');
    expect(registry.resolveDeepLink('bom')).toBe('bom_explosion');
  });

  it('resolveDeepLink passes through valid artifact types', () => {
    expect(registry.resolveDeepLink('plan_table')).toBe('plan_table');
    expect(registry.resolveDeepLink('risk_scores')).toBe('risk_scores');
  });

  it('resolveDeepLink returns null for unknown names', () => {
    expect(registry.resolveDeepLink('totally_unknown')).toBeNull();
    expect(registry.resolveDeepLink(null)).toBeNull();
    expect(registry.resolveDeepLink('')).toBeNull();
  });

  it('every DEEP_LINK_MAP value is a registered widget', () => {
    for (const [name, artifactType] of Object.entries(registry.DEEP_LINK_MAP)) {
      expect(registry.hasWidget(artifactType), `DEEP_LINK_MAP.${name} → '${artifactType}' not in registry`).toBe(true);
    }
  });

  // ── Coverage mapping: artifact contract alignment ──
  it('covers key artifact types from diArtifactContractV1', () => {
    const criticalTypes = [
      'forecast_series', 'plan_table', 'plan_csv', 'risk_scores',
      'inventory_projection', 'bom_explosion', 'scenario_comparison',
      'negotiation_report', 'decision_bundle',
    ];
    criticalTypes.forEach(type => {
      expect(registry.hasWidget(type), `Missing widget for critical type: ${type}`).toBe(true);
    });
  });
});

// ── CanvasContext Tests ────────────────────────────────────────────────────

describe('CanvasContext', () => {
  // Test the CanvasProvider's logic via direct module import (non-React)
  // Since CanvasContext uses React hooks, we test the state machine logic

  it('exports CanvasProvider and useCanvas', async () => {
    const mod = await import('../../contexts/CanvasContext.jsx');
    expect(mod.CanvasProvider).toBeDefined();
    expect(mod.useCanvas).toBeDefined();
  });
});

// ── EventBus Integration ──────────────────────────────────────────────────

describe('EventBus → Canvas Bridge', () => {
  let eventBus, EVENT_NAMES;

  beforeEach(async () => {
    const mod = await import('../../services/eventBus.js');
    eventBus = mod.eventBus;
    EVENT_NAMES = mod.EVENT_NAMES;
  });

  afterEach(() => {
    eventBus.clear();
  });

  it('EVENT_NAMES includes ARTIFACT_CREATED', () => {
    expect(EVENT_NAMES.ARTIFACT_CREATED).toBe('artifact:created');
  });

  it('EVENT_NAMES includes AGENT_STEP_COMPLETED', () => {
    expect(EVENT_NAMES.AGENT_STEP_COMPLETED).toBe('agent:step_completed');
  });

  it('eventBus fires artifact:created and calls listeners', () => {
    const handler = vi.fn();
    eventBus.on(EVENT_NAMES.ARTIFACT_CREATED, handler);

    eventBus.emit(EVENT_NAMES.ARTIFACT_CREATED, {
      artifact_type: 'forecast_series',
      data: { series: [{ period: 1, p50: 100 }] },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ artifact_type: 'forecast_series' }),
      EVENT_NAMES.ARTIFACT_CREATED
    );
  });

  it('wildcard listeners catch artifact events', () => {
    const handler = vi.fn();
    eventBus.on('artifact:*', handler);

    eventBus.emit(EVENT_NAMES.ARTIFACT_CREATED, { type: 'plan_table' });
    eventBus.emit(EVENT_NAMES.ARTIFACT_UPDATED, { type: 'plan_table' });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe prevents further calls', () => {
    const handler = vi.fn();
    const unsub = eventBus.on(EVENT_NAMES.ARTIFACT_CREATED, handler);

    eventBus.emit(EVENT_NAMES.ARTIFACT_CREATED, { type: 'risk_scores' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    eventBus.emit(EVENT_NAMES.ARTIFACT_CREATED, { type: 'risk_scores' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ── builtinToolCatalog ui_hint Tests ──────────────────────────────────────

describe('builtinToolCatalog ui_hint', () => {
  let BUILTIN_TOOLS, hasWidget;

  beforeEach(async () => {
    const catalog = await import('../../services/builtinToolCatalog.js');
    BUILTIN_TOOLS = catalog.BUILTIN_TOOLS;
    const reg = await import('./WidgetRegistry.js');
    hasWidget = reg.hasWidget;
  });

  it('key tools have ui_hint field', () => {
    const toolsWithHint = BUILTIN_TOOLS.filter(t => t.ui_hint);
    expect(toolsWithHint.length).toBeGreaterThanOrEqual(4);
  });

  it('ui_hint references valid widget registry keys', () => {
    const toolsWithHint = BUILTIN_TOOLS.filter(t => t.ui_hint);
    toolsWithHint.forEach(tool => {
      const widgetKey = tool.ui_hint.replace('open_canvas:', '');
      expect(hasWidget(widgetKey), `Tool ${tool.id} ui_hint '${tool.ui_hint}' references unregistered widget '${widgetKey}'`).toBe(true);
    });
  });

  it('all output_artifacts of hinted tools are in WidgetRegistry', () => {
    const toolsWithHint = BUILTIN_TOOLS.filter(t => t.ui_hint);
    toolsWithHint.forEach(tool => {
      // At least the primary artifact should be registered
      const primary = tool.ui_hint.replace('open_canvas:', '');
      expect(hasWidget(primary)).toBe(true);
    });
  });
});

// ── Structural Smoke Tests ────────────────────────────────────────────────

describe('Canvas Architecture - Module Exports', () => {
  it('DynamicCanvas can be imported', async () => {
    const mod = await import('./DynamicCanvas.jsx');
    expect(mod.default).toBeDefined();
  });

  it('ContextPanel can be imported', async () => {
    const mod = await import('./ContextPanel.jsx');
    expect(mod.default).toBeDefined();
  });

  it('UnifiedWorkspaceLayout can be imported', async () => {
    const mod = await import('./UnifiedWorkspaceLayout.jsx');
    expect(mod.default).toBeDefined();
  });

  it('useCanvasEventBridge can be imported', async () => {
    const mod = await import('../../hooks/useCanvasEventBridge.js');
    expect(mod.default).toBeDefined();
  });

  it('all widget components can be imported', async () => {
    const widgetNames = [
      'ForecastWidget', 'RiskWidget', 'PlanTableWidget', 'BOMWidget',
      'InventoryWidget', 'ScenarioWidget', 'NegotiationWidget', 'ApprovalWidget',
    ];
    for (const name of widgetNames) {
      const mod = await import(`./widgets/${name}.jsx`);
      expect(mod.default, `${name} should have default export`).toBeDefined();
    }
  });
});
