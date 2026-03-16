/**
 * DecisionBundleCard.jsx
 *
 * Renders a structured decision_bundle in Chat — the primary output of the
 * "Evidence-backed Agentic Decision Copilot" pattern.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │  Summary                                     │
 *   │  ─────────────────────────────────────────── │
 *   │  Recommendation        [action button]       │
 *   │  ─────────────────────────────────────────── │
 *   │  Drivers           │  KPI Impact             │
 *   │  ─────────────────────────────────────────── │
 *   │  Evidence Chips                               │
 *   │  ─────────────────────────────────────────── │
 *   │  Blockers (if any)                            │
 *   │  ─────────────────────────────────────────── │
 *   │  Next Actions                                 │
 *   └─────────────────────────────────────────────┘
 */

import React, { useState } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  FileSearch,
  Zap,
  AlertOctagon,
} from 'lucide-react';
import { Card, Badge, Button } from '../ui';

// ── Direction helpers ────────────────────────────────────────────────────────

const DIRECTION_STYLES = {
  positive: { icon: TrendingUp, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
  negative: { icon: TrendingDown, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20' },
  neutral:  { icon: Minus, color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-50 dark:bg-slate-800/40' },
};

function DriverChip({ driver }) {
  const style = DIRECTION_STYLES[driver.direction] || DIRECTION_STYLES.neutral;
  const Icon = style.icon;

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${style.bg} border-slate-200 dark:border-slate-700`}>
      <Icon className={`w-3 h-3 ${style.color}`} />
      <span className="font-medium text-slate-700 dark:text-slate-200">{driver.label}</span>
      <span className={`font-mono text-[11px] ${style.color}`}>{driver.value}</span>
    </div>
  );
}

// ── Evidence chip ────────────────────────────────────────────────────────────

function EvidenceChip({ evidence }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-mono bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded px-1.5 py-0.5 text-indigo-600 dark:text-indigo-400 cursor-default"
      title={evidence.summary || evidence.label}
    >
      <FileSearch className="w-2.5 h-2.5" />
      {evidence.label}
      {evidence.run_id ? <span className="opacity-60">#{evidence.run_id}</span> : null}
    </span>
  );
}

// ── KPI Impact row ───────────────────────────────────────────────────────────

function KpiImpactRow({ kpiImpact }) {
  if (!kpiImpact || Object.keys(kpiImpact).length === 0) return null;

  const entries = Object.entries(kpiImpact).map(([key, value]) => {
    const label = key.replace(/_delta$/, '').replace(/_/g, ' ');
    const isPositive = key.includes('cost') || key.includes('stockout') ? value < 0 : value > 0;
    const formatted = key.includes('service_level')
      ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)} pp`
      : key.includes('cost')
        ? `${value > 0 ? '+' : ''}$${Math.abs(value).toLocaleString()}`
        : `${value > 0 ? '+' : ''}${value}`;

    return { label, formatted, isPositive };
  });

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(({ label, formatted, isPositive }) => (
        <div key={label} className="text-xs">
          <span className="text-slate-500 dark:text-slate-400 capitalize">{label}: </span>
          <span className={isPositive ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
            {formatted}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Blocker row ──────────────────────────────────────────────────────────────

function BlockerRow({ blocker }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-900/10 px-2.5 py-2 text-xs">
      <AlertOctagon className="w-3.5 h-3.5 text-orange-500 shrink-0 mt-0.5" />
      <div>
        <span className="font-medium text-slate-700 dark:text-slate-200">{blocker.description}</span>
        {blocker.resolution_hint && (
          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">{blocker.resolution_hint}</p>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {Object} props.payload - decision_bundle object
 * @param {Function} [props.onActionClick] - (action_id) => void
 */
export default function DecisionBundleCard({ payload, onActionClick }) {
  const [showEvidence, setShowEvidence] = useState(false);

  if (!payload) return null;

  const {
    summary,
    recommendation,
    drivers = [],
    kpi_impact = {},
    evidence_refs = [],
    blockers = [],
    next_actions = [],
  } = payload;

  const hasKpiImpact = Object.keys(kpi_impact).length > 0;

  return (
    <Card className="border border-indigo-200 dark:border-indigo-800 bg-gradient-to-br from-white to-indigo-50/30 dark:from-slate-900 dark:to-indigo-950/20">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-indigo-100 dark:bg-indigo-900/30">
          <Brain className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        </div>
        <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
          Decision Copilot
        </span>
      </div>

      {/* Summary */}
      <p className="text-sm text-slate-800 dark:text-slate-100 leading-relaxed mb-3">
        {summary}
      </p>

      {/* Recommendation */}
      {recommendation && (
        <div className="flex items-center gap-2 mb-3 rounded-md border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/10 px-3 py-2">
          <Zap className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="text-xs text-slate-700 dark:text-slate-200 flex-1">{recommendation.text}</span>
          {recommendation.action_type && onActionClick && (
            <Button
              size="xs"
              variant="primary"
              onClick={() => onActionClick(recommendation.action_type)}
              className="shrink-0"
            >
              <ArrowRight className="w-3 h-3" />
            </Button>
          )}
        </div>
      )}

      {/* Drivers */}
      {drivers.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
            Top Drivers
          </div>
          <div className="flex flex-wrap gap-1.5">
            {drivers.map((d, i) => <DriverChip key={i} driver={d} />)}
          </div>
        </div>
      )}

      {/* KPI Impact */}
      {hasKpiImpact && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
            KPI Impact
          </div>
          <KpiImpactRow kpiImpact={kpi_impact} />
        </div>
      )}

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <div className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wider flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Blockers
          </div>
          {blockers.map((b, i) => <BlockerRow key={i} blocker={b} />)}
        </div>
      )}

      {/* Evidence refs (collapsible) */}
      {evidence_refs.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowEvidence(v => !v)}
            className="flex items-center gap-1 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider hover:text-indigo-800 dark:hover:text-indigo-300"
          >
            <FileSearch className="w-3 h-3" />
            Evidence ({evidence_refs.length})
            {showEvidence ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showEvidence && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {evidence_refs.map((evidence, i) => <EvidenceChip key={i} evidence={evidence} />)}
            </div>
          )}
        </div>
      )}

      {/* Next Actions */}
      {next_actions.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-700 pt-2.5 mt-1">
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
            Suggested Next Steps
          </div>
          <div className="flex flex-wrap gap-1.5">
            {next_actions.slice(0, 4).map((action) => (
              <button
                key={action.action_id}
                type="button"
                onClick={() => onActionClick?.(action.action_id)}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                title={action.description}
              >
                <ArrowRight className="w-3 h-3 text-slate-400" />
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
