/**
 * negotiationApprovalBridge.js
 *
 * Bridges CFR negotiation outcomes into structured approval requests.
 * When a negotiation option is selected, this service:
 *   1. Packages the option with full evidence chain
 *   2. Computes expected KPI impact
 *   3. Builds a structured approval payload with rationale
 *   4. Generates chat messages for the approval flow
 *
 * This is the "Negotiation/Approval Assistant" — it translates
 * game-theory-informed decisions into auditable governance actions.
 */

import { buildDecisionBundle } from '../tasks/decisionTaskService';
import { assembleNegotiationEvidence } from '../governance/evidenceAssembler';

// ── Approval payload builder ────────────────────────────────────────────────

/**
 * Build a structured approval request from a negotiation outcome.
 *
 * @param {object} params
 * @param {object} params.selectedOption      - The chosen negotiation option
 * @param {object} params.evaluationResult    - Full evaluation with ranked_options
 * @param {object} params.negotiationReport   - LLM-generated report
 * @param {object} params.baseKpis            - Baseline plan KPIs
 * @param {object} params.optionKpis          - KPIs after applying the option
 * @param {number} params.planRunId           - Original plan run ID
 * @param {string} params.userId              - Requesting user
 * @param {object} [params.cfrEnrichment]     - CFR game-theory data (if available)
 * @returns {object} { approvalPayload, decisionBundle, messages }
 */
export function buildNegotiationApprovalRequest({
  selectedOption,
  evaluationResult,
  negotiationReport,
  baseKpis = {},
  optionKpis = {},
  planRunId,
  userId,
  cfrEnrichment = null,
}) {
  const optionId = selectedOption?.option_id || 'unknown';
  const optionTitle = selectedOption?.title || optionId;

  // Compute KPI deltas
  const kpiImpact = computeKpiImpact(baseKpis, optionKpis);

  // Build evidence chain
  const negotiationEvidence = assembleNegotiationEvidence({
    evaluation: evaluationResult,
    report: negotiationReport,
  });

  // Build rationale text
  const rationale = buildApprovalRationale({
    selectedOption,
    kpiImpact,
    negotiationReport,
    cfrEnrichment,
    evaluationResult,
  });

  // Build approval payload
  const approvalPayload = {
    type: 'negotiation_outcome',
    plan_run_id: planRunId,
    requested_by: userId,
    option_id: optionId,
    option_title: optionTitle,
    option_overrides: selectedOption?.overrides || {},
    kpi_impact: kpiImpact,
    rationale,
    evidence_summary: negotiationEvidence.map(e => e.label).join(', '),
    cfr_confidence: cfrEnrichment?.cfr_action_probs?.[optionId] || null,
    evaluation_rank: findOptionRank(evaluationResult, optionId),
    requires_replan: true,
    requested_at: new Date().toISOString(),
  };

  // Build decision bundle for the approval
  const decisionBundle = buildDecisionBundle({
    summary: `Negotiation outcome: "${optionTitle}" selected for plan #${planRunId}. ${rationale.one_liner}`,
    recommendation: {
      text: `Apply "${optionTitle}" and replan. ${kpiImpact.summary}`,
      action_type: 'request_approval',
      confidence: approvalPayload.cfr_confidence || 0.7,
    },
    drivers: kpiImpact.drivers,
    kpi_impact: kpiImpact.deltas,
    evidence_refs: negotiationEvidence,
    blockers: kpiImpact.degraded.length > 0
      ? [{
          blocker_id: 'kpi_degradation',
          description: `${kpiImpact.degraded.length} KPI(s) may degrade: ${kpiImpact.degraded.map(d => d.label).join(', ')}`,
          resolution_hint: 'Review trade-offs before approving.',
        }]
      : [],
    next_actions: [
      { action_id: 'request_approval', label: 'Submit for Approval', priority: 1 },
      { action_id: 'run_what_if', label: 'Simulate First', priority: 2 },
      { action_id: 'compare_plans', label: 'Compare Plans', priority: 3 },
    ],
  });

  // Build chat messages
  const messages = buildApprovalMessages({
    approvalPayload,
    decisionBundle,
    selectedOption,
    rationale,
  });

  return { approvalPayload, decisionBundle, messages };
}

// ── KPI impact computation ──────────────────────────────────────────────────

function computeKpiImpact(baseKpis, optionKpis) {
  const deltas = {};
  const drivers = [];
  const improved = [];
  const degraded = [];

  const kpiKeys = new Set([...Object.keys(baseKpis || {}), ...Object.keys(optionKpis || {})]);

  for (const key of kpiKeys) {
    const base = Number(baseKpis[key]);
    const option = Number(optionKpis[key]);
    if (!Number.isFinite(base) || !Number.isFinite(option)) continue;

    const delta = option - base;
    if (Math.abs(delta) < 0.0001) continue;

    deltas[key] = delta;

    const isPositive = isKpiImprovement(key, delta);
    const label = key.replace(/_/g, ' ').replace(/estimated /i, '');
    const direction = isPositive ? 'positive' : 'negative';
    const value = formatDelta(key, delta);

    drivers.push({ label, value, direction });

    if (isPositive) {
      improved.push({ key, label, delta, value });
    } else {
      degraded.push({ key, label, delta, value });
    }
  }

  const summaryParts = [];
  if (improved.length > 0) summaryParts.push(`${improved.length} improved`);
  if (degraded.length > 0) summaryParts.push(`${degraded.length} degraded`);

  return {
    deltas,
    drivers: drivers.slice(0, 5),
    improved,
    degraded,
    summary: summaryParts.length > 0 ? `KPIs: ${summaryParts.join(', ')}.` : 'No KPI changes detected.',
  };
}

function isKpiImprovement(key, delta) {
  const lowerIsBetter = /cost|stockout|penalty|shortage|overdue|delay/i.test(key);
  return lowerIsBetter ? delta < 0 : delta > 0;
}

function formatDelta(key, delta) {
  const sign = delta > 0 ? '+' : '';
  if (/cost/i.test(key)) return `${sign}$${Math.abs(delta).toLocaleString()}`;
  if (/service_level|fill_rate/i.test(key)) return `${sign}${(delta * 100).toFixed(2)} pp`;
  return `${sign}${delta.toLocaleString()}`;
}

// ── Rationale builder ───────────────────────────────────────────────────────

function buildApprovalRationale({ selectedOption, kpiImpact, negotiationReport, cfrEnrichment, evaluationResult }) {
  const parts = [];

  // Option description
  parts.push(`Selected option: "${selectedOption?.title || selectedOption?.option_id}".`);

  // Evaluation rank
  const rank = findOptionRank(evaluationResult, selectedOption?.option_id);
  if (rank != null) {
    parts.push(`Ranked #${rank} of ${evaluationResult?.ranked_options?.length || 0} evaluated options.`);
  }

  // CFR game-theory context
  if (cfrEnrichment?.cfr_action_probs) {
    const prob = cfrEnrichment.cfr_action_probs[selectedOption?.option_id];
    if (prob != null) {
      parts.push(`CFR equilibrium probability: ${(prob * 100).toFixed(1)}%.`);
    }
  }

  // KPI impact
  if (kpiImpact.improved.length > 0) {
    parts.push(`Improves: ${kpiImpact.improved.map(d => `${d.label} (${d.value})`).join(', ')}.`);
  }
  if (kpiImpact.degraded.length > 0) {
    parts.push(`Trade-offs: ${kpiImpact.degraded.map(d => `${d.label} (${d.value})`).join(', ')}.`);
  }

  // Report recommendation
  if (negotiationReport?.recommendation_rationale) {
    parts.push(negotiationReport.recommendation_rationale);
  }

  return {
    full: parts.join(' '),
    one_liner: parts.slice(0, 2).join(' '),
    sections: {
      option: parts[0],
      ranking: rank != null ? parts[1] : null,
      cfr: cfrEnrichment ? parts.find(p => p.includes('CFR')) : null,
      impact: kpiImpact.summary,
    },
  };
}

function findOptionRank(evaluationResult, optionId) {
  if (!evaluationResult?.ranked_options || !optionId) return null;
  const idx = evaluationResult.ranked_options.findIndex(o => o.option_id === optionId);
  return idx >= 0 ? idx + 1 : null;
}

// ── Chat message builder ────────────────────────────────────────────────────

function buildApprovalMessages({ approvalPayload, decisionBundle, selectedOption, rationale }) {
  const messages = [];

  // Summary message
  messages.push({
    role: 'ai',
    content: `**Negotiation outcome ready for approval.** ${rationale.one_liner}`,
    agent_role: 'approval_officer',
    timestamp: new Date().toISOString(),
  });

  // Decision bundle card
  messages.push({
    role: 'ai',
    type: 'decision_bundle_card',
    payload: decisionBundle,
    timestamp: new Date().toISOString(),
  });

  // Approval card with negotiation context
  messages.push({
    role: 'ai',
    type: 'negotiation_approval_card',
    payload: {
      ...approvalPayload,
      option: selectedOption,
      rationale_text: rationale.full,
    },
    timestamp: new Date().toISOString(),
  });

  return messages;
}

// ── Quick approval check ────────────────────────────────────────────────────

/**
 * Determine if a negotiation outcome needs approval based on impact magnitude.
 *
 * @param {object} params
 * @param {object} params.kpiImpact  - From computeKpiImpact
 * @param {object} params.option     - Selected option
 * @returns {{ needsApproval, reason }}
 */
export function checkApprovalRequired({ kpiImpact, option }) {
  // Always require approval for budget changes
  if (option?.overrides?.budget_cap || option?.overrides?.constraints?.budget_cap) {
    return { needsApproval: true, reason: 'Budget constraint modification requires approval.' };
  }

  // Require approval if any KPI degrades
  if (kpiImpact?.degraded?.length > 0) {
    return { needsApproval: true, reason: `${kpiImpact.degraded.length} KPI(s) will degrade.` };
  }

  // Auto-approve if all KPIs improve or stay neutral
  return { needsApproval: false, reason: 'All KPIs improve or stay neutral. Auto-approval eligible.' };
}

export default {
  buildNegotiationApprovalRequest,
  checkApprovalRequired,
};
