import React from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';

export default function ValidationCard({ payload }) {
  if (!payload) return null;

  const status = payload.status === 'pass' ? 'pass' : 'fail';
  const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];

  return (
    <Card className="w-full border border-slate-200 dark:border-slate-700">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Validation Card</h4>
          <Badge type={status === 'pass' ? 'success' : 'warning'}>
            {status.toUpperCase()}
          </Badge>
        </div>

        <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1">
          {reasons.length > 0 ? (
            reasons.map((reason, index) => (
              <div key={`${reason}-${index}`} className="flex items-start gap-2">
                {status === 'pass' ? (
                  <CheckCircle2 className="w-3 h-3 mt-0.5 text-emerald-600 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-3 h-3 mt-0.5 text-amber-600 flex-shrink-0" />
                )}
                <span>{reason}</span>
              </div>
            ))
          ) : (
            <div className="text-slate-500">No validation reasons provided.</div>
          )}
        </div>
      </div>
    </Card>
  );
}
