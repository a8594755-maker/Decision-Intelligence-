/**
 * useScreenGroundedChat
 *
 * Captures user selection events from canvas components (topology nodes,
 * risk table rows, chart data points) and exposes them as structured
 * context that can be injected into the chat session context.
 *
 * This enables "screen-grounded" conversation: the user clicks a node
 * or risk item, and the chat copilot knows what they're looking at.
 *
 * Usage:
 *   const screenCtx = useScreenGroundedChat();
 *   // Pass handlers to canvas components:
 *   <TopologyTab onNodeClick={screenCtx.handleTopologySelect} />
 *   <RiskTable onRowSelect={screenCtx.handleRiskSelect} />
 *
 *   // Read current selection for chat context:
 *   screenCtx.selection  // { type, entity, timestamp }
 *   screenCtx.buildContextPatch()  // { screen_selection: { ... } }
 */

import { useState, useCallback, useRef } from 'react';

// Selection auto-expires after this many ms (user likely moved on)
const SELECTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Normalize a topology node/edge into a selection entity.
 */
function normalizeTopologySelection(item) {
  if (!item) return null;
  const { kind, raw } = item;
  if (!raw) return null;

  return {
    source: 'topology',
    kind, // 'node' | 'edge'
    id: raw.id || raw.node_id || null,
    label: raw.label || raw.name || raw.id || 'Unknown',
    entity_type: raw.type || raw.entity_type || kind,
    metrics: raw.metrics || {},
    material_code: raw.material_code || raw.refs?.material_code || null,
    plant_id: raw.plant_id || raw.refs?.plant_id || null,
    supplier_id: raw.supplier_id || raw.refs?.supplier_id || null,
  };
}

/**
 * Normalize a risk row into a selection entity.
 */
function normalizeRiskSelection(risk) {
  if (!risk) return null;

  return {
    source: 'risk',
    kind: 'risk_item',
    id: risk.id || `${risk.item}_${risk.plantId}`,
    label: risk.item || risk.material_code || 'Unknown Material',
    entity_type: 'material_risk',
    risk_level: risk.riskLevel || risk.risk_level || null,
    material_code: risk.item || risk.material_code || null,
    plant_id: risk.plantId || risk.plant_id || null,
    metrics: {
      profit_at_risk: risk.profitAtRisk ?? null,
      margin_at_risk: risk.marginAtRisk ?? null,
      days_to_stockout: risk.daysToStockout ?? null,
      net_available: risk.netAvailable ?? null,
      gap_qty: risk.gapQty ?? null,
    },
  };
}

/**
 * Normalize a chart data point click into a selection entity.
 */
function normalizeChartSelection(point) {
  if (!point) return null;

  return {
    source: 'chart',
    kind: 'data_point',
    id: point.id || point.label || null,
    label: point.label || point.name || String(point.x || ''),
    entity_type: point.chart_type || 'chart_point',
    series: point.series || null,
    value: point.value ?? point.y ?? null,
    period: point.period || point.x || null,
    metrics: point.metrics || {},
  };
}

/**
 * Normalize a plan table row click into a selection entity.
 */
function normalizePlanRowSelection(row) {
  if (!row) return null;

  return {
    source: 'plan_table',
    kind: 'plan_row',
    id: row.id || `${row.material_code}_${row.plant_id}`,
    label: `${row.material_code || ''} @ ${row.plant_id || ''}`,
    entity_type: 'plan_item',
    material_code: row.material_code || null,
    plant_id: row.plant_id || null,
    supplier_id: row.supplier_id || null,
    metrics: {
      order_qty: row.order_qty ?? null,
      reorder_point: row.reorder_point ?? null,
      safety_stock: row.safety_stock ?? null,
    },
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────

export default function useScreenGroundedChat() {
  const [selection, setSelection] = useState(null);
  const [selectionHistory, setSelectionHistory] = useState([]);
  const ttlTimerRef = useRef(null);

  const pushSelection = useCallback((entity) => {
    if (!entity) return;

    const entry = {
      ...entity,
      timestamp: new Date().toISOString(),
    };

    setSelection(entry);
    setSelectionHistory((prev) => [entry, ...prev].slice(0, 10));

    // Auto-expire selection
    if (ttlTimerRef.current) clearTimeout(ttlTimerRef.current);
    ttlTimerRef.current = setTimeout(() => {
      setSelection(null);
    }, SELECTION_TTL_MS);
  }, []);

  // ── Handlers for canvas components ──────────────────────────────────────

  const handleTopologySelect = useCallback((item) => {
    const entity = normalizeTopologySelection(item);
    if (entity) pushSelection(entity);
  }, [pushSelection]);

  const handleRiskSelect = useCallback((risk) => {
    const entity = normalizeRiskSelection(risk);
    if (entity) pushSelection(entity);
  }, [pushSelection]);

  const handleChartSelect = useCallback((point) => {
    const entity = normalizeChartSelection(point);
    if (entity) pushSelection(entity);
  }, [pushSelection]);

  const handlePlanRowSelect = useCallback((row) => {
    const entity = normalizePlanRowSelection(row);
    if (entity) pushSelection(entity);
  }, [pushSelection]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    if (ttlTimerRef.current) clearTimeout(ttlTimerRef.current);
  }, []);

  // ── Build context patch for chatSessionContextBuilder ───────────────────

  /**
   * Returns a context patch object suitable for merging into chat_session_context.
   * If no selection is active, returns null.
   */
  const buildContextPatch = useCallback(() => {
    if (!selection) return null;

    return {
      screen_selection: {
        source: selection.source,
        kind: selection.kind,
        entity_type: selection.entity_type,
        label: selection.label,
        id: selection.id,
        material_code: selection.material_code || null,
        plant_id: selection.plant_id || null,
        supplier_id: selection.supplier_id || null,
        risk_level: selection.risk_level || null,
        timestamp: selection.timestamp,
      },
    };
  }, [selection]);

  /**
   * Build a natural-language description of the current selection
   * for inclusion in the AI system prompt context.
   */
  const buildSelectionPromptText = useCallback(() => {
    if (!selection) return '';

    const parts = [`User is looking at: ${selection.label}`];
    if (selection.source === 'risk') {
      parts.push(`(risk level: ${selection.risk_level || 'unknown'})`);
      if (selection.metrics?.days_to_stockout != null) {
        parts.push(`Days to stockout: ${selection.metrics.days_to_stockout}`);
      }
    } else if (selection.source === 'topology') {
      parts.push(`(${selection.kind}: ${selection.entity_type})`);
    } else if (selection.source === 'chart') {
      if (selection.value != null) parts.push(`Value: ${selection.value}`);
      if (selection.period) parts.push(`Period: ${selection.period}`);
    }
    return parts.join(' ');
  }, [selection]);

  return {
    // State
    selection,
    selectionHistory,

    // Handlers (pass to canvas components)
    handleTopologySelect,
    handleRiskSelect,
    handleChartSelect,
    handlePlanRowSelect,
    clearSelection,

    // Context builders (pass to chat context)
    buildContextPatch,
    buildSelectionPromptText,
  };
}
