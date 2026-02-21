import React from 'react';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { Card, Button } from '../ui';

export default function AIErrorCard({ payload, onConfigure }) {
  if (!payload) return null;

  return (
    <Card className="w-full border border-red-200 dark:border-red-900/50 bg-red-50/70 dark:bg-red-900/10">
      <div className="flex items-start gap-3">
        <span className="inline-flex p-2 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-300">
          <AlertTriangle className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-red-700 dark:text-red-300">{payload.title || 'AI unavailable'}</h4>
          <p className="text-xs text-red-700/85 dark:text-red-200/90 mt-1">{payload.message || 'Please configure server-side AI provider keys.'}</p>
          <div className="mt-3">
            <Button variant="primary" className="text-xs px-3 py-1.5" onClick={onConfigure}>
              <KeyRound className="w-3.5 h-3.5 mr-1" />
              {payload.ctaLabel || 'Show setup hint'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
