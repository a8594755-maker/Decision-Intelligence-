/**
 * PODelayAlertCard.jsx
 *
 * Displays high-risk PO delay probability alerts in the chat canvas.
 * Receives data from batchComputePODelayProbabilities via the risk artifact pipeline.
 *
 * Props:
 *   payload: {
 *     high_risk_pos[]:     PO signals with p_late >= 0.50
 *     critical_risk_pos[]: PO signals with p_late >= 0.75
 *     po_delay_summary:    { total_pos, high_risk_count, overdue_count, avg_p_late, fallback_count }
 *     supplier_stats[]:    supplier-level stats for context
 *   }
 *   onAction?: ({ action, pos }) => void
 */

import React, { useState } from 'react';
import { AlertOctagon, Clock, ChevronDown, ChevronUp, TrendingDown, Package } from 'lucide-react';
import { Card, Badge } from '../ui';

// ── Risk tier visual config ───────────────────────────────────────────────────

const TIER_META = {
  critical: { label: 'Critical', badgeType: 'danger',  bg: 'bg-red-50 dark:bg-red-900/20',       border: 'border-red-200 dark:border-red-700' },
  high:     { label: 'High',     badgeType: 'warning', bg: 'bg-orange-50 dark:bg-orange-900/20',   border: 'border-orange-200 dark:border-orange-700' },
  medium:   { label: 'Medium',   badgeType: 'info',    bg: 'bg-yellow-50 dark:bg-yellow-900/20',   border: 'border-yellow-200 dark:border-yellow-700' },
  low:      { label: 'Low',      badgeType: 'success', bg: 'bg-slate-50 dark:bg-slate-800/50',    border: 'border-slate-200 dark:border-slate-600' },
};

// ── PORow component ───────────────────────────────────────────────────────────

function PORow({ po }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const tier = TIER_META[po.risk_tier] || TIER_META.medium;

  const pLateDisplay = `${(po.p_late * 100).toFixed(0)}%`;
  const pLateP90Display = po.p_late_p90
    ? `(P90: ${(po.p_late_p90 * 100).toFixed(0)}%)`
    : '';

  const dueDateLabel = po.is_overdue
    ? `${Math.abs(po.days_until_due || 0)}d overdue`
    : po.days_until_due != null
      ? `${po.days_until_due}d until due`
      : po.promised_date || '—';

  return (
    <li className={`rounded-lg border ${tier.border} ${tier.bg} overflow-hidden`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Risk tier indicator */}
        <div className={`w-2 h-2 rounded-full shrink-0 ${
          po.risk_tier === 'critical' ? 'bg-red-500' :
          po.risk_tier === 'high' ? 'bg-orange-500' :
          po.risk_tier === 'medium' ? 'bg-yellow-500' : 'bg-green-500'
        }`} />

        {/* Material + supplier */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-[var(--text-primary)] truncate">
            {po.material_code || po.po_id || '—'}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] truncate">
            {po.supplier_id} {po.plant_id ? `· ${po.plant_id}` : ''}
          </p>
        </div>

        {/* Due date info */}
        <div className="text-right shrink-0">
          <p className={`text-[11px] font-medium ${po.is_overdue ? 'text-red-600 dark:text-red-400' : 'text-[var(--text-secondary)]'}`}>
            {dueDateLabel}
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">{po.promised_date || ''}</p>
        </div>

        {/* P(Late) */}
        <div className="text-right shrink-0 min-w-[4.5rem]">
          <p className="text-sm font-bold text-[var(--text-primary)]">
            {pLateDisplay}
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">{pLateP90Display}</p>
        </div>

        {/* Open qty */}
        <div className="text-right shrink-0 min-w-[3.5rem]">
          <p className="text-xs font-medium text-[var(--text-secondary)]">
            {(po.open_qty || 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-slate-400">open qty</p>
        </div>

        {/* Evidence toggle */}
        {Array.isArray(po.evidence_refs) && po.evidence_refs.length > 0 && (
          <button
            onClick={() => setShowEvidence((v) => !v)}
            className="shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
            aria-label="Toggle evidence"
          >
            {showEvidence ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* Expanded evidence */}
      {showEvidence && (
        <div className="px-3 pb-2.5 pt-1 border-t border-slate-100 dark:border-slate-700/50">
          <p className="text-[10px] font-medium text-[var(--text-muted)] mb-1">
            Model: <span className="font-mono">{po.model_used}</span>
          </p>
          <div className="flex flex-wrap gap-1">
            {po.evidence_refs.map((ref, idx) => (
              <span
                key={idx}
                className="text-[10px] font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded px-1.5 py-0.5 text-[var(--text-secondary)]"
              >
                {ref}
              </span>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PODelayAlertCard({ payload, onAction }) {
  const [showAll, setShowAll] = useState(false);

  if (!payload) return null;

  const highRiskPos     = Array.isArray(payload.high_risk_pos) ? payload.high_risk_pos : [];
  const criticalRiskPos = Array.isArray(payload.critical_risk_pos) ? payload.critical_risk_pos : [];
  const summary         = payload.po_delay_summary || {};

  if (highRiskPos.length === 0) return null;

  const displayPos = showAll ? highRiskPos : highRiskPos.slice(0, 5);
  const hasMore = highRiskPos.length > 5;

  return (
    <Card category="risk" className="w-full border border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-900/10">
      <div className="space-y-3">

        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertOctagon className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-sm text-[var(--text-primary)]">
                PO Delay Risk Alerts
              </h4>
              <p className="text-[11px] text-[var(--text-muted)]">
                {summary.high_risk_count || highRiskPos.length} high-risk POs detected
                {summary.overdue_count > 0 && ` · ${summary.overdue_count} already overdue`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {criticalRiskPos.length > 0 && (
              <Badge type="danger">{criticalRiskPos.length} Critical</Badge>
            )}
            <Badge type="warning">{highRiskPos.length} High Risk</Badge>
          </div>
        </div>

        {/* Summary stats */}
        {summary.total_pos > 0 && (
          <div className="flex flex-wrap gap-4 text-[11px] text-[var(--text-muted)] border-b border-red-100 dark:border-red-800/40 pb-2">
            <span className="flex items-center gap-1">
              <Package className="w-3 h-3" />
              {summary.total_pos} total open POs scanned
            </span>
            {summary.avg_p_late > 0 && (
              <span className="flex items-center gap-1">
                <TrendingDown className="w-3 h-3" />
                Avg P(Late): {(summary.avg_p_late * 100).toFixed(0)}%
              </span>
            )}
            {summary.fallback_count > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {summary.fallback_count} POs using fallback estimate
              </span>
            )}
          </div>
        )}

        {/* PO list */}
        <ul className="space-y-2">
          {displayPos.map((po, idx) => (
            <PORow key={`${po.po_id || po.material_code}-${idx}`} po={po} />
          ))}
        </ul>

        {/* Show more toggle */}
        {hasMore && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 py-1 flex items-center justify-center gap-1 transition-colors"
          >
            {showAll ? (
              <>Show less <ChevronUp className="w-3 h-3" /></>
            ) : (
              <>Show all {highRiskPos.length} high-risk POs <ChevronDown className="w-3 h-3" /></>
            )}
          </button>
        )}

        {/* Action buttons */}
        {onAction && highRiskPos.length > 0 && (
          <div className="flex gap-2 pt-1 border-t border-red-100 dark:border-red-800/40">
            {criticalRiskPos.length > 0 && (
              <button
                onClick={() => onAction({ action: 'expedite_high_risk', pos: criticalRiskPos })}
                className="flex-1 text-xs font-medium py-1.5 px-3 rounded-md bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                Expedite Critical ({criticalRiskPos.length})
              </button>
            )}
            <button
              onClick={() => onAction({ action: 'replan_with_risk', pos: highRiskPos })}
              className="flex-1 text-xs font-medium py-1.5 px-3 rounded-md bg-orange-100 hover:bg-orange-200 dark:bg-orange-900/30 dark:hover:bg-orange-900/50 text-orange-800 dark:text-orange-300 transition-colors"
            >
              Re-plan with Risk Mode
            </button>
          </div>
        )}

      </div>
    </Card>
  );
}
