/**
 * RiskWhatIfView — fallback What-If mode that works without a baseline plan.
 *
 * Shown when the resolver lands in mode === 'risk'. The user can:
 *   - Explore risk-adjusted override parameters
 *   - Generate a risk-adjusted plan on demand (auto-baseline with riskMode='on')
 *   - Switch back to waiting for a baseline plan
 */

import React, { useState } from 'react';
import { ShieldAlert, Play, Loader2, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import { runAutoBaseline } from '../../services/basePlanResolverService';
import ScenarioOverridesForm, { getDefaultOverrides } from './ScenarioOverridesForm';

// Pre-seed sensible risk-focused defaults for the form
function getRiskDefaults() {
  return {
    ...getDefaultOverrides(),
    risk_mode: 'on',
    safety_stock_alpha: 0.5,
    stockout_penalty_multiplier: 1.5
  };
}

export default function RiskWhatIfView({
  datasetProfileRow = null,
  onPlanGenerated,    // (run) => void  — called when plan creation succeeds
  onSwitchToPlanMode  // () => void      — user wants to go back to plan mode
}) {
  const [overrides, setOverrides] = useState(getRiskDefaults);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const hasProfile = Boolean(datasetProfileRow?.id);

  const handleGenerate = async () => {
    if (!hasProfile) return;
    setIsGenerating(true);
    setError(null);
    setProgress('Generating risk-adjusted plan…');

    try {
      const result = await runAutoBaseline({
        userId: datasetProfileRow?.user_id ?? null,
        datasetProfileRow,
        riskMode: 'on',
        onProgress: ({ message }) => setProgress(message)
      });

      if (result.success && result.run) {
        setProgress(null);
        onPlanGenerated?.(result.run);
      } else {
        const msgs = {
          missing_profile: 'No dataset profile available.',
          infeasible: 'Plan is infeasible with current data/constraints.',
          no_run_returned: 'Plan generation returned no result.'
        };
        setError(msgs[result.reason] || result.reason || 'Plan generation failed.');
        setProgress(null);
      }
    } catch (err) {
      setError(err?.message || 'An unexpected error occurred.');
      setProgress(null);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header banner */}
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 flex-shrink-0">
        <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            Risk What-If Mode
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No baseline plan required. Generate a risk-adjusted plan directly.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Back link */}
        <button
          type="button"
          onClick={onSwitchToPlanMode}
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to baseline resolver
        </button>

        {/* Explanation */}
        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Adjust the risk parameters below and click{' '}
            <span className="font-medium text-slate-700 dark:text-slate-300">
              Generate Risk-Adjusted Plan
            </span>{' '}
            to create a baseline from scratch. Once generated, the plan becomes your baseline for
            standard What-If scenario comparison.
          </p>
        </div>

        {/* Override form (risk-focused, pre-seeded) */}
        <ScenarioOverridesForm
          overrides={overrides}
          onChange={setOverrides}
          disabled={isGenerating}
        />

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-600 dark:text-red-400 flex-1">{error}</p>
            <button type="button" onClick={() => setError(null)} className="ml-auto">
              <X className="w-3 h-3 text-red-400" />
            </button>
          </div>
        )}

        {/* Progress */}
        {progress && (
          <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            {progress}
          </div>
        )}

        {/* Generate button */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating || !hasProfile}
          title={!hasProfile ? 'No dataset loaded — upload data first' : undefined}
          className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
            isGenerating || !hasProfile
              ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-amber-600 text-white hover:bg-amber-700'
          }`}
        >
          {isGenerating ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
          ) : (
            <><Play className="w-4 h-4" /> Generate Risk-Adjusted Plan</>
          )}
        </button>

        {!hasProfile && (
          <p className="text-xs text-slate-400 text-center">
            Upload dataset data in the chat to enable plan generation.
          </p>
        )}
      </div>
    </div>
  );
}
