import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';
const EMPTY_EXCEPTIONS = [];

const severityBadgeType = (severity) => {
  const normalized = String(severity || '').toLowerCase();
  if (normalized === 'critical') return 'warning';
  if (normalized === 'high') return 'warning';
  if (normalized === 'medium') return 'info';
  return 'default';
};

export default function RiskExceptionsCard({ payload }) {
  const exceptions = Array.isArray(payload?.exceptions) ? payload.exceptions : EMPTY_EXCEPTIONS;
  const aggregates = payload?.aggregates || {};
  const [sortBy, setSortBy] = useState('severity');
  const sortedExceptions = useMemo(() => {
    const severityWeight = { critical: 4, high: 3, medium: 2, low: 1 };
    const rows = [...exceptions];
    if (sortBy === 'score') {
      return rows.sort((a, b) => Number(b.risk_score || 0) - Number(a.risk_score || 0));
    }
    return rows.sort((a, b) => {
      const severityDiff = (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
      if (severityDiff !== 0) return severityDiff;
      return Number(b.risk_score || 0) - Number(a.risk_score || 0);
    });
  }, [exceptions, sortBy]);

  if (!payload) return null;

  return (
    <Card category="risk" className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              Exceptions
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              Run #{payload.run_id || 'N/A'} | {exceptions.length} exceptions
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge type="warning">Critical: {aggregates.critical || 0}</Badge>
            <Badge type="warning">High: {aggregates.high || 0}</Badge>
            <Badge type="info">Medium: {aggregates.medium || 0}</Badge>
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
              className="text-xs px-2 py-1 rounded border border-[var(--border-default)] bg-[var(--surface-card)]"
            >
              <option value="severity">Sort: Severity</option>
              <option value="score">Sort: Score</option>
            </select>
          </div>
        </div>

        {sortedExceptions.length === 0 ? (
          <p className="text-xs text-[var(--text-secondary)]">No exceptions detected.</p>
        ) : (
          <div className="space-y-2">
            {sortedExceptions.slice(0, 12).map((item, index) => (
              <div
                key={`${item.entity?.entity_id || 'entity'}-${index}`}
                className="border border-[var(--border-default)] rounded px-3 py-2 bg-[var(--surface-card)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-[var(--text-secondary)]">
                    {item.entity?.label || item.entity?.entity_id || 'Unknown entity'}
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge type={severityBadgeType(item.severity)}>
                      {String(item.severity || 'low').toUpperCase()}
                    </Badge>
                    <Badge type="info">
                      score {Number(item.risk_score || 0).toFixed(1)}
                    </Badge>
                  </div>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-1">{item.description}</p>
                {(item.recommended_actions || []).length > 0 && (
                  <ul className="list-disc list-inside text-xs text-[var(--text-secondary)] mt-1 space-y-1">
                    {(item.recommended_actions || []).slice(0, 3).map((action, actionIndex) => (
                      <li key={`${action}-${actionIndex}`}>{action}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
