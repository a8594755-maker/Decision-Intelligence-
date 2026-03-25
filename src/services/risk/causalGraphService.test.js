import { describe, it, expect } from 'vitest';
import {
  CAUSAL_LAYERS,
  createCausalNode,
  linkCause,
  buildStockoutCausalGraph,
  buildInfeasibilityCausalGraph,
  buildCausalSummaryText,
  serializeCausalGraph,
} from './causalGraphService';

describe('createCausalNode', () => {
  it('creates a node with all fields', () => {
    const node = createCausalNode({
      layer: CAUSAL_LAYERS.SYMPTOM,
      title: 'Test Symptom',
      detail: 'Some detail',
      entity: { type: 'material', id: 'MAT-001' },
      severity: 'critical',
    });
    expect(node.id).toMatch(/^cn_/);
    expect(node.layer).toBe('symptom');
    expect(node.title).toBe('Test Symptom');
    expect(node.severity).toBe('critical');
    expect(node.children).toEqual([]);
  });
});

describe('linkCause', () => {
  it('links parent to child', () => {
    const parent = createCausalNode({ layer: 'symptom', title: 'P' });
    const child = createCausalNode({ layer: 'proximate', title: 'C' });
    linkCause(parent, child);
    expect(parent.children).toContain(child.id);
  });

  it('does not duplicate links', () => {
    const parent = createCausalNode({ layer: 'symptom', title: 'P' });
    const child = createCausalNode({ layer: 'proximate', title: 'C' });
    linkCause(parent, child);
    linkCause(parent, child);
    expect(parent.children).toHaveLength(1);
  });

  it('handles null gracefully', () => {
    linkCause(null, null); // should not throw
  });
});

describe('buildStockoutCausalGraph', () => {
  it('builds graph for stockout items', () => {
    const graph = buildStockoutCausalGraph({
      stockoutItems: [
        { material_code: 'MAT-001', plant_id: 'P1', gap_qty: 50, days_to_stockout: 3 },
      ],
      planRunId: 100,
    });

    const nodeList = Object.values(graph.nodes);
    expect(graph.roots.length).toBeGreaterThan(0);
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.SYMPTOM)).toBe(true);
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.PROXIMATE)).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('adds risk-based causes when risk scores provided', () => {
    const graph = buildStockoutCausalGraph({
      stockoutItems: [
        { material_code: 'MAT-001', plant_id: 'P1', gap_qty: 50 },
      ],
      riskScores: [
        { material_code: 'MAT-001', plant_id: 'P1', risk_score: 130, entity_id: 'MAT-001', metrics: { on_time_rate: 0.7, p90_delay_days: 8, overdue_ratio: 0.3 } },
      ],
    });

    const nodeList = Object.values(graph.nodes);
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.CONTRIBUTING && n.title.includes('risk'))).toBe(true);
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.ROOT && n.title.includes('reliability'))).toBe(true);
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.ACTION && n.title.includes('risk-aware'))).toBe(true);
    // Critical risk → dual sourcing action
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.ACTION && n.title.includes('dual sourcing'))).toBe(true);
  });

  it('adds forecast-based causes when MAPE is high', () => {
    const graph = buildStockoutCausalGraph({
      stockoutItems: [
        { material_code: 'MAT-002', plant_id: 'P1', gap_qty: 30 },
      ],
      forecastMetrics: { mape: 35 },
    });

    const nodeList = Object.values(graph.nodes);
    expect(nodeList.some(n => n.title.includes('forecast accuracy'))).toBe(true);
    expect(nodeList.some(n => n.title.includes('demand data'))).toBe(true);
    expect(nodeList.some(n => n.title.includes('Refresh'))).toBe(true);
  });

  it('adds constraint-based causes when binding constraints exist', () => {
    const graph = buildStockoutCausalGraph({
      stockoutItems: [
        { material_code: 'MAT-003', plant_id: 'P1', gap_qty: 20 },
      ],
      solverResult: {
        proof: { constraints_checked: [{ name: 'budget_cap', binding: true, slack: 0 }] },
      },
    });

    const nodeList = Object.values(graph.nodes);
    expect(nodeList.some(n => n.title.includes('binding constraint'))).toBe(true);
    expect(nodeList.some(n => n.title.includes('negotiation'))).toBe(true);
  });

  it('returns empty for no stockout items', () => {
    const graph = buildStockoutCausalGraph({ stockoutItems: [] });
    expect(Object.keys(graph.nodes)).toHaveLength(0);
    expect(graph.roots).toHaveLength(0);
  });

  it('limits to max 5 items', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      material_code: `MAT-${i}`, plant_id: 'P1', gap_qty: 10,
    }));
    const graph = buildStockoutCausalGraph({ stockoutItems: items });
    const symptoms = Object.values(graph.nodes).filter(n => n.layer === CAUSAL_LAYERS.SYMPTOM);
    expect(symptoms.length).toBeLessThanOrEqual(5);
  });
});

describe('buildInfeasibilityCausalGraph', () => {
  it('builds graph for budget-related infeasibility', () => {
    const graph = buildInfeasibilityCausalGraph({
      solverResult: { status: 'infeasible', infeasible_reasons: ['Budget too low'] },
    });

    const nodeList = Object.values(graph.nodes);
    expect(graph.roots.length).toBe(1);
    expect(nodeList.some(n => n.layer === CAUSAL_LAYERS.SYMPTOM && n.title === 'Plan is infeasible')).toBe(true);
    expect(nodeList.some(n => n.title.includes('Budget'))).toBe(true);
    expect(nodeList.some(n => n.title.includes('Negotiate budget'))).toBe(true);
  });

  it('builds graph for service target infeasibility', () => {
    const graph = buildInfeasibilityCausalGraph({
      solverResult: { status: 'infeasible', infeasible_reasons: ['Service target too high'] },
    });

    const nodeList = Object.values(graph.nodes);
    expect(nodeList.some(n => n.title.includes('Service level target'))).toBe(true);
    expect(nodeList.some(n => n.title.includes('Relax'))).toBe(true);
  });

  it('falls back to generic for unknown infeasibility', () => {
    const graph = buildInfeasibilityCausalGraph({
      solverResult: { status: 'infeasible', infeasible_reasons: [] },
    });

    const nodeList = Object.values(graph.nodes);
    expect(nodeList.some(n => n.title.includes('Conflicting'))).toBe(true);
    expect(nodeList.some(n => n.title.includes('negotiation'))).toBe(true);
  });
});

describe('buildCausalSummaryText', () => {
  it('returns fallback for empty graph', () => {
    expect(buildCausalSummaryText({ nodes: {}, edges: [], roots: [] })).toBe('No causal analysis available.');
  });

  it('builds summary from graph', () => {
    const graph = buildStockoutCausalGraph({
      stockoutItems: [{ material_code: 'MAT-001', plant_id: 'P1', gap_qty: 50 }],
      riskScores: [{ material_code: 'MAT-001', plant_id: 'P1', risk_score: 100, entity_id: 'MAT-001', metrics: {} }],
    });
    const text = buildCausalSummaryText(graph);
    expect(text).toContain('Root Cause Analysis');
    expect(text).toContain('MAT-001');
  });
});

describe('serializeCausalGraph', () => {
  it('serializes graph to flat structure', () => {
    const graph = buildStockoutCausalGraph({
      stockoutItems: [{ material_code: 'MAT-001', plant_id: 'P1', gap_qty: 50 }],
    });
    const serialized = serializeCausalGraph(graph);
    expect(Array.isArray(serialized.nodes)).toBe(true);
    expect(Array.isArray(serialized.edges)).toBe(true);
    expect(Array.isArray(serialized.roots)).toBe(true);
    expect(serialized.nodes.length).toBeGreaterThan(0);
  });
});
