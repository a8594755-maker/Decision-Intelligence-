import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card } from '../ui';

export default function PlanErrorCard({ payload }) {
  if (!payload) return null;

  const blockingQuestions = Array.isArray(payload.blocking_questions) ? payload.blocking_questions : [];
  const violations = Array.isArray(payload.constraint_violations) ? payload.constraint_violations : [];

  return (
    <Card className="w-full border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10">
      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
          <AlertTriangle className="w-4 h-4" />
          <span className="font-semibold">Plan Failed</span>
        </div>

        <p className="text-red-700 dark:text-red-300">{payload.message || 'Planning failed due to validation/constraints.'}</p>

        {blockingQuestions.length > 0 && (
          <div>
            <p className="font-medium text-red-700 dark:text-red-300 mb-1">Blocking questions</p>
            <ul className="list-disc list-inside space-y-1 text-red-700 dark:text-red-300">
              {blockingQuestions.slice(0, 2).map((question, idx) => {
                const text = typeof question === 'string' ? question : (question?.question || '');
                return <li key={`${text}-${idx}`}>{text}</li>;
              })}
            </ul>
          </div>
        )}

        {violations.length > 0 && (
          <div>
            <p className="font-medium text-red-700 dark:text-red-300 mb-1">Constraint violations</p>
            <ul className="list-disc list-inside space-y-1 text-red-700 dark:text-red-300">
              {violations.slice(0, 6).map((item, idx) => (
                <li key={`${item.rule}-${idx}`}>
                  <strong>{item.rule}</strong>: {item.details}
                </li>
              ))}
            </ul>
          </div>
        )}

        {payload.run_id && (
          <p className="text-red-600 dark:text-red-300">Run #{payload.run_id}</p>
        )}
      </div>
    </Card>
  );
}
