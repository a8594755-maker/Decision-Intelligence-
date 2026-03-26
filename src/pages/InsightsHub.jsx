/**
 * InsightsHub.jsx — AI Data Analyst Dashboard
 *
 * The agent queries raw data, builds an HTML dashboard,
 * and suggests deeper analyses the user can approve.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { generateCanvasLayout } from '../services/canvas/canvasAgentService';
import { executeInsightQuery } from '../services/canvas/insightsHubExecutor';
import { clearCachedSummary, getDashboardHistory } from '../services/agent-core/dashboardSummaryCache';
import {
  BarChart3, ArrowRight, RefreshCw, Play, Layers, Square,
} from 'lucide-react';

import InsightsDashboard from '../components/insights/InsightsDashboard';
import CanvasRenderer from '../components/insights/CanvasRenderer';
import SuggestionBlock from '../components/insights/blocks/SuggestionBlock';
import AgentThinkingBar from '../components/insights/AgentThinkingBar';
import { getOlistDemoLayout } from '../services/canvas/insightsHubDemoData';

export default function InsightsHub() {
  const { user } = useAuth();
  const userId = user?.id;

  const [dashResult, setDashResult] = useState(null); // { html, suggestions, title, thinking, ... }
  const [thinking, setThinking] = useState('');
  const [agentProgress, setAgentProgress] = useState('');
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasSource, setCanvasSource] = useState('');
  const [runningQuery, setRunningQuery] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [agentError, setAgentError] = useState(null);
  const [history, setHistory] = useState([]); // loaded async from IndexedDB
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = current (latest)
  const [demoLayout, setDemoLayout] = useState(null); // CanvasRenderer layout for demo mode
  const canvasAbortRef = useRef(null);
  const hasGenerated = useRef(false);

  // Computed — which version to show
  const activeDash = historyIndex >= 0 ? history[historyIndex] : dashResult;
  const hasHtml = !!activeDash?.html;
  const hasDataCards = activeDash?.dataCards?.length > 0;
  const suggestions = activeDash?.suggestions || [];
  const hasSuggestions = suggestions.length > 0;

  // ── Generate dashboard ──
  const generateCanvas = useCallback(async (force = false) => {
    if (!userId) return;

    if (canvasAbortRef.current) canvasAbortRef.current.abort();
    const abortController = new AbortController();
    canvasAbortRef.current = abortController;

    setCanvasLoading(true);
    setThinking('');
    setAgentProgress('');
    setAgentError(null);
    try {
      const { result, source } = await generateCanvasLayout({
        force,
        onProgress: (msg) => { if (!abortController.signal.aborted) setAgentProgress(msg); },
        userId,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      setDashResult(result);
      setThinking(result?.thinking || '');
      setCanvasSource(source);
      setHistoryIndex(-1);
      // Reload history from localStorage (new version was saved by canvasAgentService)
      if (result?.html || result?.dataCards?.length) getDashboardHistory().then(h => setHistory(h));
      if (!result?.html && !result?.dataCards?.length && !result?.blocks?.length) {
        setAgentError('Agent could not generate a dashboard. Check that data has been uploaded.');
      }
    } catch (err) {
      if (abortController.signal.aborted) return;
      console.warn('[InsightsHub] generation failed:', err);
      setAgentError(`Agent failed: ${err.message || 'Unknown error'}`);
    } finally {
      if (!abortController.signal.aborted) setCanvasLoading(false);
    }
  }, [userId]);

  // Load history from IndexedDB on mount
  useEffect(() => {
    getDashboardHistory().then(h => setHistory(h));
  }, []);

  useEffect(() => {
    if (userId && !hasGenerated.current) {
      hasGenerated.current = true;
      generateCanvas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleStop = useCallback(() => {
    if (canvasAbortRef.current) canvasAbortRef.current.abort();
    canvasAbortRef.current = null;
    setCanvasLoading(false);
    setBatchRunning(false);
    setRunningQuery(null);
    setAgentProgress('');
  }, []);

  const handleRegenerate = () => {
    // Don't clear cache here — force=true skips cache read, and new result overwrites it
    setHistoryIndex(-1);
    generateCanvas(true);
  };

  // View a previous version from history
  const viewHistoryVersion = (index) => {
    if (index < 0 || index >= history.length) return;
    setHistoryIndex(index);
  };

  const backToCurrent = () => setHistoryIndex(-1);

  // ── Run a suggestion ──
  const handleRunSuggestion = useCallback(async (query) => {
    if (!query || !userId || runningQuery) return;
    setRunningQuery(query);
    setAgentProgress('Running suggested analysis...');
    try {
      await executeInsightQuery(query, userId, {
        onProgress: (msg) => setAgentProgress(msg),
      });
      clearCachedSummary('di_canvas_layout');
      generateCanvas(true);
    } catch (err) {
      console.warn('[InsightsHub] suggestion failed:', err);
    } finally {
      setRunningQuery(null);
      setAgentProgress('');
    }
  }, [userId, runningQuery, generateCanvas]);

  const handleAction = useCallback((action) => {
    if (action?.type === 'run_suggestion' && action.query) {
      handleRunSuggestion(action.query);
    }
  }, [handleRunSuggestion]);

  // ── Batch run ──
  const handleBatchRun = useCallback(async () => {
    if (!suggestions.length || !userId || batchRunning || runningQuery) return;
    setBatchRunning(true);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      setRunningQuery(s.query);
      setAgentProgress(`Running ${i + 1}/${suggestions.length}: ${s.title || 'Analysis'}...`);
      try {
        await executeInsightQuery(s.query, userId, {
          onProgress: (msg) => setAgentProgress(`[${i + 1}/${suggestions.length}] ${msg}`),
        });
      } catch (err) {
        console.warn(`[InsightsHub] batch ${i + 1} failed:`, err);
      }
    }
    setBatchRunning(false);
    setRunningQuery(null);
    setAgentProgress('');
    clearCachedSummary('di_canvas_layout');
    generateCanvas(true);
  }, [suggestions, userId, batchRunning, runningQuery, generateCanvas]);

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
                  {demoLayout?.title || activeDash?.title || 'Insights Hub'}
                </h1>
                {(demoLayout?.subtitle || activeDash?.subtitle) && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">{demoLayout?.subtitle || activeDash.subtitle}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canvasSource && !canvasLoading && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400">
                  {canvasSource === 'agent' ? 'Agent' : canvasSource === 'cache' ? 'Cached' : 'Auto'}
                </span>
              )}
              {activeDash?.review && !canvasLoading && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                  (activeDash.review.corrections?.length > 0)
                    ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                    : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                }`}>
                  {(activeDash.review.corrections?.length > 0)
                    ? `${activeDash.review.corrections.length} corrections`
                    : `${activeDash.review.passed?.length || 0} verified`}
                </span>
              )}
              {/* Version selector */}
              {history.length > 0 && !canvasLoading && (
                <select
                  value={historyIndex}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    if (idx < 0) backToCurrent();
                    else viewHistoryVersion(idx);
                  }}
                  className="text-[11px] px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                >
                  <option value={-1}>Current</option>
                  {history.map((h, i) => (
                    <option key={i} value={i}>
                      v{h.version || i + 1} · {new Date(h.timestamp).toLocaleDateString()} {new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => {
                  if (demoLayout) { setDemoLayout(null); return; }
                  setDemoLayout(getOlistDemoLayout());
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  demoLayout
                    ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                {demoLayout ? 'Exit Demo' : 'Demo'}
              </button>
              {hasSuggestions && !canvasLoading && historyIndex < 0 && !demoLayout && (
                <button
                  onClick={handleBatchRun}
                  disabled={batchRunning || !!runningQuery}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 disabled:opacity-50 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  {batchRunning ? 'Running...' : `Run All (${suggestions.length})`}
                </button>
              )}
              {(canvasLoading || batchRunning || !!runningQuery) && (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/50 transition-colors"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Stop
                </button>
              )}
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

      {/* ── Main ── */}
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">
        {/* Agent progress bar */}
        {(canvasLoading || batchRunning || !!runningQuery || (canvasSource === 'agent' && thinking)) && (
          <div className="mb-4">
            <AgentThinkingBar
              thinking={thinking}
              loading={canvasLoading || batchRunning || !!runningQuery}
              progress={agentProgress}
            />
          </div>
        )}

        {/* Demo mode — CanvasRenderer with pre-computed Olist data */}
        {demoLayout && (
          <CanvasRenderer layout={demoLayout} onAction={handleAction} runningQuery={runningQuery} />
        )}

        {/* Loading */}
        {!demoLayout && canvasLoading && !hasHtml && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin mx-auto mb-4" />
              <p className="text-sm text-slate-500">{agentProgress || 'Agent is analyzing your data...'}</p>
            </div>
          </div>
        )}

        {/* HTML Dashboard */}
        {/* Viewing history indicator */}
        {!demoLayout && historyIndex >= 0 && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-800">
            <span className="text-xs text-indigo-600 dark:text-indigo-400">
              Viewing version {historyIndex + 1} of {history.length} · {new Date(history[historyIndex]?.timestamp).toLocaleString()}
            </span>
            <button onClick={backToCurrent} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 ml-auto">
              ← Back to current
            </button>
          </div>
        )}

        {/* React-rendered dashboard with embedded charts */}
        {!demoLayout && hasDataCards && (
          <InsightsDashboard dataCards={activeDash.dataCards} layout={activeDash.layout} />
        )}

        {/* Legacy HTML fallback (for old cached dashboards) */}
        {!demoLayout && !hasDataCards && hasHtml && (
          <iframe
            srcDoc={activeDash.html}
            sandbox="allow-scripts"
            className="w-full border-0 rounded-xl overflow-hidden bg-white"
            style={{ minHeight: '600px' }}
            title="Insights Dashboard"
          />
        )}

        {/* Suggestions (rendered natively, below iframe) */}
        {!demoLayout && hasSuggestions && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
              Recommended Analyses ({suggestions.length})
            </h3>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {suggestions.map((s, i) => (
                <SuggestionBlock
                  key={i}
                  title={s.title}
                  description={s.description}
                  query={s.query}
                  priority={s.priority}
                  onAction={handleAction}
                  loading={runningQuery === s.query}
                />
              ))}
            </div>
          </div>
        )}

        {/* Error state */}
        {!demoLayout && !canvasLoading && !hasHtml && !hasDataCards && agentError && (
          <ErrorState message={agentError} onRetry={handleRegenerate} />
        )}

        {/* Empty — never generated */}
        {!demoLayout && !canvasLoading && !hasHtml && !hasDataCards && !agentError && !hasGenerated.current && (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center mb-6">
        <BarChart3 className="w-10 h-10 text-red-500/60" />
      </div>
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2">Agent encountered an issue</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mb-8">{message}</p>
      <button onClick={onRetry} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm">
        <RefreshCw className="w-4 h-4" /> Try Again
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
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2">No data available</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mb-8">Upload a dataset in the Workspace first. The AI analyst will automatically explore your data and build a dashboard.</p>
      <a href="/workspace" className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm">
        Go to Workspace <ArrowRight className="w-4 h-4" />
      </a>
    </div>
  );
}
