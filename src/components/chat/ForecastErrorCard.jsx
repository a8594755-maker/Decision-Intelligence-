import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';

export default function ForecastErrorCard({ payload }) {
  if (!payload) return null;
  const blocking = Array.isArray(payload.blocking_questions) ? payload.blocking_questions : [];

  return (
    <Card className="w-full border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-900/10">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="font-semibold text-sm flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4" />
            Forecast Failed
          </h4>
          <Badge type="danger">Run #{payload.run_id || 'N/A'}</Badge>
        </div>
        <p className="text-xs text-red-800 dark:text-red-200">{payload.message || 'Unknown error'}</p>
        {blocking.length > 0 && (
          <div>
            <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">Blocking questions</p>
            <ul className="list-disc list-inside text-xs text-red-700 dark:text-red-300 space-y-1">
              {blocking.map((item, idx) => {
                const text = typeof item === 'string' ? item : (item?.question || '');
                return <li key={`${text}-${idx}`}>{text}</li>;
              })}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
