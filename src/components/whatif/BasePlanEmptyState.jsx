/**
 * BasePlanEmptyState — replaces the old dead-end "No base plan selected" message.
 *
 * Shown when mode === 'no_plan'. Provides three paths forward:
 *   1. Run baseline now (auto-baseline, recommended)
 *   2. Use a recent plan (dropdown selector)
 *   3. Switch to Risk What-If (no plan required)
 */

import React from 'react';
import { Play, ShieldAlert, AlertTriangle, Loader2, X } from 'lucide-react';
import RecentPlansSelector from './RecentPlansSelector';

export default function BasePlanEmptyState({
  onRunBaseline,
  onSelectRecent,
  onSwitchToRisk,
  recentPlans = [],
  isRunning = false,
  progress = null,
  error = null,
  onClearError = null,
  hasProfileRow = false   // whether datasetProfileRow is available for auto-run
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
      {/* Icon */}
      <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
        <Play className="w-5 h-5 text-slate-400" />
      </div>

      {/* Heading */}
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">
        No baseline plan found
      </p>
      <p className="text-xs text-slate-400 dark:text-slate-500 mb-5 max-w-[220px]">
        Choose an option below to get started with What-If analysis.
      </p>

      {/* Actions */}
      <div className="w-full max-w-[240px] flex flex-col gap-2">
        {/* Action 1: Run baseline now */}
        <button
          type="button"
          onClick={onRunBaseline}
          disabled={isRunning || !hasProfileRow}
          title={!hasProfileRow ? 'No dataset loaded — upload data first' : undefined}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            isRunning || !hasProfileRow
              ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {isRunning ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running baseline…</>
          ) : (
            <><Play className="w-3.5 h-3.5" /> Run baseline now (recommended)</>
          )}
        </button>

        {/* Action 2: Use a recent plan */}
        <RecentPlansSelector
          plans={recentPlans}
          onSelect={onSelectRecent}
          disabled={isRunning}
        />

        {/* Action 3: Switch to Risk What-If */}
        <button
          type="button"
          onClick={onSwitchToRisk}
          disabled={isRunning}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
          Switch to Risk What-If
        </button>
      </div>

      {/* Progress message */}
      {progress && (
        <div className="mt-4 flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          {progress}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 w-full max-w-[240px] flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-600 dark:text-red-400 text-left flex-1">{error}</p>
          {onClearError && (
            <button type="button" onClick={onClearError} className="ml-auto flex-shrink-0">
              <X className="w-3 h-3 text-red-400" />
            </button>
          )}
        </div>
      )}

      {/* Hint when no profile row */}
      {!hasProfileRow && !isRunning && (
        <p className="mt-3 text-xs text-slate-400 max-w-[220px]">
          Upload dataset data in the chat first to enable auto-baseline.
        </p>
      )}
    </div>
  );
}
