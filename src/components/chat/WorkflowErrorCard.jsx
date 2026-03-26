import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';

export default function WorkflowErrorCard({ payload }) {
  if (!payload) return null;

  const actions = Array.isArray(payload.next_actions) ? payload.next_actions : [];

  return (
    <Card category="system" className="w-full border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10">
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-semibold text-red-700 dark:text-red-300 inline-flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Workflow Step Failed
          </h4>
          <Badge type="warning">{payload.error_code || 'UNKNOWN'}</Badge>
        </div>

        <p className="text-red-700 dark:text-red-300"><strong>What failed:</strong> {payload.step || 'workflow step'}</p>
        <p className="text-red-700 dark:text-red-300"><strong>Why:</strong> {payload.error_message || 'No error message available.'}</p>

        {actions.length > 0 && (
          <div>
            <p className="font-medium text-red-700 dark:text-red-300 mb-1">What you can do next</p>
            <ul className="list-disc list-inside space-y-1 text-red-700 dark:text-red-300">
              {actions.slice(0, 2).map((action, idx) => (
                <li key={`${action}-${idx}`}>{action}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
