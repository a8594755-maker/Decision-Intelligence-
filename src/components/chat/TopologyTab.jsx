import React, { useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '../ui';

const LANE_ORDER = {
  supplier: 0,
  component: 1,
  plant: 2,
  fg: 3,
  sink: 4
};

const edgeTypeEnabledByKey = (toggles, edgeType) => {
  if (edgeType === 'bom') return toggles.showBom;
  if (edgeType === 'inbound') return toggles.showInbound;
  if (edgeType === 'demand') return toggles.showDemand;
  if (edgeType === 'plan') return toggles.showPlan;
  if (edgeType === 'fg_supply') return true;
  return true;
};

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatMetricValue = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isFinite(Number(value))) {
    return Number(value).toLocaleString();
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
};

const buildEdgeLabel = (edge) => {
  const metrics = edge?.metrics || {};
  const candidates = [
    ['flow_qty', 'flow'],
    ['open_qty', 'open'],
    ['demand_qty', 'demand'],
    ['plan_qty', 'plan'],
    ['usage_qty', 'usage']
  ];

  for (const [key, label] of candidates) {
    const value = toNumber(metrics[key], NaN);
    if (Number.isFinite(value)) {
      return `${label}: ${value.toLocaleString()}`;
    }
  }

  return edge?.type || '';
};

const buildPlantOptions = (topologyGraph) => {
  const allPlants = (Array.isArray(topologyGraph?.nodes) ? topologyGraph.nodes : [])
    .filter((node) => node?.type === 'plant')
    .map((node) => ({
      id: node.id,
      plant_id: String(node?.refs?.plant_id || '').trim(),
      label: node.label || node.id
    }))
    .filter((item) => item.plant_id)
    .sort((a, b) => a.plant_id.localeCompare(b.plant_id));
  return allPlants;
};

const getNodeIdSetForPlant = (topologyGraph, plantId) => {
  if (!plantId) return null;
  const nodes = Array.isArray(topologyGraph?.nodes) ? topologyGraph.nodes : [];
  const edges = Array.isArray(topologyGraph?.edges) ? topologyGraph.edges : [];
  const matchedPlantNodes = nodes
    .filter((node) => String(node?.refs?.plant_id || '').trim() === plantId)
    .map((node) => node.id);
  if (matchedPlantNodes.length === 0) return new Set();

  const visible = new Set(matchedPlantNodes);
  const queue = [...matchedPlantNodes];
  while (queue.length > 0) {
    const current = queue.shift();
    edges.forEach((edge) => {
      if (edge.source === current && !visible.has(edge.target)) {
        visible.add(edge.target);
        queue.push(edge.target);
      } else if (edge.target === current && !visible.has(edge.source)) {
        visible.add(edge.source);
        queue.push(edge.source);
      }
    });
  }
  return visible;
};

const getNodeIdSetForSkuQuery = (topologyGraph, skuQuery) => {
  const query = String(skuQuery || '').trim().toLowerCase();
  if (!query) return null;

  const nodes = Array.isArray(topologyGraph?.nodes) ? topologyGraph.nodes : [];
  const edges = Array.isArray(topologyGraph?.edges) ? topologyGraph.edges : [];
  const matched = nodes
    .filter((node) => node?.type === 'fg' || node?.type === 'component')
    .filter((node) => {
      const idText = String(node.id || '').toLowerCase();
      const labelText = String(node.label || '').toLowerCase();
      return idText.includes(query) || labelText.includes(query);
    })
    .map((node) => node.id);

  if (matched.length === 0) return new Set();

  const visible = new Set(matched);
  edges.forEach((edge) => {
    if (visible.has(edge.source)) visible.add(edge.target);
    if (visible.has(edge.target)) visible.add(edge.source);
  });
  return visible;
};

const intersectSets = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  const output = new Set();
  left.forEach((value) => {
    if (right.has(value)) output.add(value);
  });
  return output;
};

export default function TopologyTab({
  topologyGraph,
  topologyRunId = null,
  onRunTopology,
  topologyRunning = false
}) {
  const [skuQuery, setSkuQuery] = useState('');
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [selectedItem, setSelectedItem] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toggles, setToggles] = useState({
    showBom: true,
    showInbound: true,
    showDemand: true,
    showPlan: true,
    showRiskOverlay: true,
    showBottlenecksOverlay: true
  });

  const plantOptions = useMemo(() => buildPlantOptions(topologyGraph), [topologyGraph]);
  const edgeMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(topologyGraph?.edges) ? topologyGraph.edges : []).forEach((edge) => {
      map.set(edge.id, edge);
    });
    return map;
  }, [topologyGraph]);

  const riskNodeSet = useMemo(() => {
    if (!toggles.showRiskOverlay) return new Set();
    const overlay = topologyGraph?.overlays?.risk || {};
    const ids = [];
    (Array.isArray(overlay.suppliers) ? overlay.suppliers : []).forEach((item) => ids.push(item.node_id));
    (Array.isArray(overlay.materials) ? overlay.materials : []).forEach((item) => ids.push(item.node_id));
    return new Set(ids.filter(Boolean));
  }, [topologyGraph, toggles.showRiskOverlay]);

  const bottleneckNodeSet = useMemo(() => {
    if (!toggles.showBottlenecksOverlay) return new Set();
    const ids = Array.isArray(topologyGraph?.overlays?.bottlenecks?.node_ids)
      ? topologyGraph.overlays.bottlenecks.node_ids
      : [];
    return new Set(ids.filter(Boolean));
  }, [topologyGraph, toggles.showBottlenecksOverlay]);

  const bottleneckEdgeSet = useMemo(() => {
    if (!toggles.showBottlenecksOverlay) return new Set();
    const ids = Array.isArray(topologyGraph?.overlays?.bottlenecks?.edge_ids)
      ? topologyGraph.overlays.bottlenecks.edge_ids
      : [];
    return new Set(ids.filter(Boolean));
  }, [topologyGraph, toggles.showBottlenecksOverlay]);

  const filteredGraph = useMemo(() => {
    if (!topologyGraph) {
      return {
        nodes: [],
        edges: []
      };
    }

    const allNodes = Array.isArray(topologyGraph.nodes) ? topologyGraph.nodes : [];
    const allEdges = Array.isArray(topologyGraph.edges) ? topologyGraph.edges : [];

    const plantNodeSet = selectedPlant === 'all'
      ? null
      : getNodeIdSetForPlant(topologyGraph, selectedPlant);
    const skuNodeSet = skuQuery
      ? getNodeIdSetForSkuQuery(topologyGraph, skuQuery)
      : null;
    const allowedNodeSet = intersectSets(plantNodeSet, skuNodeSet);

    const visibleNodes = allNodes.filter((node) => !allowedNodeSet || allowedNodeSet.has(node.id));
    const visibleNodeIdSet = new Set(visibleNodes.map((node) => node.id));

    const visibleEdges = allEdges
      .filter((edge) => edgeTypeEnabledByKey(toggles, edge.type))
      .filter((edge) => visibleNodeIdSet.has(edge.source) && visibleNodeIdSet.has(edge.target));

    const connectedNodes = new Set();
    visibleEdges.forEach((edge) => {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    });

    const finalNodes = visibleNodes.filter((node) => {
      if (connectedNodes.has(node.id)) return true;
      if (node.type === 'sink') return false;
      if (!allowedNodeSet) return false;
      return allowedNodeSet.has(node.id);
    });

    return {
      nodes: finalNodes,
      edges: visibleEdges
    };
  }, [topologyGraph, selectedPlant, skuQuery, toggles]);

  const flowData = useMemo(() => {
    const laneBuckets = new Map();
    filteredGraph.nodes.forEach((node) => {
      const lane = LANE_ORDER[node.type] ?? 5;
      if (!laneBuckets.has(lane)) laneBuckets.set(lane, []);
      laneBuckets.get(lane).push(node);
    });

    laneBuckets.forEach((nodes) => {
      nodes.sort((a, b) => a.id.localeCompare(b.id));
    });

    const flowNodes = [];
    laneBuckets.forEach((nodes, lane) => {
      nodes.forEach((node, index) => {
        const isBottleneck = bottleneckNodeSet.has(node.id);
        const isRisk = riskNodeSet.has(node.id);

        flowNodes.push({
          id: node.id,
          data: {
            label: (
              <div className="text-[10px] leading-tight">
                <div className="font-medium truncate max-w-[180px]">{node.label || node.id}</div>
                <div className="text-slate-500 truncate max-w-[180px]">{node.type}</div>
              </div>
            ),
            raw: node
          },
          position: {
            x: lane * 280,
            y: index * 90
          },
          style: {
            fontSize: 10,
            minWidth: 170,
            borderRadius: 10,
            border: isBottleneck
              ? '2px solid #dc2626'
              : isRisk
                ? '2px solid #d97706'
                : '1px solid #cbd5e1',
            boxShadow: isBottleneck ? '0 0 0 2px rgba(220,38,38,0.12)' : 'none'
          }
        });
      });
    });

    const flowEdges = filteredGraph.edges.map((edge) => {
      const isBottleneck = bottleneckEdgeSet.has(edge.id);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        label: buildEdgeLabel(edge),
        data: { raw: edge },
        style: isBottleneck
          ? { stroke: '#dc2626', strokeWidth: 2.2 }
          : { strokeWidth: 1.2 },
        animated: edge.type === 'plan'
      };
    });

    return { flowNodes, flowEdges };
  }, [filteredGraph, bottleneckNodeSet, bottleneckEdgeSet, riskNodeSet]);

  // Bottleneck root cause analysis
  const bottleneckAnalysis = useMemo(() => {
    if (!topologyGraph || bottleneckNodeSet.size === 0) return [];
    const nodes = Array.isArray(topologyGraph.nodes) ? topologyGraph.nodes : [];
    const edges = Array.isArray(topologyGraph.edges) ? topologyGraph.edges : [];
    const analyses = [];

    bottleneckNodeSet.forEach((nodeId) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const metrics = node.metrics || {};
      const reasons = [];

      // Supplier: capacity / lead time issues
      if (node.type === 'supplier') {
        if (toNumber(metrics.capacity_utilization, 0) > 90) {
          reasons.push(`capacity utilization at ${toNumber(metrics.capacity_utilization, 0)}% (>90%)`);
        }
        if (toNumber(metrics.on_time_rate, 100) < 80) {
          reasons.push(`on-time rate only ${toNumber(metrics.on_time_rate, 0)}%`);
        }
        if (toNumber(metrics.avg_delay_days, 0) > 3) {
          reasons.push(`avg delay ${toNumber(metrics.avg_delay_days, 0)} days`);
        }
        if (reasons.length === 0) reasons.push('flagged as constrained supplier');
      }
      // Component: shortage / high demand
      else if (node.type === 'component') {
        const supply = toNumber(metrics.available_qty ?? metrics.supply_qty, 0);
        const demand = toNumber(metrics.required_qty ?? metrics.demand_qty, 0);
        if (demand > 0 && supply < demand) {
          reasons.push(`supply (${supply.toLocaleString()}) < demand (${demand.toLocaleString()})`);
        }
        if (toNumber(metrics.stockout_risk, 0) > 0.5) {
          reasons.push(`stockout risk ${(toNumber(metrics.stockout_risk, 0) * 100).toFixed(0)}%`);
        }
        if (reasons.length === 0) reasons.push('material shortage detected');
      }
      // Plant: overloaded
      else if (node.type === 'plant') {
        if (toNumber(metrics.utilization, 0) > 95) {
          reasons.push(`plant utilization at ${toNumber(metrics.utilization, 0)}%`);
        }
        if (reasons.length === 0) reasons.push('plant capacity constraint');
      }
      // FG: demand exceeds supply
      else if (node.type === 'fg') {
        const supply = toNumber(metrics.planned_qty ?? metrics.supply_qty, 0);
        const demand = toNumber(metrics.demand_qty, 0);
        if (demand > 0 && supply < demand) {
          reasons.push(`planned supply (${supply.toLocaleString()}) cannot meet demand (${demand.toLocaleString()})`);
        }
        if (reasons.length === 0) reasons.push('finished goods supply gap');
      }
      else {
        reasons.push('constraint detected');
      }

      // Find upstream dependencies
      const upstreamEdges = edges.filter((e) => e.target === nodeId);
      const upstreamBottlenecks = upstreamEdges
        .filter((e) => bottleneckNodeSet.has(e.source))
        .map((e) => {
          const src = nodes.find((n) => n.id === e.source);
          return src?.label || e.source;
        });

      analyses.push({
        nodeId,
        label: node.label || nodeId,
        type: node.type,
        reasons,
        upstreamBottlenecks,
      });
    });

    return analyses;
  }, [topologyGraph, bottleneckNodeSet]);

  const overlaySummary = useMemo(() => {
    const risk = topologyGraph?.overlays?.risk || {};
    const bottlenecks = topologyGraph?.overlays?.bottlenecks || {};
    const plan = topologyGraph?.overlays?.plan || {};

    return {
      highRisk: toNumber(risk.high_risk_count, 0),
      mediumRisk: toNumber(risk.medium_risk_count, 0),
      bottleneckNodes: Array.isArray(bottlenecks.node_ids) ? bottlenecks.node_ids.length : 0,
      bottleneckEdges: Array.isArray(bottlenecks.edge_ids) ? bottlenecks.edge_ids.length : 0,
      planRows: toNumber(plan.total_plan_rows, 0)
    };
  }, [topologyGraph]);

  if (!topologyGraph) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          No `topology_graph.json` artifact available for the selected run.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => onRunTopology?.(topologyRunId)}
            disabled={!topologyRunId || topologyRunning}
          >
            {topologyRunning ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Running Topology...
              </span>
            ) : 'Run Topology'}
          </Button>
          {!topologyRunId && (
            <span className="text-[11px] text-slate-500">Run a workflow first to get a valid run id.</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={isFullscreen ? 'fixed inset-0 z-50 bg-white dark:bg-slate-900 overflow-y-auto p-4 space-y-3' : 'space-y-3'}>
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <label className="text-xs text-slate-600 dark:text-slate-300">
            Plant
            <select
              className="mt-1 w-full rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
              value={selectedPlant}
              onChange={(event) => setSelectedPlant(event.target.value)}
            >
              <option value="all">All plants</option>
              {plantOptions.map((plant) => (
                <option key={plant.id} value={plant.plant_id}>
                  {plant.plant_id}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">
            SKU Search
            <input
              className="mt-1 w-full rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
              value={skuQuery}
              onChange={(event) => setSkuQuery(event.target.value)}
              placeholder="FG-100 / COMP-01 ..."
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-3 text-[11px] text-slate-600 dark:text-slate-300">
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={toggles.showBom} onChange={(event) => setToggles((prev) => ({ ...prev, showBom: event.target.checked }))} />
            BOM edges
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={toggles.showInbound} onChange={(event) => setToggles((prev) => ({ ...prev, showInbound: event.target.checked }))} />
            Inbound PO edges
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={toggles.showDemand} onChange={(event) => setToggles((prev) => ({ ...prev, showDemand: event.target.checked }))} />
            Demand edges
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={toggles.showPlan} onChange={(event) => setToggles((prev) => ({ ...prev, showPlan: event.target.checked }))} />
            Plan edges
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={toggles.showRiskOverlay} onChange={(event) => setToggles((prev) => ({ ...prev, showRiskOverlay: event.target.checked }))} />
            Risk overlay
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={toggles.showBottlenecksOverlay} onChange={(event) => setToggles((prev) => ({ ...prev, showBottlenecksOverlay: event.target.checked }))} />
            Bottlenecks overlay
          </label>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-500">
            Nodes: {filteredGraph.nodes.length} / {topologyGraph.nodes.length} | Edges: {filteredGraph.edges.length} / {topologyGraph.edges.length}
            {' | '}
            High risk: {overlaySummary.highRisk} | Medium risk: {overlaySummary.mediumRisk}
            {' | '}
            Bottlenecks: {overlaySummary.bottleneckNodes} nodes, {overlaySummary.bottleneckEdges} edges
            {' | '}
            Plan rows: {overlaySummary.planRows}
          </div>
          <button
            type="button"
            onClick={() => setIsFullscreen((prev) => !prev)}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 flex-shrink-0"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        {bottleneckAnalysis.length > 0 && toggles.showBottlenecksOverlay && (
          <div className="text-[11px] bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2 space-y-1">
            <p className="font-medium text-red-700 dark:text-red-300">Bottleneck Root Cause Analysis</p>
            {bottleneckAnalysis.map((item) => (
              <div key={item.nodeId} className="text-red-600 dark:text-red-400">
                <span className="font-medium">{item.label}</span>
                <span className="text-red-400 dark:text-red-500"> ({item.type})</span>
                {': '}
                {item.reasons.join('; ')}
                {item.upstreamBottlenecks.length > 0 && (
                  <span className="text-red-400 dark:text-red-500">
                    {' '}— cascaded from: {item.upstreamBottlenecks.join(', ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-3 ${isFullscreen ? 'min-h-[calc(100vh-220px)]' : 'min-h-[480px]'}`}>
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className={isFullscreen ? 'h-[calc(100vh-240px)]' : 'h-[540px]'}>
            <ReactFlow
              nodes={flowData.flowNodes}
              edges={flowData.flowEdges}
              fitView
              minZoom={0.1}
              maxZoom={2}
              onNodeClick={(_, node) => setSelectedItem({ kind: 'node', raw: node?.data?.raw || null })}
              onEdgeClick={(_, edge) => setSelectedItem({ kind: 'edge', raw: edgeMap.get(edge.id) || edge?.data?.raw || null })}
              nodesDraggable={false}
            >
              <MiniMap zoomable pannable />
              <Controls />
              <Background gap={16} size={1} />
            </ReactFlow>
          </div>
        </div>

        <div className={`rounded-xl border border-slate-200 dark:border-slate-700 p-3 overflow-y-auto ${isFullscreen ? 'max-h-[calc(100vh-240px)]' : 'max-h-[540px]'}`}>
          {!selectedItem?.raw ? (
            <p className="text-xs text-slate-500">
              Click a node or edge to inspect metrics and artifact references.
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {selectedItem.kind === 'node' ? 'Node' : 'Edge'}
                </p>
                <p className="text-sm font-semibold break-all">
                  {selectedItem.raw.label || selectedItem.raw.id}
                </p>
                <p className="text-xs text-slate-500 break-all">
                  {selectedItem.raw.id}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium mb-1">Metrics</p>
                <div className="space-y-1">
                  {Object.entries(selectedItem.raw.metrics || {}).length === 0 ? (
                    <p className="text-xs text-slate-500">No metrics.</p>
                  ) : (
                    Object.entries(selectedItem.raw.metrics || {})
                      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
                      .map(([key, value]) => (
                        <div key={key} className="text-xs flex items-start justify-between gap-2">
                          <span className="text-slate-500 break-all">{key}</span>
                          <span className="text-slate-800 dark:text-slate-200 break-all text-right">{formatMetricValue(value)}</span>
                        </div>
                      ))
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs font-medium mb-1">Refs</p>
                <div className="space-y-1">
                  {Object.entries(selectedItem.raw.refs || {}).length === 0 ? (
                    <p className="text-xs text-slate-500">No references.</p>
                  ) : (
                    Object.entries(selectedItem.raw.refs || {})
                      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
                      .map(([key, value]) => (
                        <div key={key} className="text-xs flex items-start justify-between gap-2">
                          <span className="text-slate-500 break-all">{key}</span>
                          <span className="text-slate-800 dark:text-slate-200 break-all text-right">{formatMetricValue(value)}</span>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
