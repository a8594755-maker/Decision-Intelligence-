import React from 'react';
import { HelpCircle } from 'lucide-react';
import { Card } from '../ui';

export default function BlockingQuestionsCard({ payload }) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (questions.length === 0) return null;

  return (
    <Card className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-2 text-xs">
        <h4 className="font-semibold inline-flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-amber-700 dark:text-amber-300" />
          Blocking Questions
        </h4>
        <ul className="list-disc list-inside space-y-1 text-slate-700 dark:text-slate-200">
          {questions.slice(0, 2).map((question, idx) => (
            <li key={`${question}-${idx}`}>{question}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
