/**
 * InsightsHub.jsx — Agent-Driven Canvas Dashboard
 *
 * The AI agent analyzes all analysis snapshots and autonomously composes
 * a rich, information-dense dashboard layout (KPIs, charts, tables,
 * narratives, alerts, etc.) on a 12-column CSS Grid canvas.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { fetchSnapshots, backfillFromConversations } from '../services/analysisSnapshotService';
import { generateCanvasLayout } from '../services/canvasAgentService';
import { clearCachedSummary } from '../services/dashboardSummaryCache';
import { buildSkeletonLayout } from '../services/canvasLayoutSchema';
import {
  BarChart3, Download, ArrowRight, RefreshCw,
} from 'lucide-react';

import CanvasRenderer from '../components/insights/CanvasRenderer';
import AgentThinkingBar from '../components/insights/AgentThinkingBar';

export default function InsightsHub() {
  const { user } = useAuth();
  const userId = user?.id;

  const [snapshots, setSnapshots] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState(null);
  const [thinking, setThinking] = useState('');
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasSource, setCanvasSource] = useState('');
  const [backfillStatus, setBackfillStatus] = useState(null);
  const [backfillProgress, setBackfillProgress] = useState(null);

  const hasData = totalCount > 0;

  // ── Fetch snapshots ──
  const loadSnapshots = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const result = await fetchSnapshots(userId, { limit: 100, offset: 0 });
      setSnapshots(result.data);
      setTotalCount(result.count);
    } catch (err) {
      console.warn('[InsightsHub] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  // ── Generate canvas layout when snapshots load ──
  const generateCanvas = useCallback(async (force = false) => {
    if (!snapshots.length) return;
    setCanvasLoading(true);
    setThinking('');
    try {
      const { layout: newLayout, source } = await generateCanvasLayout(snapshots, { force });
      setLayout(newLayout);
      setThinking(newLayout.thinking || '');
      setCanvasSource(source);
    } catch (err) {
      console.warn('[InsightsHub] canvas generation failed:', err);
    } finally {
      setCanvasLoading(false);
    }
  }, [snapshots]);

  useEffect(() => {
    if (snapshots.length > 0) generateCanvas();
  }, [snapshots.length, generateCanvas]);

  // ── Regenerate ──
  const handleRegenerate = () => {
    clearCachedSummary('di_canvas_layout');
    generateCanvas(true);
  };

  // ── Backfill ──
  const handleBackfill = async () => {
    if (!userId || backfillStatus === 'running') return;
    setBackfillStatus('running');
    setBackfillProgress({ scanned: 0, created: 0, total: 0 });
    try {
      const result = await backfillFromConversations(userId, (p) => setBackfillProgress(p));
      setBackfillProgress((prev) => ({ ...prev, ...result }));
      setBackfillStatus('done');
      loadSnapshots();
    } catch (err) {
      console.warn('[InsightsHub] backfill failed:', err);
      setBackfillStatus('done');
    }
  };

  // ── Skeleton layout while loading ──
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
                {(layout?.subtitle || hasData) && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {layout?.subtitle || `${totalCount} analysis reports`}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Source badge */}
              {canvasSource && !canvasLoading && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400">
                  {canvasSource === 'llm' ? 'AI Layout' : canvasSource === 'cache' ? 'Cached' : 'Auto'}
                </span>
              )}

              {/* Backfill status */}
              {backfillStatus === 'running' && backfillProgress && (
                <span className="text-xs text-slate-500 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg">
                  {backfillProgress.scanned}/{backfillProgress.total} ({backfillProgress.created} found)
                </span>
              )}

              {/* Import button */}
              <button
                onClick={handleBackfill}
                disabled={backfillStatus === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                {backfillStatus === 'running' ? 'Importing...' : 'Import'}
              </button>

              {/* Regenerate button */}
              {hasData && (
                <button
                  onClick={handleRegenerate}
                  disabled={canvasLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/50 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${canvasLoading ? 'animate-spin' : ''}`} />
                  Regenerate
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">

        {/* ── Empty state ── */}
        {!loading && !hasData && (
          <EmptyState onBackfill={handleBackfill} backfillStatus={backfillStatus} />
        )}

        {/* ── Loading state (skeleton canvas) ── */}
        {loading && !hasData && (
          <CanvasRenderer layout={skeletonLayout} />
        )}

        {/* ── Canvas ── */}
        {hasData && (
          <div className="space-y-4">
            {/* Agent thinking bar */}
            <AgentThinkingBar thinking={thinking} loading={canvasLoading} />

            {/* The canvas grid */}
            {canvasLoading && !layout ? (
              <CanvasRenderer layout={skeletonLayout} />
            ) : layout?.blocks?.length > 0 ? (
              <CanvasRenderer layout={layout} />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}


// ── Sub-components ───────────────────────────────────────────────────────────

function EmptyState({ onBackfill, backfillStatus }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 flex items-center justify-center mb-6">
        <BarChart3 className="w-10 h-10 text-blue-500/60" />
      </div>
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2">
        Your AI-powered dashboard is ready
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mb-8 leading-relaxed">
        Run analyses in the Workspace and they will automatically appear here.
        The AI agent will compose an optimal dashboard layout from your data.
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={onBackfill}
          disabled={backfillStatus === 'running'}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          {backfillStatus === 'running' ? 'Importing...' : 'Import past analyses'}
        </button>
        <a
          href="/workspace"
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 transition-colors shadow-sm"
        >
          Go to Workspace
          <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}
