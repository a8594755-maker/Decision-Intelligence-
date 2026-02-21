/**
 * WhatIfBatchCard.jsx — Chat inline card for multi-scenario batch results (Gap 6B).
 *
 * Props:
 *   payload — {
 *     batch_status: 'running'|'done'|'partial',
 *     total, succeeded, failed,
 *     results: [{ name, status, scenario_id, comparison, error }],
 *     multi_scenario_summary
 *   }
 *   onSelectScenario? — (scenario) => void
 */

import React, { useState } from 'react';
import { FlaskConical, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, Badge } from '../ui';
import ScenarioMatrixView from '../whatif/ScenarioMatrixView';

function StatusIcon({ status }) {
  if (status === 'succeeded' || status === 'cached') {
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
  }
  if (status === 'failed') {
    return <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />;
  }
  return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />;
}

export default function WhatIfBatchCard({ payload, onSelectScenario }) {
  const [showDetails, setShowDetails] = useState(false);

  if (!payload) return null;

  const {
    batch_status,
    total = 0,
    succeeded = 0,
    failed = 0,
    results = [],
    multi_scenario_summary,
  } = payload;

  const isRunning = batch_status === 'running';
  const isDone = batch_status === 'done' || batch_status === 'partial';

  return (
    <Card className="w-full border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-900/10">
      <div className="space-y-3">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-blue-600 shrink-0" />
            <div>
              <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                What-If Batch Analysis
              </h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {isRunning
                  ? `Running ${total} scenario${total !== 1 ? 's' : ''}\u2026`
                  : `${succeeded} of ${total} scenarios completed`}
                {failed > 0 && ` \u00B7 ${failed} failed`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isRunning && <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />}
            <Badge type={isDone ? (failed > 0 ? 'warning' : 'success') : 'info'}>
              {isRunning ? 'Running' : isDone ? 'Done' : 'Queued'}
            </Badge>
          </div>
        </div>

        {/* Per-scenario status list */}
        {results.length > 0 && (
          <div className="space-y-1.5">
            {results.map((r, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <StatusIcon status={r.status} />
                <span className="text-xs text-slate-700 dark:text-slate-200 flex-1 truncate">
                  {r.name}
                </span>
                {r.status === 'failed' && r.error && (
                  <span className="text-[10px] text-red-500 truncate max-w-[120px]">
                    {r.error}
                  </span>
                )}
                {(r.status === 'succeeded' || r.status === 'cached') && r.comparison && (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                    SL: {((r.comparison.kpis?.scenario?.service_level_proxy ?? 0) * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Expandable matrix (shown after batch completes) */}
        {isDone && multi_scenario_summary?.scenarios?.length > 0 && (
          <>
            <div className="border-t border-blue-100 dark:border-blue-800/40 pt-2">
              <button
                onClick={() => setShowDetails((v) => !v)}
                className="w-full flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100 transition-colors"
              >
                <span className="font-medium">
                  {showDetails ? 'Hide' : 'Show'} Comparison Matrix
                </span>
                {showDetails
                  ? <ChevronUp className="w-3.5 h-3.5" />
                  : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </div>

            {showDetails && (
              <ScenarioMatrixView
                summary={multi_scenario_summary}
                onSelectScenario={onSelectScenario}
              />
            )}
          </>
        )}

        {/* Collapsed recommendation summary */}
        {isDone && multi_scenario_summary?.recommended_scenario && !showDetails && (
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span className="text-amber-500">{'\u2605'}</span>
            <span>
              Best overall:{' '}
              <strong>{multi_scenario_summary.recommended_scenario.name}</strong>
              {multi_scenario_summary.recommended_scenario.key_reasons?.[0] && (
                <span className="text-slate-400 ml-1">
                  {'\u2014'} {multi_scenario_summary.recommended_scenario.key_reasons[0]}
                </span>
              )}
            </span>
          </div>
        )}

      </div>
    </Card>
  );
}
