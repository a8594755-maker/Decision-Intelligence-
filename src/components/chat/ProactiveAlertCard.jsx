/**
 * ProactiveAlertCard.jsx
 *
 * Chat inline card: displays proactive risk alerts (Gap 8E).
 * Sorted by severity, each alert shows recommended actions + evidence refs.
 *
 * Props:
 *   payload: generateAlerts() output { alerts[], summary }
 *   onExpedite?: (materialCode, plantId) => void
 *   onRunScenario?: (alertType, materialCode) => void
 */

import React, { useState } from 'react';
import { Card, Badge } from '../ui';

// ── Severity config ───────────────────────────────────────────────────────────

const SEVERITY_META = {
  critical: { badge: 'danger',  border: 'border-red-200 dark:border-red-800/40' },
  high:     { badge: 'warning', border: 'border-orange-200 dark:border-orange-800/40' },
  medium:   { badge: 'info',    border: 'border-amber-200 dark:border-amber-800/40' },
};

// ── Single Alert Row ──────────────────────────────────────────────────────────

function AlertRow({ alert, onExpedite, onRunScenario }) {
  const [expanded, setExpanded] = useState(false);
  const meta = SEVERITY_META[alert.severity] || SEVERITY_META.medium;

  return (
    <div className={`rounded-lg border px-3 py-2.5 bg-[var(--surface-card)] ${meta.border}`}>
      <div className="space-y-1">
        {/* Title */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-semibold text-[var(--text-primary)] truncate">
            {alert.title}
          </span>
          <Badge type={meta.badge} className="text-[9px] px-1 py-0 shrink-0">
            {alert.severity}
          </Badge>
        </div>

        {/* Message */}
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {alert.message}
        </p>

        {/* KPI chips */}
        <div className="flex flex-wrap gap-1.5">
          {alert.p_stockout > 0 && (
            <span className="text-[10px] bg-[var(--surface-subtle)] border border-[var(--border-default)] rounded px-1.5 py-0.5 text-[var(--text-secondary)]">
              P(out): {(alert.p_stockout * 100).toFixed(0)}%
            </span>
          )}
          {alert.impact_usd > 0 && (
            <span className="text-[10px] bg-[var(--surface-subtle)] border border-[var(--border-default)] rounded px-1.5 py-0.5 text-[var(--text-secondary)]">
              Exposure: ${alert.impact_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          )}
          {alert.risk_score > 0 && (
            <span className="text-[10px] bg-[var(--surface-subtle)] border border-[var(--border-default)] rounded px-1.5 py-0.5 text-[var(--text-secondary)]">
              Risk: {alert.risk_score.toFixed(0)}
            </span>
          )}
          {alert.days_to_stockout != null && (
            <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium
              ${alert.days_to_stockout <= 7
                ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700'
                : 'bg-[var(--surface-subtle)] border border-[var(--border-default)] text-[var(--text-secondary)]'}`}>
              {alert.days_to_stockout}d to stockout
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          {alert.alert_type === 'expedite_rec' && onExpedite && (
            <button
              onClick={() => onExpedite(alert.material_code, alert.plant_id)}
              className="text-[11px] px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white transition-colors"
            >
              Expedite
            </button>
          )}
          {alert.alert_type === 'dual_source_rec' && onRunScenario && (
            <button
              onClick={() => onRunScenario('dual_source', alert.material_code)}
              className="text-[11px] px-2 py-1 rounded bg-orange-600 hover:bg-orange-700 text-white transition-colors"
            >
              Model Dual Source
            </button>
          )}
          {alert.recommended_actions?.length > 0 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              {expanded ? 'Hide actions' : 'Actions'}
            </button>
          )}
        </div>

        {/* Expanded actions */}
        {expanded && alert.recommended_actions?.length > 0 && (
          <div className="mt-1.5 space-y-0.5 pl-2 border-l-2 border-[var(--border-default)]">
            {alert.recommended_actions.map((action, i) => (
              <p key={i} className="text-[11px] text-[var(--text-secondary)]">
                &bull; {action}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ProactiveAlertCard({ payload, onExpedite, onRunScenario }) {
  const [showAll, setShowAll] = useState(false);

  if (!payload?.alerts?.length) return null;

  const { alerts, summary } = payload;
  const displayAlerts = showAll ? alerts : alerts.slice(0, 3);

  return (
    <Card category="risk" className="w-full border border-red-200 dark:border-red-800/50">
      <div className="space-y-3">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-semibold text-sm text-[var(--text-primary)]">
              Proactive Risk Alerts
            </h4>
            <p className="text-[11px] text-[var(--text-muted)]">
              {[
                summary?.critical_count > 0 && `${summary.critical_count} critical`,
                summary?.high_count > 0 && `${summary.high_count} high`,
                summary?.expedite_count > 0 && `${summary.expedite_count} expedite`,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {summary?.critical_count > 0 && (
              <Badge type="danger">{summary.critical_count} critical</Badge>
            )}
            {summary?.expedite_count > 0 && (
              <Badge type="warning">{summary.expedite_count} expedite</Badge>
            )}
          </div>
        </div>

        {/* Alert list */}
        <div className="space-y-2">
          {displayAlerts.map((alert) => (
            <AlertRow
              key={alert.alert_id}
              alert={alert}
              onExpedite={onExpedite}
              onRunScenario={onRunScenario}
            />
          ))}
        </div>

        {/* Show more */}
        {alerts.length > 3 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full text-xs text-center text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {showAll ? 'Show less' : `Show ${alerts.length - 3} more alert${alerts.length - 3 !== 1 ? 's' : ''}`}
          </button>
        )}

      </div>
    </Card>
  );
}
