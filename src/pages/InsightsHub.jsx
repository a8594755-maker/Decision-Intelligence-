/**
 * InsightsHub.jsx — Decision Assets + AI Insights Dashboard
 *
 * Two tabs:
 * 1. Analysis Timeline — reusable decision assets from Workspace analyses
 * 2. Insights — AI agent queries raw data, builds dashboard, suggests deeper analyses
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { fetchSnapshots, togglePin, archiveSnapshot } from '../services/data-prep/analysisSnapshotService';
import { generateDashboardSummary } from '../services/agent-core/dashboardSummaryAgent';
import {
  buildSnapshotFingerprint,
  getCachedSummary,
  setCachedSummary,
  clearCachedSummary,
  getDashboardHistory,
} from '../services/agent-core/dashboardSummaryCache';
import { generateCanvasLayout } from '../services/canvas/canvasAgentService';
import { executeInsightQuery } from '../services/canvas/insightsHubExecutor';
import {
  BarChart3, ArrowRight, RefreshCw, Play, Layers, Square, Activity,
} from 'lucide-react';

import AssetCenterHeader from '../components/insights/AssetCenterHeader';
import SnapshotTimeline from '../components/insights/SnapshotTimeline';
import InsightsDashboard from '../components/insights/InsightsDashboard';
import CanvasRenderer from '../components/insights/CanvasRenderer';
import SuggestionBlock from '../components/insights/blocks/SuggestionBlock';
import AgentThinkingBar from '../components/insights/AgentThinkingBar';
import HealthCheckBar from '../components/insights/HealthCheckBar';
import { getOlistDemoLayout } from '../services/canvas/insightsHubDemoData';
import { buildDataCard, convertChartData, buildBlockLayout } from '../services/canvas/insightsHubAgent';

const PAGE_SIZE = 30;
const SUMMARY_CACHE_KEY = 'di_insights_summary';

const TABS = [
  { id: 'timeline', label: 'Analysis Timeline', icon: Layers },
  { id: 'insights', label: 'Insights', icon: Activity },
];

export default function InsightsHub() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id;

  // Tab
  const [activeTab, setActiveTab] = useState('insights');

  // ── Timeline tab state ──
  const [snapshots, setSnapshots] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState(null);
  const [pinnedSnapshots, setPinnedSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [filters, setFilters] = useState({
    search: undefined,
    tags: undefined,
    since: undefined,
    until: undefined,
    pinnedOnly: false,
  });
  const [offset, setOffset] = useState(0);
  const mountedRef = useRef(true);

  // ── Insights tab state ──
  const [dashResult, setDashResult] = useState(null);
  const [thinking, setThinking] = useState('');
  const [agentProgress, setAgentProgress] = useState('');
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasSource, setCanvasSource] = useState('');
  const [runningQuery, setRunningQuery] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [agentError, setAgentError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [demoLayout, setDemoLayout] = useState(null);
  const canvasAbortRef = useRef(null);
  const hasGenerated = useRef(false);

  // Insights computed
  const activeDash = historyIndex >= 0 ? history[historyIndex] : dashResult;
  const hasHtml = !!activeDash?.html;
  const hasDataCards = activeDash?.dataCards?.length > 0;
  const suggestions = activeDash?.suggestions || [];
  const hasSuggestions = suggestions.length > 0;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // ══════════════════════════════════════════════════════════════════════════
  // Timeline tab logic
  // ══════════════════════════════════════════════════════════════════════════

  const loadSnapshots = useCallback(async (currentOffset = 0, append = false) => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, count } = await fetchSnapshots(userId, {
        limit: PAGE_SIZE,
        offset: currentOffset,
        pinnedOnly: filters.pinnedOnly,
        tags: filters.tags,
        search: filters.search,
        since: filters.since,
        until: filters.until,
      });
      if (!mountedRef.current) return;
      setSnapshots(prev => append ? [...prev, ...(data || [])] : (data || []));
      setTotalCount(count || 0);
    } catch (err) {
      if (mountedRef.current) setError(err.message || 'Failed to load analyses');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [userId, filters]);

  const loadPinned = useCallback(async () => {
    if (!userId) return;
    try {
      const { data } = await fetchSnapshots(userId, { limit: 6, pinnedOnly: true });
      if (mountedRef.current) setPinnedSnapshots(data || []);
    } catch { /* non-critical */ }
  }, [userId]);

  const buildSummary = useCallback(async (snaps) => {
    if (!snaps?.length) { setSummary(null); return; }
    setSummaryLoading(true);
    try {
      const fp = buildSnapshotFingerprint(snaps);
      const cached = getCachedSummary(SUMMARY_CACHE_KEY, fp);
      if (cached) { if (mountedRef.current) setSummary(cached); return; }
      const result = await generateDashboardSummary(snaps);
      if (!mountedRef.current) return;
      setSummary(result);
      setCachedSummary(SUMMARY_CACHE_KEY, fp, result);
    } catch (err) {
      console.warn('[InsightsHub] Summary generation failed:', err);
    } finally {
      if (mountedRef.current) setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    setOffset(0);
    loadSnapshots(0);
    loadPinned();
  }, [userId, filters, loadSnapshots, loadPinned]);

  useEffect(() => {
    if (snapshots.length > 0 && offset === 0) buildSummary(snapshots);
  }, [snapshots, offset, buildSummary]);

  const handleTogglePin = useCallback(async (snapshotId, pinned) => {
    const ok = await togglePin(snapshotId, pinned);
    if (ok) {
      setSnapshots(prev => prev.map(s => s.id === snapshotId ? { ...s, pinned } : s));
      loadPinned();
    }
  }, [loadPinned]);

  const handleArchive = useCallback(async (snapshotId) => {
    const ok = await archiveSnapshot(snapshotId);
    if (ok) {
      setSnapshots(prev => prev.filter(s => s.id !== snapshotId));
      setTotalCount(prev => prev - 1);
      setPinnedSnapshots(prev => prev.filter(s => s.id !== snapshotId));
    }
  }, []);

  const handleRefresh = useCallback(async (snapshot) => {
    if (!snapshot.query_text || !userId || refreshingId) return;
    setRefreshingId(snapshot.id);
    try {
      await executeInsightQuery(snapshot.query_text, userId);
      clearCachedSummary(SUMMARY_CACHE_KEY);
      setOffset(0);
      await loadSnapshots(0);
      loadPinned();
    } catch (err) {
      console.warn('[InsightsHub] Refresh failed:', err);
    } finally {
      if (mountedRef.current) setRefreshingId(null);
    }
  }, [userId, refreshingId, loadSnapshots, loadPinned]);

  const handleLoadMore = useCallback(() => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    loadSnapshots(newOffset, true);
  }, [offset, loadSnapshots]);

  const handleCompare = useCallback((snapshot) => {
    navigate('/insights', { state: { compareQuery: snapshot.query_text } });
  }, [navigate]);

  // ══════════════════════════════════════════════════════════════════════════
  // Insights tab logic (from 83e1277)
  // ══════════════════════════════════════════════════════════════════════════

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
      if (result?.dataCards?.length && !result?.blockLayout) {
        result.blockLayout = buildBlockLayout(result.dataCards, result.layout || { narrative: '', sections: [] });
      }
      setDashResult(result);
      setThinking(result?.thinking || '');
      setCanvasSource(source);
      setHistoryIndex(-1);
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

  useEffect(() => {
    getDashboardHistory().then(h => setHistory(h));
  }, []);

  // Auto-generate when switching to insights tab for the first time
  useEffect(() => {
    if (activeTab === 'insights' && userId && !hasGenerated.current) {
      hasGenerated.current = true;
      generateCanvas();
    }
  }, [activeTab, userId, generateCanvas]);

  const handleStop = useCallback(() => {
    if (canvasAbortRef.current) canvasAbortRef.current.abort();
    canvasAbortRef.current = null;
    setCanvasLoading(false);
    setBatchRunning(false);
    setRunningQuery(null);
    setAgentProgress('');
  }, []);

  const handleRegenerate = () => {
    setHistoryIndex(-1);
    generateCanvas(true);
  };

  const viewHistoryVersion = (index) => {
    if (index < 0 || index >= history.length) return;
    setHistoryIndex(index);
  };

  const backToCurrent = () => setHistoryIndex(-1);

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

  const handleRegenerateCard = useCallback(async (cardId) => {
    if (!dashResult?.dataCards || !userId) return;
    const card = dashResult.dataCards.find(c => c.id === cardId);
    if (!card) return;

    setAgentProgress(`Regenerating: ${card.title}...`);
    try {
      const { getResolvedInsightsHubModel } = await import('../services/ai-infra/modelConfigService.js');
      const { buildEnrichedSchemaPrompt } = await import('../services/sap-erp/sapDataQueryService.js');
      const { provider, model } = getResolvedInsightsHubModel();
      const schemaHint = buildEnrichedSchemaPrompt();

      const spec = { id: card.id, title: card.title, type: card.type, queries: card.rawQueries ? Object.keys(card.rawQueries).map(k => k) : [], instructions: '' };
      const newCard = await buildDataCard(spec, { provider, model, schemaHint });

      if (newCard?.metrics?.length) {
        const updatedCards = dashResult.dataCards.map(c => c.id === cardId ? newCard : c);
        const newBlockLayout = buildBlockLayout(updatedCards, dashResult.layout);
        setDashResult(prev => ({ ...prev, dataCards: updatedCards, blockLayout: newBlockLayout }));
      }
    } catch (err) {
      console.warn('[InsightsHub] Card regeneration failed:', err);
    } finally {
      setAgentProgress('');
    }
  }, [dashResult, userId]);

  const handleAction = useCallback((action) => {
    if (action?.type === 'run_suggestion' && action.query) {
      handleRunSuggestion(action.query);
    } else if (action?.type === 'regenerate_card' && action.cardId) {
      handleRegenerateCard(action.cardId);
    } else if (action?.type === 'explore_insight' && action.context) {
      const ctx = action.context;
      const query = ctx.finding
        ? `Analyze this finding in more detail: "${ctx.finding}". What are the root causes? What actions should we take?`
        : `Tell me more about "${ctx.title}". What patterns do you see? What should we investigate further?`;
      navigate('/workspace', { state: { insightQuery: query } });
    }
  }, [handleRunSuggestion, handleRegenerateCard, navigate]);

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
  // Render
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-[var(--surface-base)]">
      {/* Header bar */}
      <div className="border-b border-[var(--border-default)] bg-[var(--surface-card)]">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500 to-teal-600 flex items-center justify-center shadow-sm">
                <BarChart3 className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-[var(--text-primary)]">Insights Hub</h1>
                <p className="text-xs text-[var(--text-muted)]">
                  Decision assets and AI-driven data analysis
                </p>
              </div>
            </div>

            {/* Insights tab header actions */}
            {activeTab === 'insights' && (
              <div className="flex items-center gap-2">
                {canvasSource && !canvasLoading && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)]">
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
                {history.length > 0 && !canvasLoading && (
                  <select
                    value={historyIndex}
                    onChange={(e) => {
                      const idx = Number(e.target.value);
                      if (idx < 0) backToCurrent();
                      else viewHistoryVersion(idx);
                    }}
                    className="text-[11px] px-2 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] text-[var(--text-secondary)]"
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
                      ? 'bg-[var(--accent-active)] text-[var(--brand-600)]'
                      : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--accent-hover)]'
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
            )}
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mt-4 -mb-4">
            {TABS.map(tab => {
              const isActive = activeTab === tab.id;
              const TabIcon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    isActive
                      ? 'border-[var(--brand-600)] text-[var(--brand-600)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-default)]'
                  }`}
                >
                  <TabIcon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className={`${activeTab === 'insights' ? 'max-w-[1400px]' : 'max-w-[1200px]'} mx-auto px-4 sm:px-6 py-6 space-y-6`}>
        {/* Error state (timeline tab) */}
        {activeTab === 'timeline' && error && (
          <div className="p-4 rounded-xl bg-[var(--status-danger-bg)] text-[var(--status-danger)] text-sm">
            {error}
          </div>
        )}

        {/* ═══ Tab: Analysis Timeline ═══ */}
        {activeTab === 'timeline' && !error && (
          <>
            <AssetCenterHeader
              summary={summary}
              pinnedSnapshots={pinnedSnapshots}
              onTogglePin={handleTogglePin}
              onArchive={handleArchive}
              onRefresh={handleRefresh}
            />
            <SnapshotTimeline
              snapshots={snapshots}
              totalCount={totalCount}
              filters={filters}
              onFiltersChange={setFilters}
              onTogglePin={handleTogglePin}
              onArchive={handleArchive}
              onRefresh={handleRefresh}
              refreshingId={refreshingId}
              onLoadMore={handleLoadMore}
              loading={loading}
              onCompare={handleCompare}
            />
            {!loading && totalCount === 0 && !filters.search && !filters.tags?.length && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-20 h-20 rounded-2xl bg-[var(--brand-50)] flex items-center justify-center mb-6">
                  <BarChart3 className="w-10 h-10 text-[var(--brand-600)]" />
                </div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">No analysis assets yet</h2>
                <p className="text-sm text-[var(--text-muted)] max-w-md mb-8">
                  Run analyses in the Workspace — they will automatically appear here as reusable decision assets.
                </p>
                <a
                  href="/workspace"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-[var(--brand-600)] hover:bg-[var(--brand-700)] text-white transition-colors shadow-sm"
                >
                  Go to Workspace <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            )}
          </>
        )}

        {/* ═══ Tab: Insights (AI Data Analyst Dashboard) ═══ */}
        {activeTab === 'insights' && (
          <>
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

            {/* Health check bar — diagnostics from compute layer */}
            {!demoLayout && activeDash?.healthCheck?.diagnostics?.length > 0 && (
              <HealthCheckBar healthCheck={activeDash.healthCheck} />
            )}

            {/* Demo mode */}
            {demoLayout && (
              <CanvasRenderer layout={demoLayout} onAction={handleAction} runningQuery={runningQuery} />
            )}

            {/* Loading */}
            {!demoLayout && canvasLoading && !hasHtml && !hasDataCards && (
              <div className="flex items-center justify-center py-24">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin mx-auto mb-4" />
                  <p className="text-sm text-[var(--text-muted)]">{agentProgress || 'Agent is analyzing your data...'}</p>
                </div>
              </div>
            )}

            {/* Viewing history indicator */}
            {!demoLayout && historyIndex >= 0 && (
              <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent-active)] border border-[var(--brand-500)]">
                <span className="text-xs text-[var(--brand-600)]">
                  Viewing version {historyIndex + 1} of {history.length} · {new Date(history[historyIndex]?.timestamp).toLocaleString()}
                </span>
                <button onClick={backToCurrent} className="text-xs font-medium text-[var(--brand-600)] hover:text-[var(--brand-600)] ml-auto">
                  ← Back to current
                </button>
              </div>
            )}

            {/* React-rendered dashboard — prefer CanvasRenderer, fallback to InsightsDashboard */}
            {!demoLayout && activeDash?.blockLayout?.blocks?.length > 0 && (
              <CanvasRenderer layout={activeDash.blockLayout} onAction={handleAction} runningQuery={runningQuery} />
            )}
            {!demoLayout && !activeDash?.blockLayout?.blocks?.length && hasDataCards && (
              <InsightsDashboard dataCards={activeDash.dataCards} layout={activeDash.layout} />
            )}

            {/* Legacy HTML fallback */}
            {!demoLayout && !hasDataCards && hasHtml && (
              <iframe
                srcDoc={activeDash.html}
                sandbox="allow-scripts"
                className="w-full border-0 rounded-xl overflow-hidden bg-white"
                style={{ minHeight: '600px' }}
                title="Insights Dashboard"
              />
            )}

            {/* Suggestions */}
            {!demoLayout && hasSuggestions && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
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
              <InsightsErrorState message={agentError} onRetry={handleRegenerate} />
            )}

            {/* Empty — never generated */}
            {!demoLayout && !canvasLoading && !hasHtml && !hasDataCards && !agentError && !hasGenerated.current && (
              <InsightsEmptyState />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function InsightsErrorState({ message, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center mb-6">
        <BarChart3 className="w-10 h-10 text-red-500/60" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Agent encountered an issue</h2>
      <p className="text-sm text-[var(--text-muted)] max-w-md mb-8">{message}</p>
      <button onClick={onRetry} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm">
        <RefreshCw className="w-4 h-4" /> Try Again
      </button>
    </div>
  );
}

function InsightsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-teal-500/20 to-teal-600/20 flex items-center justify-center mb-6">
        <BarChart3 className="w-10 h-10 text-blue-500/60" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">No data available</h2>
      <p className="text-sm text-[var(--text-muted)] max-w-md mb-8">Upload a dataset in the Workspace first. The AI analyst will automatically explore your data and build a dashboard.</p>
      <a href="/workspace" className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm">
        Go to Workspace <ArrowRight className="w-4 h-4" />
      </a>
    </div>
  );
}
