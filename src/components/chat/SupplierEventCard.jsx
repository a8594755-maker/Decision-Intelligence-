/**
 * SupplierEventCard.jsx
 *
 * Chat inline card for supplier events (delivery delays, quality issues, etc.).
 * Renders event details, risk delta, and optional replan recommendation.
 *
 * Payload shape: { event, risk_delta, replan_recommendation }
 */

import React from 'react';
import { Card, Badge } from '../ui';

const SEVERITY_STYLES = {
  critical: { badge: 'danger',  border: 'border-red-200 dark:border-red-800/40' },
  high:     { badge: 'warning', border: 'border-orange-200 dark:border-orange-800/40' },
  medium:   { badge: 'info',    border: 'border-amber-200 dark:border-amber-800/40' },
  low:      { badge: 'default', border: 'border-[var(--border-default)]' },
};

const EVENT_TYPE_LABELS = {
  delivery_delay: 'Delivery Delay',
  quality_issue: 'Quality Issue',
  capacity_change: 'Capacity Change',
  price_change: 'Price Change',
  force_majeure: 'Force Majeure',
};

export default function SupplierEventCard({ payload }) {
  if (!payload?.event) return null;

  const { event, risk_delta, replan_recommendation } = payload;
  const severity = event.severity || 'medium';
  const style = SEVERITY_STYLES[severity] || SEVERITY_STYLES.medium;
  const typeLabel = EVENT_TYPE_LABELS[event.event_type] || event.event_type;

  return (
    <Card category="risk" className={`border ${style.border} bg-[var(--surface-card)]`}>
      <div className="px-3 py-2.5 space-y-2">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            Supplier Event: {typeLabel}
          </span>
          <Badge type={style.badge} className="text-[9px] px-1 py-0">
            {severity}
          </Badge>
        </div>

        {/* Event details */}
        <div className="text-[11px] text-[var(--text-secondary)] space-y-0.5">
          {event.supplier_name && (
            <div><span className="font-medium">Supplier:</span> {event.supplier_name} ({event.supplier_id})</div>
          )}
          {event.material_code && (
            <div><span className="font-medium">Material:</span> {event.material_code}</div>
          )}
          {event.plant_id && (
            <div><span className="font-medium">Plant:</span> {event.plant_id}</div>
          )}
          {event.description && (
            <p className="mt-1">{event.description}</p>
          )}
          {event.occurred_at && (
            <div className="text-[10px] text-[var(--text-muted)]">{new Date(event.occurred_at).toLocaleString()}</div>
          )}
        </div>

        {/* Risk delta */}
        {risk_delta && (
          <div className="flex gap-2 text-[10px]">
            {risk_delta.score_before != null && risk_delta.score_after != null && (
              <span className="text-[var(--text-muted)]">
                Risk: {risk_delta.score_before.toFixed(1)} → {risk_delta.score_after.toFixed(1)}
                {risk_delta.delta != null && (
                  <span className={risk_delta.delta > 0 ? 'text-red-500 ml-1' : 'text-green-500 ml-1'}>
                    ({risk_delta.delta > 0 ? '+' : ''}{risk_delta.delta.toFixed(1)})
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        {/* Replan recommendation */}
        {replan_recommendation && (
          <div className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded px-2 py-1">
            {replan_recommendation.reason || 'Replan recommended based on risk assessment.'}
          </div>
        )}
      </div>
    </Card>
  );
}
