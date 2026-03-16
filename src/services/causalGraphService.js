/**
 * causalGraphService.js
 *
 * 5-Whys Causal Graph — traces root causes from observed symptoms
 * (stockouts, infeasibility, KPI shortfall) back through the supply
 * chain layers to identify actionable upstream causes.
 *
 * Architecture:
 *   Symptom → Immediate Cause → Contributing Factor → Root Cause → Action
 *
 * Each causal chain is a directed acyclic graph (DAG) of CausalNode objects.
 * The service is deterministic: same inputs always produce the same graph.
 *
 * Layers (inspired by 5-Whys):
 *   L1: Symptom         — what the user sees (e.g., "stockout on MAT-001")
 *   L2: Proximate Cause — direct operational cause (e.g., "insufficient reorder qty")
 *   L3: Contributing    — planning/data factor (e.g., "demand underforecast")
 *   L4: Root Cause      — structural issue (e.g., "stale demand data from ERP")
 *   L5: Action          — what to do about it (e.g., "refresh ERP extract")
 */

// ── Constants ───────────────────────────────────────────────────────────────

export const CAUSAL_LAYERS = {
  SYMPTOM: 'symptom',
  PROXIMATE: 'proximate',
  CONTRIBUTING: 'contributing',
  ROOT: 'root',
  ACTION: 'action',
};

const LAYER_LABELS = {
  [CAUSAL_LAYERS.SYMPTOM]: 'What happened?',
  [CAUSAL_LAYERS.PROXIMATE]: 'Why? (Immediate)',
  [CAUSAL_LAYERS.CONTRIBUTING]: 'Why? (Contributing)',
  [CAUSAL_LAYERS.ROOT]: 'Why? (Root Cause)',
  [CAUSAL_LAYERS.ACTION]: 'What to do?',
};

// ── Node builder ────────────────────────────────────────────────────────────

let _nodeCounter = 0;

/**
 * Create a causal node.
 */
export function createCausalNode({
  layer,
  title,
  detail = '',
  entity = null,
  evidence = null,
  metric_value = null,
  severity = 'info',
}) {
  _nodeCounter += 1;
  return {
    id: `cn_${_nodeCounter}_${Date.now().toString(36)}`,
    layer,
    layer_label: LAYER_LABELS[layer] || layer,
    title,
    detail,
    entity, // { type: 'material'|'supplier'|'plant', id: string }
    evidence, // { artifact_type, run_id, path }
    metric_value,
    severity, // 'critical' | 'warning' | 'info'
    children: [],
  };
}

/**
 * Link parent → child in the causal graph.
 */
export function linkCause(parent, child) {
  if (!parent || !child) return;
  if (!parent.children.includes(child.id)) {
    parent.children.push(child.id);
  }
}

// ── Causal chain builders ───────────────────────────────────────────────────

/**
 * Build causal graph for stockout symptoms.
 *
 * @param {object} params
 * @param {Array}  params.stockoutItems     - Items with stockout risk [{ material_code, plant_id, gap_qty, days_to_stockout }]
 * @param {object} [params.replayMetrics]   - Replay metrics for context
 * @param {object} [params.solverResult]    - Solver output
 * @param {Array}  [params.riskScores]      - Risk score data
 * @param {object} [params.forecastMetrics] - Forecast accuracy metrics
 * @param {number} [params.planRunId]       - For evidence refs
 * @returns {{ nodes: CausalNode[], edges: Array<{from, to}>, roots: string[] }}
 */
export function buildStockoutCausalGraph({
  stockoutItems = [],
  replayMetrics: _replayMetrics = null,
  solverResult = null,
  riskScores = [],
  forecastMetrics = null,
  planRunId = null,
}) {
  const nodes = {};
  const edges = [];

  if (stockoutItems.length === 0) {
    return { nodes: {}, edges: [], roots: [] };
  }

  const roots = [];

  for (const item of stockoutItems.slice(0, 5)) {
    const matCode = item.material_code || item.item || 'Unknown';
    const plantId = item.plant_id || item.plantId || '';

    // L1: Symptom
    const symptom = createCausalNode({
      layer: CAUSAL_LAYERS.SYMPTOM,
      title: `Stockout risk: ${matCode}`,
      detail: `${item.gap_qty || 0} units short${item.days_to_stockout != null ? `, ${item.days_to_stockout} days to stockout` : ''} at ${plantId}`,
      entity: { type: 'material', id: matCode },
      metric_value: item.gap_qty,
      severity: (item.days_to_stockout != null && item.days_to_stockout <= 7) ? 'critical' : 'warning',
      evidence: planRunId ? { artifact_type: 'replay_metrics', run_id: planRunId } : null,
    });
    nodes[symptom.id] = symptom;
    roots.push(symptom.id);

    // L2: Proximate causes
    const proximate = createCausalNode({
      layer: CAUSAL_LAYERS.PROXIMATE,
      title: 'Insufficient replenishment quantity',
      detail: 'Planned order quantity does not cover projected demand within lead time.',
      entity: { type: 'material', id: matCode },
    });
    nodes[proximate.id] = proximate;
    linkCause(symptom, proximate);
    edges.push({ from: symptom.id, to: proximate.id });

    // L3: Contributing factors
    // Check if high risk score
    const itemRisk = riskScores.find(r =>
      (r.material_code === matCode || r.entity_id === matCode) &&
      (!plantId || r.plant_id === plantId)
    );

    if (itemRisk && itemRisk.risk_score > 60) {
      const riskNode = createCausalNode({
        layer: CAUSAL_LAYERS.CONTRIBUTING,
        title: 'High supplier risk score',
        detail: `Risk score: ${itemRisk.risk_score}. ${itemRisk.metrics?.overdue_ratio > 0.2 ? 'High overdue ratio.' : ''} ${itemRisk.metrics?.p90_delay_days > 5 ? `P90 delay: ${itemRisk.metrics.p90_delay_days}d.` : ''}`,
        entity: { type: 'supplier', id: itemRisk.supplier_id || itemRisk.entity_id },
        metric_value: itemRisk.risk_score,
        severity: itemRisk.risk_score > 120 ? 'critical' : 'warning',
      });
      nodes[riskNode.id] = riskNode;
      linkCause(proximate, riskNode);
      edges.push({ from: proximate.id, to: riskNode.id });

      // L4: Root cause — supplier reliability
      const rootNode = createCausalNode({
        layer: CAUSAL_LAYERS.ROOT,
        title: 'Supplier delivery reliability degraded',
        detail: `On-time rate: ${itemRisk.metrics?.on_time_rate != null ? (itemRisk.metrics.on_time_rate * 100).toFixed(0) + '%' : 'N/A'}. Average delay: ${itemRisk.metrics?.avg_delay_days || 'N/A'} days.`,
        entity: { type: 'supplier', id: itemRisk.supplier_id || itemRisk.entity_id },
        severity: 'warning',
      });
      nodes[rootNode.id] = rootNode;
      linkCause(riskNode, rootNode);
      edges.push({ from: riskNode.id, to: rootNode.id });

      // L5: Actions
      const action1 = createCausalNode({
        layer: CAUSAL_LAYERS.ACTION,
        title: 'Run risk-aware replan',
        detail: 'Adjust lead times and safety stock based on supplier risk profile.',
        severity: 'info',
      });
      nodes[action1.id] = action1;
      linkCause(rootNode, action1);
      edges.push({ from: rootNode.id, to: action1.id });

      if (itemRisk.risk_score > 120) {
        const action2 = createCausalNode({
          layer: CAUSAL_LAYERS.ACTION,
          title: 'Evaluate dual sourcing',
          detail: 'Critical risk items should consider alternative suppliers.',
          severity: 'info',
        });
        nodes[action2.id] = action2;
        linkCause(rootNode, action2);
        edges.push({ from: rootNode.id, to: action2.id });
      }
    }

    // Check forecast accuracy
    if (forecastMetrics && forecastMetrics.mape > 20) {
      const forecastNode = createCausalNode({
        layer: CAUSAL_LAYERS.CONTRIBUTING,
        title: 'Poor forecast accuracy',
        detail: `MAPE: ${forecastMetrics.mape.toFixed(1)}% (above 20% threshold). Demand may be underestimated.`,
        metric_value: forecastMetrics.mape,
        severity: forecastMetrics.mape > 30 ? 'critical' : 'warning',
        evidence: planRunId ? { artifact_type: 'metrics', run_id: planRunId } : null,
      });
      nodes[forecastNode.id] = forecastNode;
      linkCause(proximate, forecastNode);
      edges.push({ from: proximate.id, to: forecastNode.id });

      const dataRoot = createCausalNode({
        layer: CAUSAL_LAYERS.ROOT,
        title: 'Demand signal quality issue',
        detail: 'Historical demand data may be stale, sparse, or noisy. Consider re-extracting from ERP.',
        severity: 'warning',
      });
      nodes[dataRoot.id] = dataRoot;
      linkCause(forecastNode, dataRoot);
      edges.push({ from: forecastNode.id, to: dataRoot.id });

      const dataAction = createCausalNode({
        layer: CAUSAL_LAYERS.ACTION,
        title: 'Refresh demand data from ERP',
        detail: 'Re-extract demand history and re-run forecast with latest data.',
        severity: 'info',
      });
      nodes[dataAction.id] = dataAction;
      linkCause(dataRoot, dataAction);
      edges.push({ from: dataRoot.id, to: dataAction.id });
    }

    // Check binding constraints
    const bindingConstraints = (solverResult?.proof?.constraints_checked || [])
      .filter(c => c.binding || c.slack === 0);
    if (bindingConstraints.length > 0) {
      const constraintNode = createCausalNode({
        layer: CAUSAL_LAYERS.CONTRIBUTING,
        title: `${bindingConstraints.length} binding constraint(s)`,
        detail: bindingConstraints.slice(0, 3).map(c => c.name || c.constraint_id || 'constraint').join(', '),
        severity: 'warning',
        evidence: planRunId ? { artifact_type: 'solver_meta', run_id: planRunId, path: 'proof.constraints' } : null,
      });
      nodes[constraintNode.id] = constraintNode;
      linkCause(proximate, constraintNode);
      edges.push({ from: proximate.id, to: constraintNode.id });

      const constraintAction = createCausalNode({
        layer: CAUSAL_LAYERS.ACTION,
        title: 'Start negotiation to relax constraints',
        detail: 'Use negotiation engine to explore budget, MOQ, or lead time adjustments.',
        severity: 'info',
      });
      nodes[constraintAction.id] = constraintAction;
      linkCause(constraintNode, constraintAction);
      edges.push({ from: constraintNode.id, to: constraintAction.id });
    }
  }

  return { nodes, edges, roots };
}

/**
 * Build causal graph for plan infeasibility.
 */
export function buildInfeasibilityCausalGraph({
  solverResult,
  constraintCheck = null,
  riskScores: _riskScores = [],
  planRunId = null,
}) {
  const nodes = {};
  const edges = [];
  const roots = [];

  // L1: Symptom
  const symptom = createCausalNode({
    layer: CAUSAL_LAYERS.SYMPTOM,
    title: 'Plan is infeasible',
    detail: (solverResult?.infeasible_reasons || []).join('; ') || 'No feasible solution exists under current constraints.',
    severity: 'critical',
    evidence: planRunId ? { artifact_type: 'solver_meta', run_id: planRunId } : null,
  });
  nodes[symptom.id] = symptom;
  roots.push(symptom.id);

  // Analyze constraint violations
  const violations = constraintCheck?.violations || [];
  const infeasibleReasons = solverResult?.infeasible_reasons || [];

  // Budget-related
  if (infeasibleReasons.some(r => /budget/i.test(r)) || violations.some(v => /budget/i.test(v.constraint || v.message || ''))) {
    const budgetNode = createCausalNode({
      layer: CAUSAL_LAYERS.PROXIMATE,
      title: 'Budget cap too restrictive',
      detail: 'Total required spend exceeds allocated budget.',
      severity: 'critical',
    });
    nodes[budgetNode.id] = budgetNode;
    linkCause(symptom, budgetNode);
    edges.push({ from: symptom.id, to: budgetNode.id });

    const budgetRoot = createCausalNode({
      layer: CAUSAL_LAYERS.ROOT,
      title: 'Budget not aligned with demand requirements',
      detail: 'Budget cap was set without accounting for current demand volume and unit costs.',
      severity: 'warning',
    });
    nodes[budgetRoot.id] = budgetRoot;
    linkCause(budgetNode, budgetRoot);
    edges.push({ from: budgetNode.id, to: budgetRoot.id });

    const budgetAction = createCausalNode({
      layer: CAUSAL_LAYERS.ACTION,
      title: 'Negotiate budget increase (+10%)',
      detail: 'Use negotiation engine option to explore 10% budget increase.',
      severity: 'info',
    });
    nodes[budgetAction.id] = budgetAction;
    linkCause(budgetRoot, budgetAction);
    edges.push({ from: budgetRoot.id, to: budgetAction.id });
  }

  // Service target related
  if (infeasibleReasons.some(r => /service|target/i.test(r))) {
    const slNode = createCausalNode({
      layer: CAUSAL_LAYERS.PROXIMATE,
      title: 'Service level target unreachable',
      detail: 'Cannot meet service target within budget and lead time constraints.',
      severity: 'critical',
    });
    nodes[slNode.id] = slNode;
    linkCause(symptom, slNode);
    edges.push({ from: symptom.id, to: slNode.id });

    const slAction = createCausalNode({
      layer: CAUSAL_LAYERS.ACTION,
      title: 'Relax service target or enable expedite',
      detail: 'Reduce service target by 5% or enable expedite shipping to recover feasibility.',
      severity: 'info',
    });
    nodes[slAction.id] = slAction;
    linkCause(slNode, slAction);
    edges.push({ from: slNode.id, to: slAction.id });
  }

  // Generic fallback if no specific reasons matched
  if (roots.length === 1 && Object.keys(nodes).length === 1) {
    const genericNode = createCausalNode({
      layer: CAUSAL_LAYERS.PROXIMATE,
      title: 'Conflicting constraints',
      detail: 'Multiple constraints cannot be simultaneously satisfied. Review budget, MOQ, lead times, and service targets.',
      severity: 'critical',
    });
    nodes[genericNode.id] = genericNode;
    linkCause(symptom, genericNode);
    edges.push({ from: symptom.id, to: genericNode.id });

    const negotiateAction = createCausalNode({
      layer: CAUSAL_LAYERS.ACTION,
      title: 'Start negotiation',
      detail: 'Use negotiation engine to explore constraint relaxations systematically.',
      severity: 'info',
    });
    nodes[negotiateAction.id] = negotiateAction;
    linkCause(genericNode, negotiateAction);
    edges.push({ from: genericNode.id, to: negotiateAction.id });
  }

  return { nodes, edges, roots };
}

// ── Summary builder ─────────────────────────────────────────────────────────

/**
 * Build a text summary of the causal graph for chat display.
 */
export function buildCausalSummaryText(graph) {
  if (!graph || Object.keys(graph.nodes).length === 0) {
    return 'No causal analysis available.';
  }

  const nodeList = Object.values(graph.nodes);
  const symptoms = nodeList.filter(n => n.layer === CAUSAL_LAYERS.SYMPTOM);
  const rootCauses = nodeList.filter(n => n.layer === CAUSAL_LAYERS.ROOT);
  const actions = nodeList.filter(n => n.layer === CAUSAL_LAYERS.ACTION);

  const lines = [];
  lines.push(`**Root Cause Analysis** (${symptoms.length} symptom(s), ${rootCauses.length} root cause(s))`);
  lines.push('');

  for (const s of symptoms) {
    lines.push(`- ${s.title}: ${s.detail}`);
  }

  if (rootCauses.length > 0) {
    lines.push('');
    lines.push('**Root Causes:**');
    for (const r of rootCauses) {
      lines.push(`- ${r.title}: ${r.detail}`);
    }
  }

  if (actions.length > 0) {
    lines.push('');
    lines.push('**Recommended Actions:**');
    for (const a of actions) {
      lines.push(`- ${a.title}`);
    }
  }

  return lines.join('\n');
}

/**
 * Flatten graph into a serializable payload for the CausalGraphCard.
 */
export function serializeCausalGraph(graph) {
  return {
    nodes: Object.values(graph.nodes).map(n => ({
      id: n.id,
      layer: n.layer,
      layer_label: n.layer_label,
      title: n.title,
      detail: n.detail,
      entity: n.entity,
      metric_value: n.metric_value,
      severity: n.severity,
      children: n.children,
    })),
    edges: graph.edges,
    roots: graph.roots,
  };
}

export default {
  CAUSAL_LAYERS,
  createCausalNode,
  linkCause,
  buildStockoutCausalGraph,
  buildInfeasibilityCausalGraph,
  buildCausalSummaryText,
  serializeCausalGraph,
};
