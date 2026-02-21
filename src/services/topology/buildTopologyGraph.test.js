import { describe, expect, it } from 'vitest';
import {
  buildTopologyGraph,
  buildSupplierNodeId,
  buildSkuNodeId,
  buildPlantNodeId,
  createTopologySettingsHash
} from './buildTopologyGraph';

const FIXED_GENERATED_AT = '2026-02-21T00:00:00.000Z';

const baseInput = () => ({
  run_id: 101,
  dataset_profile_id: 202,
  dataset_fingerprint: 'fp_test_1',
  generated_at: FIXED_GENERATED_AT,
  scope: {
    max_nodes: 200,
    max_edges: 300
  },
  datasets: {
    supplier_master: [
      { supplier_id: 'SUP_B', supplier_name: 'Supplier B' },
      { supplier_id: 'SUP_A', supplier_name: 'Supplier A' }
    ],
    po_open_lines: [
      { supplier_id: 'SUP_B', supplier_name: 'Supplier B', material_code: 'COMP_2', plant_id: 'PLT_1', open_qty: 18 },
      { supplier_id: 'SUP_A', supplier_name: 'Supplier A', material_code: 'COMP_1', plant_id: 'PLT_1', open_qty: 12 }
    ],
    goods_receipt: [],
    bom_edge: [
      { fg_sku: 'FG_1', component_sku: 'COMP_2', usage_qty: 2, valid_from: '2025-01-01', valid_to: '2025-12-31' },
      { fg_sku: 'FG_1', component_sku: 'COMP_1', usage_qty: 3, valid_from: '2025-01-01', valid_to: '2025-12-31' }
    ],
    demand_fg: [
      { fg_sku: 'FG_1', plant_id: 'PLT_1', demand_qty: 60, date: '2025-02-01' }
    ],
    inventory_snapshots: [
      { sku: 'COMP_1', plant_id: 'PLT_1', on_hand: 8, snapshot_date: '2025-02-01' },
      { sku: 'FG_1', plant_id: 'PLT_1', on_hand: 4, snapshot_date: '2025-02-01' }
    ]
  },
  artifacts: {
    plan_table: {
      rows: [
        { sku: 'FG_1', plant_id: 'PLT_1', order_qty: 22 },
        { sku: 'COMP_1', plant_id: 'PLT_1', order_qty: 11 }
      ]
    },
    inventory_projection: { rows: [] }
  },
  refs: {}
});

describe('buildTopologyGraph deterministic identity', () => {
  it('builds stable node IDs by entity key rules', () => {
    expect(buildSupplierNodeId('sup 01')).toBe('supplier:S_SUP_01');
    expect(buildSkuNodeId('fg-100/a')).toBe('sku:K_FG-100_A');
    expect(buildPlantNodeId('plant.us/w')).toBe('plant:P_PLANT.US_W');
  });

  it('creates stable settings hash for same scope/fingerprint', () => {
    const hashA = createTopologySettingsHash({
      dataset_fingerprint: 'fp_same',
      scope: { plant_ids: ['p2', 'p1'], sku_prefixes: ['fg_', 'comp_'], max_nodes: 400, max_edges: 500 }
    });
    const hashB = createTopologySettingsHash({
      dataset_fingerprint: 'fp_same',
      scope: { sku_prefixes: ['comp_', 'fg_'], plant_ids: ['p1', 'p2'], max_nodes: 400, max_edges: 500 }
    });
    expect(hashA).toBe(hashB);
  });
});

describe('buildTopologyGraph ordering', () => {
  it('returns stable node/edge ordering for the same graph semantics', () => {
    const inputA = baseInput();
    const inputB = baseInput();

    inputB.datasets.supplier_master.reverse();
    inputB.datasets.po_open_lines.reverse();
    inputB.datasets.bom_edge.reverse();
    inputB.artifacts.plan_table.rows.reverse();

    const graphA = buildTopologyGraph(inputA);
    const graphB = buildTopologyGraph(inputB);

    expect(graphA.nodes.map((item) => item.id)).toEqual(graphB.nodes.map((item) => item.id));
    expect(graphA.edges.map((item) => item.id)).toEqual(graphB.edges.map((item) => item.id));

    const sortedNodeIds = [...graphA.nodes.map((item) => item.id)].sort((a, b) => a.localeCompare(b));
    const sortedEdgeIds = [...graphA.edges.map((item) => item.id)].sort((a, b) => a.localeCompare(b));
    expect(graphA.nodes.map((item) => item.id)).toEqual(sortedNodeIds);
    expect(graphA.edges.map((item) => item.id)).toEqual(sortedEdgeIds);
  });
});

describe('buildTopologyGraph aggregation', () => {
  it('collapses graph deterministically when node/edge limits are exceeded', () => {
    const manyComponents = Array.from({ length: 180 }).map((_, idx) => ({
      fg_sku: 'FG_MAIN',
      component_sku: `COMP_${String(idx + 1).padStart(3, '0')}`,
      usage_qty: idx + 1,
      valid_from: '2025-01-01',
      valid_to: '2025-12-31'
    }));

    const input = {
      ...baseInput(),
      scope: {
        max_nodes: 70,
        max_edges: 100
      },
      datasets: {
        ...baseInput().datasets,
        bom_edge: manyComponents,
        demand_fg: [{ fg_sku: 'FG_MAIN', plant_id: 'PLT_1', demand_qty: 500, date: '2025-02-01' }]
      },
      artifacts: {
        plan_table: {
          rows: manyComponents.slice(0, 120).map((row, idx) => ({
            sku: row.component_sku,
            plant_id: 'PLT_1',
            order_qty: idx + 5
          }))
        },
        inventory_projection: { rows: [] }
      }
    };

    const graph = buildTopologyGraph(input);

    expect(graph.nodes.length).toBeLessThanOrEqual(70);
    expect(graph.edges.length).toBeLessThanOrEqual(100);
    expect(graph.overlays.summary.collapsed_node_count).toBeGreaterThan(0);
    expect(
      graph.nodes.some((node) => node.id.includes('_OTHER_') || node.id === 'supplier:S_OTHER' || node.id === 'plant:P_OTHER')
    ).toBe(true);
  });
});

describe('buildTopologyGraph overlays', () => {
  it('merges risk and bottlenecks overlays without breaking base graph structure', () => {
    const input = {
      ...baseInput(),
      artifacts: {
        ...baseInput().artifacts,
        risk_scores: {
          rows: [
            {
              entity_type: 'supplier',
              entity_id: 'SUP_A',
              supplier: 'SUP_A',
              risk_score: 77,
              metrics: { overdue_ratio: 0.3, avg_delay_days: 6 }
            },
            {
              entity_type: 'material',
              entity_id: 'COMP_1',
              material_code: 'COMP_1',
              risk_score: 65,
              metrics: { overdue_ratio: 0.2, avg_delay_days: 4 }
            }
          ]
        },
        bottlenecks: {
          rows: [
            { sku: 'COMP_1', score: 99, reason: 'critical_shortage' },
            { source_sku: 'FG_1', target_sku: 'COMP_1', score: 88, reason: 'high_usage_link' }
          ]
        }
      }
    };

    const graph = buildTopologyGraph(input);
    const bomEdge = graph.edges.find((edge) => edge.type === 'bom' && edge.source === 'sku:K_FG_1' && edge.target === 'sku:K_COMP_1');

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(bomEdge).toBeTruthy();

    expect(graph.overlays.risk).toBeTruthy();
    expect(graph.overlays.bottlenecks).toBeTruthy();
    expect(Array.isArray(graph.overlays.bottlenecks.node_ids)).toBe(true);
    expect(graph.overlays.bottlenecks.node_ids).toContain('sku:K_COMP_1');
  });
});
