import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Card, Button, Badge } from '../ui';

const formatConfidence = (value) => `${(Math.max(0, Math.min(1, Number(value || 0))) * 100).toFixed(0)}%`;

export default function ReuseDecisionCard({ payload, onApply, onReview }) {
  if (!payload) return null;

  return (
    <Card category="system" className="w-full border border-teal-200 dark:border-teal-800 bg-teal-50/60 dark:bg-teal-900/10">
      <div className="space-y-3 text-xs">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold inline-flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-teal-600" />
              Reuse Suggestion
            </h4>
            <p className="text-[var(--text-secondary)]">
              I found a previous mapping for similar data (confidence {formatConfidence(payload.confidence)}).
            </p>
            {payload.explanation && (
              <p className="text-[var(--text-muted)]">{payload.explanation}</p>
            )}
          </div>
          <Badge type="info">{payload.mode || 'ask_one_click'}</Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            className="text-xs px-3 py-1"
            onClick={() => onApply?.(payload)}
          >
            Apply
          </Button>
          <Button
            variant="secondary"
            className="text-xs px-3 py-1"
            onClick={() => onReview?.(payload)}
          >
            Review
          </Button>
        </div>
      </div>
    </Card>
  );
}
