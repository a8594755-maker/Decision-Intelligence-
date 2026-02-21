import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';

export default function PlanExceptionsCard({ payload }) {
  if (!payload) return null;

  const infeasibleReasons = Array.isArray(payload.infeasible_reasons) ? payload.infeasible_reasons : [];
  const violations = Array.isArray(payload.constraint_violations) ? payload.constraint_violations : [];
  const roundingNotes = Array.isArray(payload.rounding_notes) ? payload.rounding_notes : [];
  const bomBottlenecks = Array.isArray(payload.bom_bottlenecks) ? payload.bom_bottlenecks : [];

  const allClear = infeasibleReasons.length === 0
    && violations.length === 0
    && roundingNotes.length === 0
    && bomBottlenecks.length === 0;

  return (
    <Card className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Exceptions
          </h4>
          <Badge type={allClear ? 'success' : 'warning'}>{allClear ? 'Clear' : 'Review'}</Badge>
        </div>

        {allClear ? (
          <p className="text-xs text-slate-600 dark:text-slate-300">No infeasible reasons or constraint violations reported.</p>
        ) : (
          <div className="space-y-2 text-xs">
            {infeasibleReasons.length > 0 && (
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Solver reasons</p>
                <ul className="list-disc list-inside text-slate-600 dark:text-slate-300 space-y-1">
                  {infeasibleReasons.slice(0, 8).map((reason, idx) => (
                    <li key={`${reason}-${idx}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {violations.length > 0 && (
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Constraint violations</p>
                <ul className="list-disc list-inside text-slate-600 dark:text-slate-300 space-y-1">
                  {violations.slice(0, 8).map((violation, idx) => (
                    <li key={`${violation.rule}-${idx}`}>
                      <strong>{violation.rule}</strong>: {violation.details}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {roundingNotes.length > 0 && (
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Rounding adjustments</p>
                <ul className="list-disc list-inside text-slate-600 dark:text-slate-300 space-y-1">
                  {roundingNotes.slice(0, 8).map((note, idx) => (
                    <li key={`${note}-${idx}`}>{note}</li>
                  ))}
                </ul>
              </div>
            )}

            {bomBottlenecks.length > 0 && (
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Top BOM bottlenecks</p>
                <ul className="list-disc list-inside text-slate-600 dark:text-slate-300 space-y-1">
                  {bomBottlenecks.slice(0, 5).map((row, idx) => (
                    <li key={`${row.component_sku}-${idx}`}>
                      <strong>{row.component_sku}</strong>: missing {Number(row.missing_qty || 0).toFixed(2)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
