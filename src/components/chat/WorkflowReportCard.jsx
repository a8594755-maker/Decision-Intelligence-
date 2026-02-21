import React from 'react';
import { FileText } from 'lucide-react';
import { Card } from '../ui';

export default function WorkflowReportCard({ payload }) {
  if (!payload) return null;

  const keyResults = Array.isArray(payload.key_results) ? payload.key_results : [];
  const exceptions = Array.isArray(payload.exceptions) ? payload.exceptions : [];
  const actions = Array.isArray(payload.recommended_actions) ? payload.recommended_actions : [];

  return (
    <Card className="w-full border border-cyan-200 dark:border-cyan-800 bg-cyan-50/60 dark:bg-cyan-900/10">
      <div className="space-y-2 text-xs">
        <h4 className="font-semibold inline-flex items-center gap-2">
          <FileText className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
          Final Report
        </h4>

        <p className="text-slate-700 dark:text-slate-200">{payload.summary || 'Summary unavailable.'}</p>

        {keyResults.length > 0 && (
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Key results</p>
            <ul className="list-disc list-inside space-y-1 text-slate-700 dark:text-slate-200">
              {keyResults.slice(0, 6).map((item, idx) => (
                <li key={`${idx}-${String(item)}`}>
                  {typeof item === 'string' ? item : (item.claim || JSON.stringify(item))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {exceptions.length > 0 && (
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Exceptions</p>
            <ul className="list-disc list-inside space-y-1 text-slate-700 dark:text-slate-200">
              {exceptions.slice(0, 6).map((item, idx) => (
                <li key={`${idx}-${String(item)}`}>
                  {typeof item === 'string' ? item : (item.issue || item.claim || JSON.stringify(item))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {actions.length > 0 && (
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200 mb-1">Recommended actions</p>
            <ul className="list-disc list-inside space-y-1 text-slate-700 dark:text-slate-200">
              {actions.slice(0, 6).map((item, idx) => (
                <li key={`${idx}-${String(item)}`}>{String(item)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
