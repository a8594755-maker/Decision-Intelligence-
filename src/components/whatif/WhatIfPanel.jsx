/**
 * WhatIfPanel — What-If Analysis / Trade-off Explorer v1
 *
 * Features:
 * - Automatic baseline plan resolution (fallback chain: prop → localStorage → DB)
 * - Auto-baseline creation with fallback to Risk What-If mode
 * - Stale baseline detection with actionable warning
 * - Recent plans selector for quick baseline switching
 * - Parameter sliders/toggles for all supported overrides
 * - Run Scenario button → async job with polling
 * - Scenario list (recent, per base run)
 * - Compare view showing KPI delta + top SKU changes
 *
 * Usage:
 *   <WhatIfPanel
 *     userId={userId}
 *     baseRunId={latestPlanRunId}
 *     datasetProfileId={activeDatasetContext?.dataset_profile_id}
 *     datasetProfileRow={profileRowObject}
 *   />
 *
 * The panel is self-contained; it manages its own scenario state.
 * Identical scenarios (same overrides) return cached results immediately.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, RefreshCw, ChevronLeft, CheckCircle2, AlertTriangle, Loader2, Clock, X } from 'lucide-react';
import ScenarioOverridesForm, { getDefaultOverrides } from './ScenarioOverridesForm';
import ScenarioComparisonView from './ScenarioComparisonView';
import BasePlanEmptyState from './BasePlanEmptyState';
import StaleBaselineWarning from './StaleBaselineWarning';
import RiskWhatIfView from './RiskWhatIfView';
import { createScenario, listScenariosForBaseRun, getScenario } from '../../services/diScenariosService';
import { diRunsService } from '../../services/diRunsService';
import { loadArtifact } from '../../utils/artifactStore';
import { useBasePlanResolver } from '../../hooks/useBasePlanResolver';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;

async function loadScenarioEngine() {
  return import('../../services/scenarioEngine');
}

function StatusChip({ status }) {
  const configs = {
    draft: { icon: Clock, color: 'text-slate-400', label: 'Draft' },
    queued: { icon: Clock, color: 'text-amber-500', label: 'Queued' },
    running: { icon: Loader2, color: 'text-blue-500', label: 'Running', spin: true },
    succeeded: { icon: CheckCircle2, color: 'text-emerald-500', label: 'Done' },
    failed: { icon: AlertTriangle, color: 'text-red-500', label: 'Failed' }
  };
  const cfg = configs[status] || configs.draft;
  const Icon = cfg.icon;

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${cfg.color}`}>
      <Icon className={`w-3 h-3 ${cfg.spin ? 'animate-spin' : ''}`} />
      {cfg.label}
    </span>
  );
}

function ScenarioRow({ scenario, isSelected, onSelect, onCompare }) {
  const overrideCount = Object.values(scenario.overrides || {}).filter(
    (v) => v !== null && v !== undefined
  ).length;

  return (
    <div
      className={`flex items-center justify-between p-2 rounded-lg cursor-pointer border transition-colors ${
        isSelected
          ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
          : 'bg-white dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
      }`}
      onClick={() => onSelect(scenario)}
    >
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">
          {scenario.name || `Scenario #${scenario.id?.slice(0, 8) || '?'}`}
        </p>
        <p className="text-xs text-slate-400">
          {overrideCount} override{overrideCount !== 1 ? 's' : ''} · {new Date(scenario.created_at).toLocaleTimeString()}
        </p>
      </div>
      <div className="flex items-center gap-2 ml-2 flex-shrink-0">
        <StatusChip status={scenario.status} />
        {scenario.status === 'succeeded' && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCompare(scenario); }}
            className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Compare
          </button>
        )}
      </div>
    </div>
  );
}

export default function WhatIfPanel({
  userId,
  baseRunId,          // from current session plan run (highest-priority hint)
  datasetProfileId,   // for DB resolver queries
  datasetProfileRow   // full profile row for auto-baseline
}) {
  // ── Baseline plan resolver ─────────────────────────────────────────────
  const {
    mode,
    resolvedRunId,
    _basePlan,
    staleness,
    recentPlans,
    error: resolverError,
    autoProgress,
    runAutoBaseline,
    selectRecentPlan,
    useBaselineAnyway,
    switchToRiskMode,
    switchToPlanMode
  } = useBasePlanResolver({
    userId,
    datasetProfileId,
    datasetProfileRow,
    routeRunId: baseRunId
  });

  // Use resolved run id for all scenario logic
  const activeBaseRunId = resolvedRunId;

  const [overrides, setOverrides] = useState(getDefaultOverrides());
  const [scenarioName, setScenarioName] = useState('');
  const [scenarios, setScenarios] = useState([]);
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [comparisonData, setComparisonData] = useState(null);
  const [view, setView] = useState('form'); // 'form' | 'compare'
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);
  const [isLoadingScenarios, setIsLoadingScenarios] = useState(false);
  const [isStaleRerunning, setIsStaleRerunning] = useState(false);
  const pollRef = useRef(null);
  const pollCountRef = useRef(0);

  // ── Load existing scenarios for this base run ──────────────────────────
  const loadScenarios = useCallback(async () => {
    if (!userId || !activeBaseRunId) return;
    setIsLoadingScenarios(true);
    try {
      const list = await listScenariosForBaseRun(userId, activeBaseRunId, 15);
      setScenarios((list || []).filter(Boolean));
    } catch (err) {
      console.warn('[WhatIfPanel] loadScenarios failed:', err.message);
    } finally {
      setIsLoadingScenarios(false);
    }
  }, [userId, activeBaseRunId]);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  // ── Polling for in-flight scenario status ──────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  const startPolling = useCallback((scenarioId) => {
    stopPolling();
    pollCountRef.current = 0;

    pollRef.current = setInterval(async () => {
      pollCountRef.current += 1;
      if (pollCountRef.current > MAX_POLL_ATTEMPTS) {
        stopPolling();
        setRunError('Scenario timed out. Please try again.');
        setIsRunning(false);
        return;
      }

      try {
        const latest = await getScenario(userId, scenarioId);
        if (!latest) return;

        setScenarios((prev) =>
          prev.map((s) => (s.id === scenarioId ? latest : s))
        );

        if (latest.status === 'succeeded' || latest.status === 'failed') {
          stopPolling();
          setIsRunning(false);
          setProgress(null);

          if (latest.status === 'failed') {
            setRunError(latest.error_message || 'Scenario failed.');
          } else {
            setSelectedScenario(latest);
            await loadComparison(latest);
          }
        }
      } catch (err) {
        console.warn('[WhatIfPanel] polling error:', err.message);
      }
    }, POLL_INTERVAL_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Load comparison artifact for a succeeded scenario ─────────────────
  const loadComparison = useCallback(async (scenario) => {
    if (!scenario?.scenario_run_id) return;
    setIsLoadingComparison(true);
    setComparisonData(null);
    try {
      const artifacts = await diRunsService.getArtifactsForRun(Number(scenario.scenario_run_id));
      const compRecord = artifacts.find((a) => a.artifact_type === 'scenario_comparison');
      if (compRecord) {
        const payload = await loadArtifact({ artifact_id: compRecord.id, ...(compRecord.artifact_json || {}) });
        setComparisonData(payload);
        setView('compare');
      }
    } catch (err) {
      console.warn('[WhatIfPanel] loadComparison failed:', err.message);
    } finally {
      setIsLoadingComparison(false);
    }
  }, []);

  // ── Run Scenario ──────────────────────────────────────────────────────
  const handleRunScenario = useCallback(async () => {
    if (!userId || !activeBaseRunId) return;
    setRunError(null);
    setIsRunning(true);
    setProgress('Creating scenario…');

    try {
      // POST /scenarios equivalent
      const { scenario, isNew, cached } = await createScenario({
        user_id: userId,
        base_run_id: activeBaseRunId,
        name: scenarioName || null,
        overrides,
        engine_flags: {}
      });

      // Refresh list
      setScenarios((prev) => {
        const exists = prev.find((s) => s.id === scenario.id);
        return exists ? prev.map((s) => (s.id === scenario.id ? scenario : s)) : [scenario, ...prev];
      });

      if (cached && scenario.status === 'succeeded') {
        // Cache hit: load comparison immediately
        setIsRunning(false);
        setProgress(null);
        setSelectedScenario(scenario);
        await loadComparison(scenario);
        return;
      }

      if (!isNew && (scenario.status === 'running' || scenario.status === 'queued')) {
        // Already in-flight: just poll
        setProgress('Waiting for in-flight scenario…');
        startPolling(scenario.id);
        return;
      }

      // Execute scenario asynchronously (in-browser job)
      setProgress('Running optimizer…');

      // Update scenario to 'running' status locally while executing
      setScenarios((prev) =>
        prev.map((s) => (s.id === scenario.id ? { ...s, status: 'running' } : s))
      );

      // Run in the background — errors are caught and reflected in scenario status
      const { runScenario } = await loadScenarioEngine();
      runScenario(userId, scenario, ({ _step, message }) => {
        setProgress(message);
      })
        .then((updatedScenario) => {
          setScenarios((prev) =>
            prev.map((s) => (s.id === updatedScenario.id ? updatedScenario : s))
          );
          setIsRunning(false);
          setProgress(null);
          setSelectedScenario(updatedScenario);
          loadComparison(updatedScenario);
        })
        .catch((err) => {
          setRunError(err.message || 'Scenario execution failed.');
          setIsRunning(false);
          setProgress(null);
          // Reload scenarios to get updated status from DB
          loadScenarios();
        });

    } catch (err) {
      setRunError(err.message || 'Failed to create scenario.');
      setIsRunning(false);
      setProgress(null);
    }
  }, [userId, activeBaseRunId, overrides, scenarioName, loadComparison, startPolling, loadScenarios]);

  const handleCompare = useCallback(async (scenario) => {
    setSelectedScenario(scenario);
    await loadComparison(scenario);
  }, [loadComparison]);

  const handleBackToForm = () => {
    setView('form');
    setSelectedScenario(null);
    setComparisonData(null);
  };

  const activeOverrideCount = Object.values(overrides).filter(
    (v) => v !== null && v !== undefined
  ).length;

  // ── Stale rerun handler ────────────────────────────────────────────────
  const handleStaleRerun = useCallback(async () => {
    setIsStaleRerunning(true);
    await runAutoBaseline();
    setIsStaleRerunning(false);
  }, [runAutoBaseline]);

  // ── Mode-based early returns ────────────────────────────────────────────

  if (mode === 'resolving') {
    return (
      <div className="flex items-center justify-center py-12 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-xs">Resolving baseline plan…</span>
      </div>
    );
  }

  if (mode === 'auto_running') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        <p className="text-xs text-blue-600 dark:text-blue-400">
          {autoProgress || 'Generating baseline plan…'}
        </p>
      </div>
    );
  }

  if (mode === 'no_plan') {
    return (
      <BasePlanEmptyState
        onRunBaseline={runAutoBaseline}
        onSelectRecent={selectRecentPlan}
        onSwitchToRisk={switchToRiskMode}
        recentPlans={recentPlans}
        isRunning={false}
        progress={autoProgress}
        error={resolverError}
        hasProfileRow={Boolean(datasetProfileRow?.id)}
      />
    );
  }

  if (mode === 'risk') {
    return (
      <RiskWhatIfView
        datasetProfileRow={datasetProfileRow}
        onPlanGenerated={(run) => selectRecentPlan(run)}
        onSwitchToPlanMode={switchToPlanMode}
      />
    );
  }

  // modes: 'plan' | 'stale' → render the full What-If explorer below

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Stale baseline warning */}
      {mode === 'stale' && staleness && (
        <StaleBaselineWarning
          reason={staleness.reason}
          onRerun={handleStaleRerun}
          onUseAnyway={useBaselineAnyway}
          onSwitchToRisk={switchToRiskMode}
          isRerunning={isStaleRerunning}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          {view === 'compare' && (
            <button
              type="button"
              onClick={handleBackToForm}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {view === 'compare' ? 'Scenario Comparison' : 'What-If Explorer'}
            </h3>
            <p className="text-xs text-slate-400">
              Base run #{activeBaseRunId}
              {mode === 'stale' && (
                <span className="ml-1 text-amber-500">(stale)</span>
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadScenarios}
          disabled={isLoadingScenarios}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          title="Refresh scenarios"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingScenarios ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {view === 'compare' ? (
          <>
            {isLoadingComparison ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              </div>
            ) : (
              <ScenarioComparisonView
                comparison={comparisonData}
                scenarioName={selectedScenario?.name}
              />
            )}
          </>
        ) : (
          <div className="space-y-4">
            {/* Run form */}
            <div>
              {/* Scenario name */}
              <div className="mb-3">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  Scenario Name (optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. High service target, tight budget"
                  value={scenarioName}
                  onChange={(e) => setScenarioName(e.target.value)}
                  maxLength={80}
                  className="mt-1 w-full px-2 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Overrides form */}
              <ScenarioOverridesForm
                overrides={overrides}
                onChange={setOverrides}
                disabled={isRunning}
              />

              {/* Error */}
              {runError && (
                <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 mb-3">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-red-600 dark:text-red-400">{runError}</p>
                  <button type="button" onClick={() => setRunError(null)} className="ml-auto">
                    <X className="w-3 h-3 text-red-400" />
                  </button>
                </div>
              )}

              {/* Progress */}
              {progress && (
                <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 mb-3">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {progress}
                </div>
              )}

              {/* Run button */}
              <button
                type="button"
                onClick={handleRunScenario}
                disabled={isRunning || activeOverrideCount === 0}
                className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                  isRunning || activeOverrideCount === 0
                    ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {isRunning ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Running…</>
                ) : (
                  <><Play className="w-4 h-4" /> Run Scenario ({activeOverrideCount} override{activeOverrideCount !== 1 ? 's' : ''})</>
                )}
              </button>
              {activeOverrideCount === 0 && (
                <p className="text-xs text-slate-400 text-center mt-1">
                  Set at least one override to run a scenario.
                </p>
              )}
            </div>

            {/* Scenario list */}
            {scenarios.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    Recent Scenarios ({scenarios.length})
                  </h4>
                </div>
                <div className="space-y-1.5">
                  {scenarios.filter(Boolean).map((scenario) => (
                    <ScenarioRow
                      key={scenario.id}
                      scenario={scenario}
                      isSelected={selectedScenario?.id === scenario.id}
                      onSelect={setSelectedScenario}
                      onCompare={handleCompare}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
