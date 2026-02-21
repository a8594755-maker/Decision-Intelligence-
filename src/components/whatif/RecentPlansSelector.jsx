/**
 * RecentPlansSelector — dropdown list of recent succeeded optimize runs.
 * Used inside BasePlanEmptyState and StaleBaselineWarning.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, CheckCircle2, Clock } from 'lucide-react';

function formatRelativeTime(isoTs) {
  if (!isoTs) return '';
  const diffMs = Date.now() - new Date(isoTs).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

export default function RecentPlansSelector({ plans = [], onSelect, disabled = false }) {
  const [open, setOpen] = useState(false);

  if (!plans || plans.length === 0) return null;

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-slate-400" />
          Use a recent plan
        </span>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-10 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden">
          <div className="max-h-48 overflow-y-auto">
            {plans.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => {
                  onSelect(run);
                  setOpen(false);
                }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-100 dark:border-slate-700 last:border-0 transition-colors"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                  <span className="text-slate-700 dark:text-slate-200 truncate">
                    Run #{run.id}
                  </span>
                  {run.dataset_profile_id && (
                    <span className="text-slate-400 flex-shrink-0">
                      · profile {run.dataset_profile_id}
                    </span>
                  )}
                </span>
                <span className="text-slate-400 flex-shrink-0">
                  {formatRelativeTime(run.created_at)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
