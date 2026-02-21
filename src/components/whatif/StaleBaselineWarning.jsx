/**
 * StaleBaselineWarning — dismissible banner shown when mode === 'stale'.
 *
 * Offers three actions:
 *   - Re-run baseline (creates a fresh plan)
 *   - Use anyway (dismiss and proceed with stale plan)
 *   - Switch to Risk What-If
 */

import React from 'react';
import { AlertTriangle, RefreshCw, ShieldAlert, X } from 'lucide-react';

const REASON_LABELS = {
  stale_data: 'newer data import detected',
  stale_contract: 'contract was updated',
  profile_mismatch: 'dataset profile changed',
  no_run: 'baseline plan not found'
};

export default function StaleBaselineWarning({
  reason = null,
  onRerun,
  onUseAnyway,
  onSwitchToRisk,
  isRerunning = false
}) {
  const label = REASON_LABELS[reason] || 'baseline may be outdated';

  return (
    <div className="mx-3 mt-2 mb-0 flex flex-col gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-amber-700 dark:text-amber-300 flex-1">
          <span className="font-medium">Baseline may be stale</span>
          {label ? ` — ${label}.` : '.'}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onRerun}
          disabled={isRerunning}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${isRerunning ? 'animate-spin' : ''}`} />
          Re-run baseline
        </button>

        <button
          type="button"
          onClick={onUseAnyway}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
        >
          Use anyway
        </button>

        <button
          type="button"
          onClick={onSwitchToRisk}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
        >
          <ShieldAlert className="w-3 h-3 text-amber-500" />
          Risk What-If
        </button>
      </div>
    </div>
  );
}
