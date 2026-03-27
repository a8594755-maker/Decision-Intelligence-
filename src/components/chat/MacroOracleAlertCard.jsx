/**
 * MacroOracleAlertCard.jsx
 *
 * Renders a macro-oracle disruption alert in Chat — shows the full evidence chain:
 * External signal → Risk delta → CFR assessment → Solver adjustment → Recommendation
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │  ⚡ MACRO-ORACLE ALERT: [title]                     │
 *   │  ──────────────────────────────────────────────────  │
 *   │  Signal Source  │  Risk Impact                       │
 *   │  ──────────────────────────────────────────────────  │
 *   │  CFR Game-Theory Assessment                         │
 *   │    Supplier: [type]  Position: [bucket]             │
 *   │    Alpha ×[mult]  Penalty ×[mult]  Dual-source: Y/N│
 *   │  ──────────────────────────────────────────────────  │
 *   │  Recommended Actions                                │
 *   │  ──────────────────────────────────────────────────  │
 *   │  Evidence Chain (collapsible)                       │
 *   └──────────────────────────────────────────────────────┘
 */

import React, { useState } from 'react';
import {
  Zap,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Shield,
  TrendingUp,
  ArrowRight,
  Globe,
  Activity,
} from 'lucide-react';
import { Card, Badge, Button } from '../ui';

// ── Severity badge colors ───────────────────────────────────────────────────

const SEVERITY_STYLES = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300 border-orange-200 dark:border-orange-800',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
  low: 'bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--border-default)]',
};

const ASSESSMENT_STYLES = {
  aggressive: { color: 'text-red-600 dark:text-red-400', label: 'Aggressive' },
  desperate: { color: 'text-emerald-600 dark:text-emerald-400', label: 'Desperate' },
  cooperative: { color: 'text-blue-600 dark:text-blue-400', label: 'Cooperative' },
  mixed: { color: 'text-[var(--text-secondary)]', label: 'Mixed' },
};

// ── Sub-components ──────────────────────────────────────────────────────────

function SignalRow({ signal }) {
  const sevStyle = SEVERITY_STYLES[signal.severity] || SEVERITY_STYLES.medium;
  return (
    <div className="flex items-start gap-2 text-xs">
      <Globe className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 mt-0.5" />
      <div className="flex-1">
        <span className="text-[var(--text-secondary)]">{signal.description}</span>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`inline-block text-[10px] font-medium px-1.5 py-0 rounded border ${sevStyle}`}>
            {signal.severity?.toUpperCase()}
          </span>
          {signal.commodity && (
            <span className="text-[10px] text-[var(--text-muted)]">
              {signal.commodity}
            </span>
          )}
          {signal.region && (
            <span className="text-[10px] text-[var(--text-muted)]">
              {signal.region}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CfrAssessmentRow({ assessment }) {
  if (!assessment) return null;
  const style = ASSESSMENT_STYLES[assessment.supplier_assessment] || ASSESSMENT_STYLES.mixed;

  return (
    <div className="rounded-md border border-[var(--border-default)] bg-[var(--surface-subtle)] p-2.5">
      <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 flex items-center gap-1">
        <Shield className="w-3 h-3" />
        CFR Game-Theory Assessment
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-[var(--text-muted)]">Supplier type: </span>
          <span className={`font-medium ${style.color}`}>{style.label}</span>
        </div>
        <div>
          <span className="text-[var(--text-muted)]">Confidence: </span>
          <span className="font-mono text-[var(--text-secondary)]">
            {((assessment.confidence || 0) * 100).toFixed(0)}%
          </span>
        </div>
        <div>
          <span className="text-[var(--text-muted)]">Safety stock: </span>
          <span className={`font-mono font-medium ${assessment.safety_stock_alpha_multiplier > 1 ? 'text-red-600 dark:text-red-400' : assessment.safety_stock_alpha_multiplier < 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-secondary)]'}`}>
            ×{assessment.safety_stock_alpha_multiplier}
          </span>
        </div>
        <div>
          <span className="text-[var(--text-muted)]">Dual-source: </span>
          <span className={`font-medium ${assessment.dual_source_flag ? 'text-orange-600 dark:text-orange-400' : 'text-[var(--text-muted)]'}`}>
            {assessment.dual_source_flag ? 'Required' : 'No'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {Object} props.payload - macro_oracle_alert object
 * @param {Function} [props.onAction] - (action_id, payload) => void
 */
export default function MacroOracleAlertCard({ payload, onAction }) {
  const [showEvidence, setShowEvidence] = useState(false);

  if (!payload) return null;

  const {
    title,
    signals = [],
    risk_delta = {},
    cfr_assessment = null,
    recommendations = [],
    evidence_chain = [],
    trigger_status,
  } = payload;

  const isTrigger = trigger_status === 'triggered';
  const borderColor = isTrigger
    ? 'border-red-300 dark:border-red-800'
    : 'border-amber-200 dark:border-amber-800';
  const bgGradient = isTrigger
    ? 'from-white to-red-50/30 dark:from-[var(--surface-card)] dark:to-red-950/10'
    : 'from-white to-amber-50/30 dark:from-[var(--surface-card)] dark:to-amber-950/10';

  return (
    <Card category="risk" className={`border ${borderColor} bg-gradient-to-br ${bgGradient}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className={`p-1.5 rounded-md ${isTrigger ? 'bg-red-100 dark:bg-red-900/30' : 'bg-amber-100 dark:bg-amber-900/30'}`}>
          <Zap className={`w-4 h-4 ${isTrigger ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`} />
        </div>
        <span className={`text-xs font-semibold uppercase tracking-wider ${isTrigger ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
          Macro-Oracle Alert
        </span>
        {isTrigger && (
          <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
            REPLAN TRIGGERED
          </span>
        )}
      </div>

      {/* Title */}
      <p className="text-sm font-medium text-[var(--text-primary)] mb-3">
        {title}
      </p>

      {/* Signals */}
      {signals.length > 0 && (
        <div className="mb-3 space-y-2">
          {signals.map((sig, i) => <SignalRow key={i} signal={sig} />)}
        </div>
      )}

      {/* Risk Impact */}
      {risk_delta.total_delta != null && (
        <div className="flex items-center gap-2 mb-3 text-xs">
          <Activity className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          <span className="text-[var(--text-muted)]">Risk impact:</span>
          <span className={`font-mono font-medium ${risk_delta.total_delta > 30 ? 'text-red-600 dark:text-red-400' : 'text-orange-600 dark:text-orange-400'}`}>
            +{risk_delta.total_delta.toFixed(1)}
          </span>
          <span className="text-[var(--text-muted)]">
            ({risk_delta.base_score} → {risk_delta.new_score})
          </span>
        </div>
      )}

      {/* CFR Assessment */}
      <div className="mb-3">
        <CfrAssessmentRow assessment={cfr_assessment} />
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5">
            Recommended Actions
          </div>
          <div className="space-y-1">
            {recommendations.map((rec, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <ArrowRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                <span className="text-[var(--text-secondary)]">{rec.text}</span>
                {rec.action_id && onAction && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onAction(rec.action_id, payload)}
                    className="shrink-0 ml-auto"
                  >
                    {rec.button_label || 'Apply'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evidence Chain (collapsible) */}
      {evidence_chain.length > 0 && (
        <div className="border-t border-[var(--border-default)] pt-2 mt-1">
          <button
            type="button"
            onClick={() => setShowEvidence(v => !v)}
            className="flex items-center gap-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider hover:text-[var(--text-secondary)]"
          >
            <AlertTriangle className="w-3 h-3" />
            Evidence Chain ({evidence_chain.length} steps)
            {showEvidence ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showEvidence && (
            <div className="mt-2 space-y-1">
              {evidence_chain.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-4 h-4 rounded-full bg-[var(--surface-subtle)] text-[var(--text-secondary)] flex items-center justify-center text-[9px] font-bold shrink-0">
                    {i + 1}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] w-24 shrink-0">
                    {step.artifact_type}
                  </span>
                  <span className="text-[var(--text-secondary)]">{step.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
