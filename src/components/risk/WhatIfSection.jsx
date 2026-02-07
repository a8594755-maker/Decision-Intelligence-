import React, { useEffect, useState } from 'react';
import { Zap, Loader2, TrendingDown, TrendingUp, DollarSign, Calculator, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { Card, Badge } from '../ui';

/**
 * WhatIfSection - What-if Simulator for Risk Dashboard
 * M7.2 WP2: Expedite action MVP
 */
const WhatIfSection = ({
  userId,
  materialCode,
  plantId,
  bomRunId,
  keyContext, // { onHand, safetyStock, gapQty, inboundLines, pStockout, impactUsd }
  onRunWhatIf,
  result,
  replayDraft // M7.3 WP3: Replay draft from audit event
}) => {
  const [byBuckets, setByBuckets] = useState(1);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const next = result?.action?.byBuckets;
    if (typeof next === 'number' && Number.isFinite(next)) {
      setByBuckets(next);
    }
  }, [result?.action?.byBuckets]);

  // M7.3 WP3: Handle replay draft from audit event
  const [isReplayMode, setIsReplayMode] = useState(false);
  
  useEffect(() => {
    if (replayDraft?.action?.byBuckets) {
      console.log('[WhatIf] Applying replay draft:', replayDraft);
      setByBuckets(replayDraft.action.byBuckets);
      setIsReplayMode(true);
      // Note: We don't auto-run, user must click Run
    }
  }, [replayDraft]);

  const handleRun = async () => {
    if (!onRunWhatIf) return;
    
    setLoading(true);
    try {
      await onRunWhatIf({
        type: 'expedite',
        byBuckets,
        scope: 'single_key'
      });
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  // If no result yet, show action selector
  if (!result) {
    return (
      <Card className="bg-gradient-to-br from-blue-50 to-white dark:from-blue-900/20 dark:to-slate-800">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold text-lg">What-if Simulator</h3>
            <Badge variant="secondary" className="text-xs">MVP</Badge>
            {isReplayMode && (
              <Badge variant="warning" className="text-xs bg-amber-100 text-amber-700">
                Replay Ready
              </Badge>
            )}
          </div>

          {/* Action Selector */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Action: Expedite
              </label>
              <p className="text-xs text-slate-500 mt-1">
                Shift inbound arrivals earlier by N buckets
              </p>
            </div>

            {/* Bucket Slider */}
            <div>
              <label className="text-sm text-slate-600 dark:text-slate-400">
                Expedite by: <span className="font-bold text-blue-600">{byBuckets}</span> bucket(s)
              </label>
              <input
                type="range"
                min="1"
                max="4"
                value={byBuckets}
                onChange={(e) => setByBuckets(parseInt(e.target.value))}
                className="w-full mt-2 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-xs text-slate-400 mt-1">
                <span>1</span>
                <span>2</span>
                <span>3</span>
                <span>4</span>
              </div>
            </div>

            {/* Scope */}
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Scope: <span className="font-medium">This key ({materialCode}|{plantId})</span>
            </div>

            {/* Run Button */}
            <button
              onClick={handleRun}
              disabled={loading || !bomRunId}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  Run What-if
                </>
              )}
            </button>
          </div>
        </div>
      </Card>
    );
  }

  // Show results
  const { before, after, delta, roi, action, whatIfRunId } = result;

  return (
    <Card className="bg-gradient-to-br from-blue-50 to-white dark:from-blue-900/20 dark:to-slate-800">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold text-lg">What-if Results</h3>
          </div>
          <Badge 
            variant={roi > 0 ? 'success' : roi < 0 ? 'danger' : 'secondary'}
            className="text-sm"
          >
            ROI: {roi > 0 ? '+' : ''}{roi.toFixed(2)}
          </Badge>
        </div>

        {/* Run ID */}
        <div className="text-xs text-slate-500">
          Run ID: <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">{whatIfRunId?.slice(0, 8)}...</code>
          <span className="ml-2">Action: Expedite {action?.byBuckets} bucket(s)</span>
        </div>

        {/* Bucket Slider (for rerun) */}
        <div>
          <label className="text-sm text-slate-600 dark:text-slate-400">
            Expedite by: <span className="font-bold text-blue-600">{byBuckets}</span> bucket(s)
          </label>
          <input
            type="range"
            min="1"
            max="4"
            value={byBuckets}
            onChange={(e) => setByBuckets(parseInt(e.target.value))}
            disabled={loading}
            className="w-full mt-2 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <div className="flex justify-between text-xs text-slate-400 mt-1">
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
          </div>
        </div>

        {/* Before / After Cards */}
        <div className="grid grid-cols-2 gap-3">
          {/* Before */}
          <div className="bg-slate-100 dark:bg-slate-800 rounded-lg p-3">
            <div className="text-xs text-slate-500 uppercase mb-2">Before</div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">P(Stockout)</span>
                <span className="font-medium">{(before.pStockout * 100).toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Score</span>
                <span className="font-medium">{before.score.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Impact</span>
                <span className="font-medium">${before.impactUsd.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* After */}
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-200 dark:border-green-800">
            <div className="text-xs text-green-600 uppercase mb-2">After</div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">P(Stockout)</span>
                <span className="font-medium text-green-600">{(after.pStockout * 100).toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Score</span>
                <span className="font-medium text-green-600">{after.score.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Impact</span>
                <span className="font-medium text-green-600">${after.impactUsd.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Delta Cards */}
        <div className="grid grid-cols-3 gap-2">
          <div className={`p-2 rounded text-center ${delta.score <= 0 ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            <div className="text-xs text-slate-500">ΔScore</div>
            <div className={`font-bold ${delta.score <= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {delta.score > 0 ? '+' : ''}{delta.score.toLocaleString()}
            </div>
          </div>
          <div className={`p-2 rounded text-center ${delta.impactUsd <= 0 ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            <div className="text-xs text-slate-500">ΔImpact</div>
            <div className={`font-bold ${delta.impactUsd <= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {delta.impactUsd > 0 ? '+' : ''}${delta.impactUsd.toLocaleString()}
            </div>
          </div>
          <div className="bg-amber-100 dark:bg-amber-900/30 p-2 rounded text-center">
            <div className="text-xs text-slate-500">ΔCost</div>
            <div className="font-bold text-amber-600">
              +${delta.costUsd.toLocaleString()}
            </div>
          </div>
        </div>

        {/* Formula */}
        <div className="bg-slate-100 dark:bg-slate-800 rounded p-2 text-xs text-slate-600">
          <div className="font-mono">
            ROI = (Benefit - Cost) / Cost
          </div>
          <div className="mt-1">
            = (${Math.abs(delta.impactUsd).toLocaleString()} - ${delta.costUsd.toLocaleString()}) / ${delta.costUsd.toLocaleString()}
          </div>
          <div className="mt-1 font-semibold">
            = {roi.toFixed(2)}
          </div>
        </div>

        {/* Collapse/Expand */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-xs text-slate-500 flex items-center justify-center gap-1 py-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
        >
          {expanded ? (
            <><ChevronUp className="w-3 h-3" /> Hide details</>
          ) : (
            <><ChevronDown className="w-3 h-3" /> Show details</>
          )}
        </button>

        {/* Expanded Details */}
        {expanded && (
          <div className="text-xs text-slate-500 space-y-1 border-t border-slate-200 dark:border-slate-700 pt-2">
            <div>• Expedited {action?.byBuckets} bucket(s) forward</div>
            <div>• P(Stockout) reduced by {Math.abs(delta.pStockout * 100).toFixed(0)}%</div>
            <div>• Saved as What-if run: {whatIfRunId?.slice(0, 8)}</div>
            <div>• Audit event logged</div>
          </div>
        )}

        {/* Run Again Button */}
        <button
          onClick={handleRun}
          disabled={loading || !bomRunId}
          className="w-full px-3 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors text-sm"
        >
          {loading ? 'Running...' : 'Run again with different buckets'}
        </button>
      </div>
    </Card>
  );
};

export default WhatIfSection;
