const DEFAULT_MAX_NODES = 900;
const DEFAULT_MAX_EDGES = 1800;

const DEMAND_SINK_NODE_ID = 'sink:D_DEMAND';

const EDGE_WEIGHT_KEYS = [
  'flow_qty',
  'open_qty',
  'demand_qty',
  'plan_qty',
  'usage_qty',
  'total_qty',
  'qty'
];

const nowIso = () => new Date().toISOString();

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value) => String(value || '').trim();

const normalizeToken = (value, fallback = 'UNKNOWN') => {
  const base = normalizeText(value).toUpperCase();
  if (!base) return fallback;

  const normalized = base
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const normalizePlantId = (value) => normalizeToken(value, 'UNKNOWN_PLANT');
const normalizeSku = (value) => normalizeToken(value, 'UNKNOWN_SKU');
const normalizeSupplierId = (value) => normalizeToken(value, 'UNKNOWN_SUPPLIER');

const inferSkuFamily = (skuToken) => {
  const token = normalizeSku(skuToken);
  const parts = token.split(/[-_.]/).filter(Boolean);
  if (parts.length === 0) return token.slice(0, 4) || 'OTHER';
  return parts[0] || 'OTHER';
};

export const buildSupplierNodeId = (supplierId) => `supplier:S_${normalizeSupplierId(supplierId)}`;
export const buildSkuNodeId = (sku) => `sku:K_${normalizeSku(sku)}`;
export const buildPlantNodeId = (plantId) => `plant:P_${normalizePlantId(plantId)}`;
export const buildDemandSinkNodeId = () => DEMAND_SINK_NODE_ID;

const round6 = (value) => Number(toNumber(value, 0).toFixed(6));

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const fnv1aHash = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const normalizeScope = (scope = {}) => {
  const plantIds = Array.from(new Set((Array.isArray(scope.plant_ids) ? scope.plant_ids : [])
    .map((value) => normalizeToken(value, ''))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  const skuPrefixes = Array.from(new Set((Array.isArray(scope.sku_prefixes) ? scope.sku_prefixes : [])
    .map((value) => normalizeToken(value, ''))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  const maxNodes = Math.max(50, Math.floor(toNumber(scope.max_nodes, DEFAULT_MAX_NODES)));
  const maxEdges = Math.max(100, Math.floor(toNumber(scope.max_edges, DEFAULT_MAX_EDGES)));

  return {
    plant_ids: plantIds,
    sku_prefixes: skuPrefixes,
    max_nodes: maxNodes,
    max_edges: maxEdges
  };
};

export const createTopologySettingsHash = ({ dataset_fingerprint = '', scope = {} } = {}) => {
  const payload = {
    dataset_fingerprint: String(dataset_fingerprint || ''),
    scope: normalizeScope(scope)
  };
  return fnv1aHash(stableStringify(payload));
};

const mergeMetricObjects = (left = {}, right = {}) => {
  const merged = { ...(left || {}) };
  Object.entries(right || {}).forEach(([key, value]) => {
    if (Number.isFinite(value) && Number.isFinite(merged[key])) {
      merged[key] = round6(Number(merged[key]) + Number(value));
      return;
    }
    if (Number.isFinite(value) && merged[key] === undefined) {
      merged[key] = round6(Number(value));
      return;
    }
    if (Array.isArray(value)) {
      const existing = Array.isArray(merged[key]) ? merged[key] : [];
      merged[key] = Array.from(new Set([...existing, ...value].map((item) => String(item))));
      return;
    }
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') {
      merged[key] = value;
    }
  });
  return merged;
};

const ensureNode = (nodesById, {
  id,
  type,
  label,
  metrics = {},
  refs = {}
}) => {
  if (!id) return null;
  const existing = nodesById.get(id);
  if (!existing) {
    const created = {
      id,
      type,
      label: label || id,
      metrics: { ...metrics },
      refs: { ...refs }
    };
    nodesById.set(id, created);
    return created;
  }

  existing.type = existing.type || type;
  if (!existing.label && label) existing.label = label;
  existing.metrics = mergeMetricObjects(existing.metrics, metrics);
  existing.refs = {
    ...(existing.refs || {}),
    ...(refs || {})
  };
  return existing;
};

const upsertEdge = (edgesById, edge) => {
  if (!edge?.id || !edge?.source || !edge?.target) return null;

  const existing = edgesById.get(edge.id);
  if (!existing) {
    const created = {
      id: edge.id,
      type: edge.type,
      source: edge.source,
      target: edge.target,
      metrics: { ...(edge.metrics || {}) },
      refs: { ...(edge.refs || {}) }
    };
    edgesById.set(edge.id, created);
    return created;
  }

  existing.metrics = mergeMetricObjects(existing.metrics, edge.metrics || {});
  existing.refs = {
    ...(existing.refs || {}),
    ...(edge.refs || {})
  };
  return existing;
};

const edgeMagnitude = (edge) => {
  const metrics = edge?.metrics || {};
  for (const key of EDGE_WEIGHT_KEYS) {
    const value = toNumber(metrics[key], NaN);
    if (Number.isFinite(value) && Math.abs(value) > 0) return Math.abs(value);
  }
  return 1;
};

const parseSkuPrefixPredicate = (scope) => {
  const prefixes = (scope?.sku_prefixes || []).map((value) => normalizeToken(value, ''));
  if (prefixes.length === 0) return () => true;
  return (sku) => {
    const token = normalizeSku(sku);
    return prefixes.some((prefix) => token.startsWith(prefix));
  };
};

const parsePlantPredicate = (scope) => {
  const plants = new Set((scope?.plant_ids || []).map((value) => normalizeToken(value, '')));
  if (plants.size === 0) return () => true;
  return (plantId) => plants.has(normalizePlantId(plantId));
};

const normalizeBottleneckRows = (payload = null) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const rows = [];
  const candidates = ['rows', 'bottlenecks', 'top_bottlenecks', 'components', 'items', 'edges'];
  candidates.forEach((key) => {
    if (Array.isArray(payload?.[key])) {
      rows.push(...payload[key]);
    }
  });
  return rows;
};

const rankDescThenId = (left, right, key = 'score') => {
  const scoreLeft = toNumber(left?.[key], 0);
  const scoreRight = toNumber(right?.[key], 0);
  if (scoreLeft !== scoreRight) return scoreRight - scoreLeft;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
};

const collapseGraphForLimits = ({ nodes, edges, maxNodes, maxEdges }) => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const impactByNode = new Map(nodes.map((node) => [node.id, 0]));

  edges.forEach((edge) => {
    const magnitude = edgeMagnitude(edge);
    impactByNode.set(edge.source, (impactByNode.get(edge.source) || 0) + magnitude);
    impactByNode.set(edge.target, (impactByNode.get(edge.target) || 0) + magnitude);
  });

  const sortedNodesByImpact = [...nodes].sort((a, b) => {
    const impactDiff = (impactByNode.get(b.id) || 0) - (impactByNode.get(a.id) || 0);
    if (impactDiff !== 0) return impactDiff;
    return a.id.localeCompare(b.id);
  });

  const keepSet = new Set();
  if (nodeById.has(DEMAND_SINK_NODE_ID)) keepSet.add(DEMAND_SINK_NODE_ID);
  sortedNodesByImpact.forEach((node) => {
    if (keepSet.size >= maxNodes) return;
    keepSet.add(node.id);
  });

  const collapsedNodeMap = new Map();
  const remapNodeId = (nodeId) => {
    if (keepSet.has(nodeId)) return nodeId;
    const source = nodeById.get(nodeId);
    if (!source) return null;

    if (source.type === 'supplier') {
      return 'supplier:S_OTHER';
    }
    if (source.type === 'plant') {
      return 'plant:P_OTHER';
    }
    if (source.type === 'sink') {
      return DEMAND_SINK_NODE_ID;
    }

    const family = inferSkuFamily(source.refs?.sku || source.label || source.id);
    const role = source.type === 'fg' ? 'FG' : 'COMP';
    return `sku:K_${family}_OTHER_${role}`;
  };

  const collapsedNodes = [];
  nodes.forEach((node) => {
    if (keepSet.has(node.id)) {
      collapsedNodes.push({ ...node });
      return;
    }

    const collapsedId = remapNodeId(node.id);
    if (!collapsedId) return;
    const existing = collapsedNodeMap.get(collapsedId);
    if (!existing) {
      const type = node.type === 'supplier'
        ? 'supplier'
        : node.type === 'plant'
          ? 'plant'
          : node.type === 'fg'
            ? 'fg'
            : node.type === 'sink'
              ? 'sink'
              : 'component';
      const label = type === 'supplier'
        ? 'Other Suppliers'
        : type === 'plant'
          ? 'Other Plants'
          : type === 'fg'
            ? `Other FG (${inferSkuFamily(node.label)})`
            : type === 'component'
              ? `Other Components (${inferSkuFamily(node.label)})`
              : 'Demand';

      const created = {
        id: collapsedId,
        type,
        label,
        metrics: mergeMetricObjects(node.metrics || {}, { collapsed_nodes: 1 }),
        refs: {
          run_id: node.refs?.run_id,
          dataset_profile_id: node.refs?.dataset_profile_id,
          collapsed: true
        }
      };
      collapsedNodeMap.set(collapsedId, created);
      return;
    }

    existing.metrics = mergeMetricObjects(existing.metrics, node.metrics || {});
    existing.metrics = mergeMetricObjects(existing.metrics, { collapsed_nodes: 1 });
  });

  collapsedNodeMap.forEach((value) => collapsedNodes.push(value));
  const dedupedNodes = Array.from(new Map(collapsedNodes.map((node) => [node.id, node])).values());

  const collapsedEdges = new Map();
  let remappedEdgeCount = 0;
  edges.forEach((edge) => {
    const source = remapNodeId(edge.source);
    const target = remapNodeId(edge.target);
    if (!source || !target || source === target) return;

    const unchanged = source === edge.source && target === edge.target;
    const edgeId = unchanged
      ? edge.id
      : `collapsed:${edge.type}:${source}->${target}`;

    if (!unchanged) remappedEdgeCount += 1;
    upsertEdge(collapsedEdges, {
      id: edgeId,
      type: edge.type,
      source,
      target,
      metrics: mergeMetricObjects(edge.metrics || {}, unchanged ? {} : { collapsed_edges: 1 }),
      refs: {
        ...(edge.refs || {}),
        ...(unchanged ? {} : { collapsed: true })
      }
    });
  });

  let limitedNodes = dedupedNodes;
  let limitedEdges = Array.from(collapsedEdges.values());
  let droppedEdgeCount = 0;

  if (limitedNodes.length > maxNodes) {
    const impactByCollapsedNode = new Map(limitedNodes.map((node) => [node.id, 0]));
    limitedEdges.forEach((edge) => {
      const magnitude = edgeMagnitude(edge);
      impactByCollapsedNode.set(edge.source, (impactByCollapsedNode.get(edge.source) || 0) + magnitude);
      impactByCollapsedNode.set(edge.target, (impactByCollapsedNode.get(edge.target) || 0) + magnitude);
    });

    const rankedNodes = [...limitedNodes].sort((a, b) => {
      const impactDiff = (impactByCollapsedNode.get(b.id) || 0) - (impactByCollapsedNode.get(a.id) || 0);
      if (impactDiff !== 0) return impactDiff;
      return a.id.localeCompare(b.id);
    });

    const keepNodeIds = new Set();
    if (impactByCollapsedNode.has(DEMAND_SINK_NODE_ID)) keepNodeIds.add(DEMAND_SINK_NODE_ID);
    rankedNodes.forEach((node) => {
      if (keepNodeIds.size >= maxNodes) return;
      keepNodeIds.add(node.id);
    });

    const beforeEdgeFilter = limitedEdges.length;
    limitedNodes = rankedNodes.filter((node) => keepNodeIds.has(node.id));
    limitedEdges = limitedEdges.filter((edge) => keepNodeIds.has(edge.source) && keepNodeIds.has(edge.target));
    droppedEdgeCount += Math.max(0, beforeEdgeFilter - limitedEdges.length);
  }

  if (limitedEdges.length > maxEdges) {
    const ranked = [...limitedEdges].sort((a, b) => {
      const magnitudeDiff = edgeMagnitude(b) - edgeMagnitude(a);
      if (magnitudeDiff !== 0) return magnitudeDiff;
      return a.id.localeCompare(b.id);
    });
    const kept = ranked.slice(0, maxEdges);
    const tail = ranked.slice(maxEdges);
    droppedEdgeCount = tail.length;

    const tailCollapsed = new Map();
    tail.forEach((edge) => {
      const aggregateId = `tail:${edge.type}:${edge.source}->${edge.target}`;
      upsertEdge(tailCollapsed, {
        id: aggregateId,
        type: edge.type,
        source: edge.source,
        target: edge.target,
        metrics: mergeMetricObjects(edge.metrics || {}, { collapsed_tail_edges: 1 }),
        refs: {
          ...(edge.refs || {}),
          collapsed_tail: true
        }
      });
    });

    const candidate = [...kept, ...Array.from(tailCollapsed.values())];
    candidate.sort((a, b) => {
      const magnitudeDiff = edgeMagnitude(b) - edgeMagnitude(a);
      if (magnitudeDiff !== 0) return magnitudeDiff;
      return a.id.localeCompare(b.id);
    });
    limitedEdges = candidate.slice(0, maxEdges);
  }

  return {
    nodes: limitedNodes,
    edges: limitedEdges,
    summary: {
      remapped_edge_count: remappedEdgeCount,
      dropped_edge_count: droppedEdgeCount,
      collapsed_node_count: Math.max(0, nodes.length - limitedNodes.length)
    }
  };
};

const buildNodeSideMetrics = ({ nodes, edges }) => {
  const byNode = new Map(nodes.map((node) => [node.id, { in_qty: 0, out_qty: 0, degree_in: 0, degree_out: 0 }]));

  edges.forEach((edge) => {
    const magnitude = edgeMagnitude(edge);
    const source = byNode.get(edge.source);
    const target = byNode.get(edge.target);
    if (source) {
      source.out_qty = round6(source.out_qty + magnitude);
      source.degree_out += 1;
    }
    if (target) {
      target.in_qty = round6(target.in_qty + magnitude);
      target.degree_in += 1;
    }
  });

  return byNode;
};

const parseEdgeIdByType = ({ type, source, target, usage_qty = 0, valid_from = '', valid_to = '' }) => {
  if (type === 'bom') {
    const usage = round6(usage_qty);
    return `bom:${source}->${target}|u=${usage}|vf=${String(valid_from || '')}|vt=${String(valid_to || '')}`;
  }
  return `${type}:${source}->${target}`;
};

export function buildTopologyGraph({
  run_id,
  dataset_profile_id,
  dataset_fingerprint = '',
  generated_at = null,
  scope = {},
  datasets = {},
  artifacts = {},
  refs = {}
} = {}) {
  const normalizedScope = normalizeScope(scope || {});
  const scopePlantMatches = parsePlantPredicate(normalizedScope);
  const scopeSkuMatches = parseSkuPrefixPredicate(normalizedScope);
  const settingsHash = createTopologySettingsHash({
    dataset_fingerprint,
    scope: normalizedScope
  });

  const supplierMaster = Array.isArray(datasets?.supplier_master) ? datasets.supplier_master : [];
  const poOpenLines = Array.isArray(datasets?.po_open_lines) ? datasets.po_open_lines : [];
  const goodsReceipt = Array.isArray(datasets?.goods_receipt) ? datasets.goods_receipt : [];
  const bomEdges = Array.isArray(datasets?.bom_edge) ? datasets.bom_edge : [];
  const demandFg = Array.isArray(datasets?.demand_fg) ? datasets.demand_fg : [];
  const inventorySnapshots = Array.isArray(datasets?.inventory_snapshots) ? datasets.inventory_snapshots : [];

  const planRows = Array.isArray(artifacts?.plan_table?.rows)
    ? artifacts.plan_table.rows
    : (Array.isArray(artifacts?.plan_table) ? artifacts.plan_table : []);
  const projectionRows = Array.isArray(artifacts?.inventory_projection?.rows)
    ? artifacts.inventory_projection.rows
    : (Array.isArray(artifacts?.inventory_projection) ? artifacts.inventory_projection : []);
  const riskRows = Array.isArray(artifacts?.risk_scores?.rows)
    ? artifacts.risk_scores.rows
    : (Array.isArray(artifacts?.risk_scores) ? artifacts.risk_scores : []);
  const bottleneckRows = normalizeBottleneckRows(artifacts?.bottlenecks || artifacts?.bottlenecks_json);

  const nodesById = new Map();
  const edgesById = new Map();
  const skuRoles = new Map();

  const markSkuRole = (sku, role) => {
    const token = normalizeSku(sku);
    if (!skuRoles.has(token)) {
      skuRoles.set(token, { fg: false, component: false });
    }
    const state = skuRoles.get(token);
    if (role === 'fg') state.fg = true;
    if (role === 'component') state.component = true;
  };

  // Supplier master gives canonical labels for supplier nodes.
  supplierMaster.forEach((row) => {
    const supplierId = normalizeSupplierId(row?.supplier_id || row?.supplier_code || row?.supplier_name);
    const supplierLabel = normalizeText(row?.supplier_name || row?.name || row?.supplier_id || supplierId);
    ensureNode(nodesById, {
      id: buildSupplierNodeId(supplierId),
      type: 'supplier',
      label: supplierLabel,
      refs: {
        run_id,
        dataset_profile_id,
        supplier_id: supplierId
      }
    });
  });

  // BOM edges (FG -> Component)
  bomEdges.forEach((row) => {
    const fgSku = normalizeSku(row?.fg_sku || row?.parent_material || row?.parent_sku || row?.material_code);
    const componentSku = normalizeSku(row?.component_sku || row?.child_material || row?.child_sku);
    const plantId = normalizeText(row?.plant_id || '');
    if (!fgSku || !componentSku) return;
    if (!scopeSkuMatches(fgSku) && !scopeSkuMatches(componentSku)) return;
    if (plantId && !scopePlantMatches(plantId)) return;

    markSkuRole(fgSku, 'fg');
    markSkuRole(componentSku, 'component');

    const fgNodeId = buildSkuNodeId(fgSku);
    const componentNodeId = buildSkuNodeId(componentSku);
    const usageQty = round6(row?.usage_qty ?? row?.qty_per ?? row?.qty ?? 0);
    const validFrom = normalizeText(row?.valid_from || '');
    const validTo = normalizeText(row?.valid_to || '');
    const edgeId = parseEdgeIdByType({
      type: 'bom',
      source: fgNodeId,
      target: componentNodeId,
      usage_qty: usageQty,
      valid_from: validFrom,
      valid_to: validTo
    });

    ensureNode(nodesById, {
      id: fgNodeId,
      type: 'fg',
      label: normalizeText(row?.fg_label || row?.parent_label || fgSku),
      refs: { run_id, dataset_profile_id, sku: fgSku }
    });
    ensureNode(nodesById, {
      id: componentNodeId,
      type: 'component',
      label: normalizeText(row?.component_label || row?.child_label || componentSku),
      refs: { run_id, dataset_profile_id, sku: componentSku }
    });

    upsertEdge(edgesById, {
      id: edgeId,
      type: 'bom',
      source: fgNodeId,
      target: componentNodeId,
      metrics: {
        usage_qty: usageQty,
        flow_qty: usageQty,
        edge_count: 1
      },
      refs: {
        run_id,
        dataset_profile_id,
        source_dataset: 'bom_edge',
        plant_id: plantId || null
      }
    });
  });

  // Inbound PO edges (Supplier -> Plant)
  poOpenLines.forEach((row) => {
    const plantId = normalizePlantId(row?.plant_id);
    const sku = normalizeSku(row?.material_code || row?.sku || row?.item_code);
    const supplierId = normalizeSupplierId(row?.supplier_id || row?.supplier_code || row?.supplier_name || row?.supplier);
    const supplierLabel = normalizeText(row?.supplier_name || row?.supplier || supplierId);
    const openQty = round6(row?.open_qty ?? row?.qty ?? 0);
    if (!supplierId || !plantId || openQty <= 0) return;
    if (!scopePlantMatches(plantId)) return;
    if (!scopeSkuMatches(sku)) return;

    markSkuRole(sku, 'component');

    const supplierNodeId = buildSupplierNodeId(supplierId);
    const plantNodeId = buildPlantNodeId(plantId);
    const edgeId = parseEdgeIdByType({
      type: 'inbound',
      source: supplierNodeId,
      target: plantNodeId
    });

    ensureNode(nodesById, {
      id: supplierNodeId,
      type: 'supplier',
      label: supplierLabel,
      refs: { run_id, dataset_profile_id, supplier_id: supplierId }
    });
    ensureNode(nodesById, {
      id: plantNodeId,
      type: 'plant',
      label: normalizeText(row?.plant_name || plantId),
      refs: { run_id, dataset_profile_id, plant_id: plantId }
    });

    upsertEdge(edgesById, {
      id: edgeId,
      type: 'inbound',
      source: supplierNodeId,
      target: plantNodeId,
      metrics: {
        open_qty: openQty,
        flow_qty: openQty,
        line_count: 1
      },
      refs: {
        run_id,
        dataset_profile_id,
        source_dataset: 'po_open_lines'
      }
    });
  });

  // FG supply and demand edges (Plant -> FG, FG -> Sink)
  const demandByFgPlant = new Map();
  const demandByFg = new Map();
  demandFg.forEach((row) => {
    const fgSku = normalizeSku(row?.fg_sku || row?.material_code || row?.sku);
    const plantId = normalizePlantId(row?.plant_id);
    const qty = round6(row?.demand_qty ?? row?.qty ?? 0);
    if (!fgSku || qty < 0) return;
    if (!scopeSkuMatches(fgSku)) return;
    if (!scopePlantMatches(plantId)) return;

    markSkuRole(fgSku, 'fg');
    const key = `${fgSku}|${plantId}`;
    demandByFgPlant.set(key, round6((demandByFgPlant.get(key) || 0) + qty));
    demandByFg.set(fgSku, round6((demandByFg.get(fgSku) || 0) + qty));
  });

  demandByFgPlant.forEach((qty, key) => {
    const [fgSku, plantId] = key.split('|');
    const plantNodeId = buildPlantNodeId(plantId);
    const fgNodeId = buildSkuNodeId(fgSku);
    const edgeId = parseEdgeIdByType({
      type: 'fg_supply',
      source: plantNodeId,
      target: fgNodeId
    });

    ensureNode(nodesById, {
      id: plantNodeId,
      type: 'plant',
      label: plantId,
      refs: { run_id, dataset_profile_id, plant_id: plantId }
    });
    ensureNode(nodesById, {
      id: fgNodeId,
      type: 'fg',
      label: fgSku,
      refs: { run_id, dataset_profile_id, sku: fgSku }
    });

    upsertEdge(edgesById, {
      id: edgeId,
      type: 'fg_supply',
      source: plantNodeId,
      target: fgNodeId,
      metrics: {
        flow_qty: qty,
        demand_qty: qty
      },
      refs: {
        run_id,
        dataset_profile_id,
        source_dataset: 'demand_fg'
      }
    });
  });

  if (demandByFg.size > 0) {
    ensureNode(nodesById, {
      id: DEMAND_SINK_NODE_ID,
      type: 'sink',
      label: 'Customer Demand',
      refs: { run_id, dataset_profile_id }
    });
  }

  demandByFg.forEach((qty, fgSku) => {
    const fgNodeId = buildSkuNodeId(fgSku);
    const edgeId = parseEdgeIdByType({
      type: 'demand',
      source: fgNodeId,
      target: DEMAND_SINK_NODE_ID
    });
    upsertEdge(edgesById, {
      id: edgeId,
      type: 'demand',
      source: fgNodeId,
      target: DEMAND_SINK_NODE_ID,
      metrics: {
        demand_qty: qty,
        flow_qty: qty
      },
      refs: {
        run_id,
        dataset_profile_id,
        source_dataset: 'demand_fg'
      }
    });
  });

  // Plan edges (Plant -> SKU)
  planRows.forEach((row) => {
    const sku = normalizeSku(row?.sku || row?.material_code);
    const plantId = normalizePlantId(row?.plant_id);
    const orderQty = round6(row?.order_qty ?? row?.qty ?? 0);
    if (!sku || !plantId || orderQty <= 0) return;
    if (!scopePlantMatches(plantId) || !scopeSkuMatches(sku)) return;

    const role = skuRoles.get(sku);
    const inferredType = role?.fg ? 'fg' : 'component';
    const skuNodeId = buildSkuNodeId(sku);
    const plantNodeId = buildPlantNodeId(plantId);
    const edgeId = parseEdgeIdByType({
      type: 'plan',
      source: plantNodeId,
      target: skuNodeId
    });

    ensureNode(nodesById, {
      id: plantNodeId,
      type: 'plant',
      label: plantId,
      refs: { run_id, dataset_profile_id, plant_id: plantId }
    });
    ensureNode(nodesById, {
      id: skuNodeId,
      type: inferredType,
      label: sku,
      refs: { run_id, dataset_profile_id, sku }
    });

    upsertEdge(edgesById, {
      id: edgeId,
      type: 'plan',
      source: plantNodeId,
      target: skuNodeId,
      metrics: {
        plan_qty: orderQty,
        flow_qty: orderQty,
        plan_rows: 1
      },
      refs: {
        run_id,
        dataset_profile_id,
        source_artifact: 'plan_table',
        run_ref: refs?.plan_table || null
      }
    });
  });

  // Inventory snapshots enrich node metrics.
  inventorySnapshots.forEach((row) => {
    const sku = normalizeSku(row?.sku || row?.material_code);
    const plantId = normalizePlantId(row?.plant_id);
    const onHand = round6(row?.on_hand ?? row?.onhand_qty ?? 0);
    if (!sku || !plantId) return;
    if (!scopePlantMatches(plantId) || !scopeSkuMatches(sku)) return;

    const node = ensureNode(nodesById, {
      id: buildSkuNodeId(sku),
      type: skuRoles.get(sku)?.fg ? 'fg' : 'component',
      label: sku,
      refs: { run_id, dataset_profile_id, sku }
    });
    node.metrics = mergeMetricObjects(node.metrics, { on_hand_qty: onHand });

    ensureNode(nodesById, {
      id: buildPlantNodeId(plantId),
      type: 'plant',
      label: plantId,
      refs: { run_id, dataset_profile_id, plant_id: plantId }
    });
  });

  let nodes = Array.from(nodesById.values());
  let edges = Array.from(edgesById.values());

  const collapsed = collapseGraphForLimits({
    nodes,
    edges,
    maxNodes: normalizedScope.max_nodes,
    maxEdges: normalizedScope.max_edges
  });
  nodes = collapsed.nodes;
  edges = collapsed.edges;

  // Final type reconciliation for SKU nodes.
  nodes.forEach((node) => {
    if (!node.id.startsWith('sku:K_')) return;
    const sku = normalizeSku(node.refs?.sku || node.label || node.id);
    const roles = skuRoles.get(sku);
    if (!roles) return;
    node.type = roles.fg ? 'fg' : (roles.component ? 'component' : node.type || 'component');
    if (roles.fg && roles.component) {
      node.metrics = mergeMetricObjects(node.metrics, { dual_role_sku: true });
    }
  });

  const sideMetrics = buildNodeSideMetrics({ nodes, edges });
  nodes = nodes.map((node) => ({
    ...node,
    metrics: mergeMetricObjects(node.metrics, sideMetrics.get(node.id) || {})
  }));

  // Overlay: risk
  const overlayRisk = (() => {
    if (riskRows.length === 0) return null;
    const suppliers = [];
    const materials = [];
    const supplierMaterial = [];
    let highRiskCount = 0;
    let mediumRiskCount = 0;

    riskRows.forEach((row) => {
      const score = toNumber(row?.risk_score, NaN);
      if (Number.isFinite(score) && score >= 70) highRiskCount += 1;
      else if (Number.isFinite(score) && score >= 55) mediumRiskCount += 1;

      const entityType = normalizeText(row?.entity_type).toLowerCase();
      const supplierId = normalizeSupplierId(row?.supplier || row?.supplier_id || row?.entity_id);
      const materialSku = normalizeSku(row?.material_code || row?.entity_id);
      const plantId = normalizePlantId(row?.plant_id);

      if (entityType === 'supplier') {
        const nodeId = buildSupplierNodeId(supplierId);
        suppliers.push({
          id: `${nodeId}|${row?.entity_id || supplierId}`,
          node_id: nodeId,
          risk_score: score,
          overdue_ratio: toNumber(row?.metrics?.overdue_ratio, null),
          avg_delay_days: toNumber(row?.metrics?.avg_delay_days, null),
          evidence_refs: Array.isArray(row?.evidence_refs) ? row.evidence_refs : []
        });
        const node = nodes.find((item) => item.id === nodeId);
        if (node) {
          node.metrics = mergeMetricObjects(node.metrics, { risk_score_max: Number.isFinite(score) ? score : null });
        }
        return;
      }

      if (entityType === 'material') {
        const nodeId = buildSkuNodeId(materialSku);
        materials.push({
          id: `${nodeId}|${row?.entity_id || materialSku}`,
          node_id: nodeId,
          risk_score: score,
          overdue_ratio: toNumber(row?.metrics?.overdue_ratio, null),
          avg_delay_days: toNumber(row?.metrics?.avg_delay_days, null),
          evidence_refs: Array.isArray(row?.evidence_refs) ? row.evidence_refs : []
        });
        const node = nodes.find((item) => item.id === nodeId);
        if (node) {
          node.metrics = mergeMetricObjects(node.metrics, { risk_score_max: Number.isFinite(score) ? score : null });
        }
        return;
      }

      if (entityType === 'supplier_material') {
        const supplierNodeId = buildSupplierNodeId(supplierId);
        const materialNodeId = buildSkuNodeId(materialSku);
        const inboundEdgeId = `inbound:${supplierNodeId}->${buildPlantNodeId(plantId)}`;
        supplierMaterial.push({
          id: `${supplierNodeId}|${materialNodeId}|${plantId}`,
          supplier_node_id: supplierNodeId,
          material_node_id: materialNodeId,
          inbound_edge_id: inboundEdgeId,
          risk_score: score,
          evidence_refs: Array.isArray(row?.evidence_refs) ? row.evidence_refs : []
        });
      }
    });

    suppliers.sort((a, b) => rankDescThenId(a, b, 'risk_score'));
    materials.sort((a, b) => rankDescThenId(a, b, 'risk_score'));
    supplierMaterial.sort((a, b) => rankDescThenId(a, b, 'risk_score'));

    return {
      total_entities: riskRows.length,
      high_risk_count: highRiskCount,
      medium_risk_count: mediumRiskCount,
      suppliers,
      materials,
      supplier_material: supplierMaterial,
      refs: {
        risk_scores: refs?.risk_scores || null,
        supporting_metrics: refs?.supporting_metrics || null
      }
    };
  })();

  // Overlay: bottlenecks
  const overlayBottlenecks = (() => {
    const nodeHits = new Map();
    const edgeHits = new Map();
    const addNodeHit = (nodeId, score, reason) => {
      if (!nodeId) return;
      const current = nodeHits.get(nodeId) || { id: nodeId, node_id: nodeId, score: 0, reasons: [] };
      current.score = round6(Math.max(current.score, toNumber(score, 0)));
      if (reason) current.reasons = Array.from(new Set([...(current.reasons || []), String(reason)]));
      nodeHits.set(nodeId, current);
    };
    const addEdgeHit = (edgeId, score, reason) => {
      if (!edgeId) return;
      const current = edgeHits.get(edgeId) || { id: edgeId, edge_id: edgeId, score: 0, reasons: [] };
      current.score = round6(Math.max(current.score, toNumber(score, 0)));
      if (reason) current.reasons = Array.from(new Set([...(current.reasons || []), String(reason)]));
      edgeHits.set(edgeId, current);
    };

    bottleneckRows.forEach((row) => {
      const score = toNumber(
        row?.score ?? row?.impact ?? row?.shortage_qty ?? row?.stockout_units ?? row?.value,
        0
      );
      const sku = normalizeText(
        row?.sku || row?.material_code || row?.component_sku || row?.component || row?.child_material
      );
      const sourceSku = normalizeText(row?.source_sku || row?.fg_sku || row?.parent_material || row?.source);
      const targetSku = normalizeText(row?.target_sku || row?.component_sku || row?.child_material || row?.target);
      const edgeId = normalizeText(row?.edge_id || '');
      const reason = normalizeText(row?.reason || row?.driver || row?.label);

      if (edgeId) addEdgeHit(edgeId, score, reason);

      if (sku) {
        addNodeHit(buildSkuNodeId(sku), score, reason);
      }

      if (sourceSku && targetSku) {
        const sourceNodeId = buildSkuNodeId(sourceSku);
        const targetNodeId = buildSkuNodeId(targetSku);
        const matchedEdge = edges.find((edge) => edge.source === sourceNodeId && edge.target === targetNodeId);
        if (matchedEdge) {
          addEdgeHit(matchedEdge.id, score, reason);
        }
      }
    });

    projectionRows.forEach((row) => {
      const stockout = toNumber(row?.stockout_units, 0);
      if (stockout <= 0) return;
      const sku = normalizeSku(row?.sku || row?.material_code);
      if (!scopeSkuMatches(sku)) return;
      addNodeHit(buildSkuNodeId(sku), stockout, 'stockout_units');
    });

    if (nodeHits.size === 0 && edgeHits.size === 0) return null;

    const topNodes = Array.from(nodeHits.values())
      .sort((a, b) => rankDescThenId(a, b, 'score'))
      .slice(0, 60);
    const topEdges = Array.from(edgeHits.values())
      .sort((a, b) => rankDescThenId(a, b, 'score'))
      .slice(0, 60);

    topNodes.forEach((item) => {
      const node = nodes.find((candidate) => candidate.id === item.node_id);
      if (node) {
        node.metrics = mergeMetricObjects(node.metrics, {
          bottleneck_score: item.score
        });
      }
    });

    return {
      node_ids: topNodes.map((item) => item.node_id),
      edge_ids: topEdges.map((item) => item.edge_id),
      top_nodes: topNodes,
      top_edges: topEdges,
      refs: {
        bottlenecks: refs?.bottlenecks || refs?.bottlenecks_json || null,
        bom_explosion: refs?.bom_explosion || refs?.bom_explosion_json || null,
        inventory_projection: refs?.inventory_projection || null
      }
    };
  })();

  // Overlay: plan
  const overlayPlan = (() => {
    if (planRows.length === 0 && projectionRows.length === 0) return null;

    const byNode = new Map();
    let totalPlanRows = 0;
    let totalPlanQty = 0;
    planRows.forEach((row) => {
      const sku = normalizeSku(row?.sku || row?.material_code);
      const qty = round6(row?.order_qty ?? row?.qty ?? 0);
      if (!scopeSkuMatches(sku)) return;
      const nodeId = buildSkuNodeId(sku);
      const current = byNode.get(nodeId) || { id: nodeId, node_id: nodeId, planned_qty: 0, rows: 0 };
      current.planned_qty = round6(current.planned_qty + qty);
      current.rows += 1;
      byNode.set(nodeId, current);
      totalPlanRows += 1;
      totalPlanQty = round6(totalPlanQty + qty);
    });

    const stockoutByNode = new Map();
    projectionRows.forEach((row) => {
      const sku = normalizeSku(row?.sku || row?.material_code);
      const stockout = round6(row?.stockout_units ?? 0);
      if (!scopeSkuMatches(sku)) return;
      if (stockout <= 0) return;
      const nodeId = buildSkuNodeId(sku);
      stockoutByNode.set(nodeId, round6((stockoutByNode.get(nodeId) || 0) + stockout));
    });

    const planNodes = Array.from(byNode.values())
      .sort((a, b) => rankDescThenId(a, b, 'planned_qty'));
    const stockoutNodes = Array.from(stockoutByNode.entries())
      .map(([node_id, stockout_units]) => ({ id: `${node_id}|stockout`, node_id, stockout_units }))
      .sort((a, b) => rankDescThenId(a, b, 'stockout_units'));

    return {
      total_plan_rows: totalPlanRows,
      total_plan_qty: totalPlanQty,
      plan_nodes: planNodes,
      stockout_nodes: stockoutNodes,
      refs: {
        plan_table: refs?.plan_table || null,
        inventory_projection: refs?.inventory_projection || null
      }
    };
  })();

  const overlays = {};
  if (overlayRisk) overlays.risk = overlayRisk;
  if (overlayBottlenecks) overlays.bottlenecks = overlayBottlenecks;
  if (overlayPlan) overlays.plan = overlayPlan;
  overlays.summary = {
    collapsed_node_count: collapsed.summary.collapsed_node_count,
    remapped_edge_count: collapsed.summary.remapped_edge_count,
    dropped_edge_count: collapsed.summary.dropped_edge_count,
    input_counts: {
      supplier_master: supplierMaster.length,
      po_open_lines: poOpenLines.length,
      goods_receipt: goodsReceipt.length,
      bom_edge: bomEdges.length,
      demand_fg: demandFg.length,
      inventory_snapshots: inventorySnapshots.length,
      plan_rows: planRows.length,
      risk_rows: riskRows.length
    }
  };

  const stableNodes = nodes
    .map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label || node.id,
      metrics: node.metrics || {},
      refs: node.refs || {}
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const stableEdges = edges
    .map((edge) => ({
      id: edge.id,
      type: edge.type,
      source: edge.source,
      target: edge.target,
      metrics: edge.metrics || {},
      refs: edge.refs || {}
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    version: 'v0',
    generated_at: generated_at || nowIso(),
    run_id,
    dataset_profile_id,
    settings_hash: settingsHash,
    scope: normalizedScope,
    nodes: stableNodes,
    edges: stableEdges,
    overlays
  };
}

export default {
  buildTopologyGraph,
  buildSupplierNodeId,
  buildSkuNodeId,
  buildPlantNodeId,
  buildDemandSinkNodeId,
  createTopologySettingsHash
};
