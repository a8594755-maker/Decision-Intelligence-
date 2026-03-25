/**
 * InsightsHub.jsx — AI Data Analyst Dashboard
 *
 * The AI agent queries raw data directly, computes KPIs/charts/tables,
 * and builds a comprehensive dashboard with actionable suggestions.
 * No dependency on chat snapshots.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { generateCanvasLayout } from '../services/canvas/canvasAgentService';
import { executeInsightQuery } from '../services/canvas/insightsHubExecutor';
import { clearCachedSummary } from '../services/agent-core/dashboardSummaryCache';
import { buildSkeletonLayout } from '../services/canvas/canvasLayoutSchema';
import {
  BarChart3, ArrowRight, RefreshCw, Play,
} from 'lucide-react';

import CanvasRenderer from '../components/insights/CanvasRenderer';
import AgentThinkingBar from '../components/insights/AgentThinkingBar';

export default function InsightsHub() {
  const { user } = useAuth();
  const userId = user?.id;

  const [layout, setLayout] = useState(null);
  const [thinking, setThinking] = useState('');
  const [agentProgress, setAgentProgress] = useState('');
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasSource, setCanvasSource] = useState('');
  const [runningQuery, setRunningQuery] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [agentError, setAgentError] = useState(null);
  const canvasAbortRef = useRef(null);
  const hasGenerated = useRef(false);

  const hasLayout = layout?.blocks?.length > 0;
  const suggestionBlocks = layout?.blocks?.filter(b => b.type === 'suggestion' && b.props?.query) || [];
  const hasSuggestions = suggestionBlocks.length > 0;

  // ── Generate canvas layout ──
  const generateCanvas = useCallback(async (force = false) => {
    if (!userId) return;

    // Abort any previous agent run
    if (canvasAbortRef.current) canvasAbortRef.current.abort();
    const abortController = new AbortController();
    canvasAbortRef.current = abortController;

    setCanvasLoading(true);
    setThinking('');
    setAgentProgress('');
    setAgentError(null);
    try {
      const { layout: newLayout, source } = await generateCanvasLayout({
        force,
        onProgress: (msg) => {
          if (!abortController.signal.aborted) setAgentProgress(msg);
        },
        userId,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      setLayout(newLayout);
      setThinking(newLayout.thinking || '');
      setCanvasSource(source);
      if (source === 'empty' && !newLayout?.blocks?.length) {
        setAgentError('Agent could not generate a dashboard. This may be because no data has been uploaded, or the analysis timed out.');
      }
    } catch (err) {
      if (abortController.signal.aborted) return;
      console.warn('[InsightsHub] canvas generation failed:', err);
      setAgentError(`Agent failed: ${err.message || 'Unknown error'}`);
    } finally {
      if (!abortController.signal.aborted) setCanvasLoading(false);
    }
  }, [userId]);

  // Auto-generate on mount (once per userId)
  useEffect(() => {
    if (userId && !hasGenerated.current) {
      hasGenerated.current = true;
      generateCanvas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ── Regenerate ──
  const handleRegenerate = () => {
    clearCachedSummary('di_canvas_layout');
    generateCanvas(true);
  };

  // ── Run suggestion from agent ──
  const handleAction = useCallback(async (action) => {
    if (action?.type !== 'run_suggestion' || !action.query || !userId) return;
    if (runningQuery) return;

    setRunningQuery(action.query);
    setAgentProgress('Running suggested analysis...');
    try {
      const result = await executeInsightQuery(action.query, userId, {
        onProgress: (msg) => setAgentProgress(msg),
      });
      if (result.success) {
        // Regenerate dashboard to incorporate new data
        clearCachedSummary('di_canvas_layout');
        generateCanvas(true);
      } else {
        console.warn('[InsightsHub] Suggestion execution failed:', result.error);
      }
    } catch (err) {
      console.warn('[InsightsHub] Suggestion execution error:', err);
    } finally {
      setRunningQuery(null);
      setAgentProgress('');
    }
  }, [userId, runningQuery, generateCanvas]);

  // ── Batch run all suggestions ──
  const handleBatchRun = useCallback(async () => {
    if (!layout?.blocks || !userId || batchRunning || runningQuery) return;
    const suggestions = layout.blocks.filter(b => b.type === 'suggestion' && b.props?.query);
    if (!suggestions.length) return;

    setBatchRunning(true);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      const label = s.props.title || 'Analysis';
      setRunningQuery(s.props.query);
      setAgentProgress(`Running ${i + 1}/${suggestions.length}: ${label}...`);
      try {
        await executeInsightQuery(s.props.query, userId, {
          onProgress: (msg) => setAgentProgress(`[${i + 1}/${suggestions.length}] ${msg}`),
        });
      } catch (err) {
        console.warn(`[InsightsHub] Batch item ${i + 1} failed:`, err);
      }
    }
    setBatchRunning(false);
    setRunningQuery(null);
    setAgentProgress('');
    clearCachedSummary('di_canvas_layout');
    generateCanvas(true);
  }, [layout, userId, batchRunning, runningQuery, generateCanvas]);

  const skeletonLayout = buildSkeletonLayout();

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">

      {/* ── Header ── */}
      <div className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm">
                <BarChart3 className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-slate-900 dark:text-white">
                  {layout?.title || 'Insights Hub'}
                </h1>
                {layout?.subtitle && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {layout.subtitle}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Source badge */}
              {canvasSource && !canvasLoading && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400">
                  {canvasSource === 'agent' ? 'Agent' : canvasSource === 'cache' ? 'Cached' : 'Auto'}
                </span>
              )}

              {/* Run All Suggestions button */}
              {hasSuggestions && !canvasLoading && (
                <button
                  onClick={handleBatchRun}
                  disabled={batchRunning || !!runningQuery}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 disabled:opacity-50 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  {batchRunning ? 'Running...' : `Run All (${suggestionBlocks.length})`}
                </button>
              )}

              {/* Regenerate button */}
              <button
                onClick={handleRegenerate}
                disabled={canvasLoading || batchRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/50 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${canvasLoading ? 'animate-spin' : ''}`} />
                Regenerate
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">

        {/* Agent thinking bar */}
        {(canvasLoading || batchRunning || !!runningQuery || (canvasSource === 'agent' && thinking)) && (
          <div className="mb-4">
            <AgentThinkingBar
              thinking={thinking}
              loading={canvasLoading || batchRunning || !!runningQuery}
              progress={agentProgress}
            />
          </div>
        )}

        {/* Loading skeleton */}
        {canvasLoading && !hasLayout && (
          <CanvasRenderer layout={skeletonLayout} />
        )}

        {/* Dashboard canvas */}
        {hasLayout && (
          <CanvasRenderer layout={layout} onAction={handleAction} runningQuery={runningQuery} />
        )}

        {/* Error state — agent failed */}
        {!canvasLoading && !hasLayout && agentError && (
          <ErrorState message={agentError} onRetry={handleRegenerate} />
        )}

        {/* Empty state — never generated yet */}
        {!canvasLoading && !hasLayout && !agentError && !hasGenerated.current && (
          <EmptyState />
        )}
      </div>
    </div>
  );
}


// ── Sub-components ───────────────────────────────────────────────────────────

function ErrorState({ message, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center mb-6">
        <BarChart3 className="w-10 h-10 text-red-500/60" />
      </div>
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2">
        Agent encountered an issue
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mb-8 leading-relaxed">
        {message}
      </p>
      <button
        onClick={onRetry}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm"
      >
        <RefreshCw className="w-4 h-4" />
        Try Again
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 flex items-center justify-center mb-6">
        <BarChart3 className="w-10 h-10 text-blue-500/60" />
      </div>
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2">
        No data available
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mb-8 leading-relaxed">
        Upload a dataset in the Workspace first. The AI analyst will automatically explore your data and build a comprehensive dashboard.
      </p>
      <a
        href="/workspace"
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm"
      >
        Go to Workspace
        <ArrowRight className="w-4 h-4" />
      </a>
    </div>
  );
}
