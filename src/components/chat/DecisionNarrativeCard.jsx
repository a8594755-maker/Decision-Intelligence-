import React, { useMemo, useState } from 'react';
import {
  Brain,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  BookOpen,
  ArrowRight,
  AlertOctagon
} from 'lucide-react';
import { Card, Badge } from '../ui';

const STATUS_META = {
  OPTIMAL: { label: 'Optimal', badgeType: 'success', icon: CheckCircle2 },
  FEASIBLE: { label: 'Feasible', badgeType: 'info', icon: CheckCircle2 },
  INFEASIBLE: { label: 'Infeasible', badgeType: 'danger', icon: AlertOctagon },
  TIMEOUT: { label: 'Timeout', badgeType: 'warning', icon: AlertTriangle }
};

const SL_CLASS_META = {
  excellent: { text: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
  good: { text: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  acceptable: { text: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  poor: { text: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100 dark:bg-orange-900/30' },
  critical: { text: 'text-red-700 dark:text-red-300', bg: 'bg-red-100 dark:bg-red-900/30' },
  unknown: { text: 'text-[var(--text-secondary)]', bg: 'bg-[var(--surface-subtle)]' }
};

function EvidenceRefsList({ refs = [] }) {
  if (!refs.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {refs.map((ref, idx) => (
        <span
          key={`${ref}-${idx}`}
          className="text-[10px] font-mono bg-[var(--surface-subtle)] border border-[var(--border-default)] rounded px-1.5 py-0.5 text-[var(--text-muted)]"
        >
          {ref}
        </span>
      ))}
    </div>
  );
}

function ConstraintRow({ constraint }) {
  const [showImpact, setShowImpact] = useState(false);
  const hasImpact = Boolean(constraint?.marginal_impact);

  return (
    <div
      className={`rounded-md border px-2.5 py-2 text-xs ${constraint?.binding
        ? 'border-orange-200 dark:border-orange-700 bg-orange-50/50 dark:bg-orange-900/10'
        : 'border-[var(--border-default)] bg-[var(--surface-card)]'}`}
    >
      <div className="flex items-center gap-2">
        {constraint?.binding
          ? <AlertTriangle className="w-3.5 h-3.5 text-orange-500 shrink-0" />
          : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}

        <span className="font-medium text-[var(--text-secondary)]">{constraint?.name || '-'}</span>

        {constraint?.binding ? <Badge type="warning">Binding</Badge> : null}
        {constraint?.violations > 0 ? (
          <span className="text-red-500 text-[10px]">{constraint.violations} violation{constraint.violations === 1 ? '' : 's'}</span>
        ) : null}

        {hasImpact ? (
          <button
            type="button"
            className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            onClick={() => setShowImpact((v) => !v)}
          >
            {showImpact ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        ) : null}
      </div>

      {constraint?.details ? (
        <p className="mt-1 text-[10px] text-[var(--text-muted)] break-words">{constraint.details}</p>
      ) : null}

      {showImpact && hasImpact ? (
        <div className="mt-1.5 pt-1.5 border-t border-orange-100 dark:border-orange-800/40">
          <p className="text-[11px] text-orange-700 dark:text-orange-300">{constraint.marginal_impact.description}</p>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Basis: {constraint.marginal_impact.evidence_basis}</p>
        </div>
      ) : null}
    </div>
  );
}

export default function DecisionNarrativeCard({ payload, onRequestRelax }) {
  const [showConstraints, setShowConstraints] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const parsed = useMemo(() => {
    if (!payload) return null;
    const statusMeta = STATUS_META[payload.solver_status] || STATUS_META.FEASIBLE;
    const slClass = payload?.situation?.service_level_class || 'unknown';
    const slMeta = SL_CLASS_META[slClass] || SL_CLASS_META.unknown;
    return {
      statusMeta,
      slMeta,
      bindingCount: (payload.constraint_binding_summary || []).filter((c) => c.binding).length
    };
  }, [payload]);

  if (!payload || !parsed) return null;

  const StatusIcon = parsed.statusMeta.icon;

  return (
    <Card category="analysis" className="w-full border border-[var(--border-default)]">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <Brain className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-sm text-[var(--text-primary)]">Decision Narrative</h4>
              <p className="text-[11px] text-[var(--text-muted)]">Run #{payload.run_id || '-'}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Badge type={parsed.statusMeta.badgeType}>
              <span className="inline-flex items-center gap-1">
                <StatusIcon className="w-3 h-3" />
                {parsed.statusMeta.label}
              </span>
            </Badge>
            {payload?.situation?.service_level != null ? (
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${parsed.slMeta.bg} ${parsed.slMeta.text}`}>
                SL {(payload.situation.service_level * 100).toFixed(0)}%
              </span>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg bg-[var(--surface-subtle)] px-3 py-2.5">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1">Situation</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{payload?.situation?.text || '-'}</p>
        </div>

        <div className="rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/40 px-3 py-2.5">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1">Key Driver</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{payload?.driver?.text || '-'}</p>
        </div>

        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/40 px-3 py-2.5">
          <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide mb-1">Recommendation</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{payload?.recommendation?.text || '-'}</p>
        </div>

        {Array.isArray(payload.trade_offs) && payload.trade_offs.length > 0 ? (
          <div>
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">Alternative Actions</p>
            <div className="flex flex-wrap gap-1.5">
              {payload.trade_offs.map((tradeOff) => (
                <button
                  key={tradeOff.option_id}
                  type="button"
                  onClick={() => onRequestRelax?.(tradeOff.option_id)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                >
                  <ArrowRight className="w-3 h-3" />
                  {tradeOff.title}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {Array.isArray(payload.constraint_binding_summary) && payload.constraint_binding_summary.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setShowConstraints((v) => !v)}
              className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors w-full"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>
                Constraint Analysis
                {parsed.bindingCount > 0 ? (
                  <span className="ml-1 text-orange-500">({parsed.bindingCount} binding)</span>
                ) : null}
              </span>
              {showConstraints ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
            </button>

            {showConstraints ? (
              <div className="mt-2 space-y-1.5">
                {payload.constraint_binding_summary.slice(0, 8).map((constraint) => (
                  <ConstraintRow key={constraint.name} constraint={constraint} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="pt-1 border-t border-[var(--border-default)] flex justify-end">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Evidence ({(payload.all_evidence_refs || []).length})
            {showEvidence ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {showEvidence ? <EvidenceRefsList refs={payload.all_evidence_refs || []} /> : null}
      </div>
    </Card>
  );
}
