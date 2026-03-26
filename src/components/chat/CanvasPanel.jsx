import React, { useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Download, Code2, BarChart3, Terminal, ChevronRight, X, ShieldAlert, Share2, FlaskConical, ExternalLink, PanelRightClose, TableProperties, Database } from 'lucide-react';
import { exportWorkbook } from '../../utils/exportWorkbook';
import { Card, Button, Badge } from '../ui';
import TopologyTab from './TopologyTab';
import DataTab from './DataTab';
import WhatIfPanel from '../whatif/WhatIfPanel';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { buildActualVsForecastSeries } from '../../utils/charts/buildActualVsForecastSeries';

const TAB_OPTIONS = [
  { id: 'logs', label: 'Log View', icon: Terminal },
  { id: 'code', label: 'Code View', icon: Code2 },
  { id: 'charts', label: 'Charts', icon: BarChart3 },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'topology', label: 'Topology', icon: Share2 },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'whatif', label: 'What-If', icon: FlaskConical }
];

const statusChip = (status) => {
  if (status === 'succeeded' || status === 'pass') return { label: status, type: 'success', icon: CheckCircle2 };
  if (status === 'running') return { label: 'running', type: 'info', icon: Loader2 };
  if (status === 'failed' || status === 'fail') return { label: status, type: 'warning', icon: AlertTriangle };
  if (status === 'skipped') return { label: 'skipped', type: 'info', icon: AlertTriangle };
  return { label: status || 'queued', type: 'info', icon: AlertTriangle };
};

const downloadFile = (download) => {
  if (!download) return;
  let payload;
  if (typeof download.content === 'string') {
    payload = download.content;
  } else if (
    download.content instanceof ArrayBuffer ||
    ArrayBuffer.isView(download.content)
  ) {
    // Binary content (e.g. xlsx Uint8Array) — pass directly to Blob
    payload = download.content;
  } else {
    payload = JSON.stringify(download.content ?? {}, null, 2);
  }
  const blob = new Blob([payload], { type: download.mimeType || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = download.fileName || download.label || 'artifact.json';
  link.click();
  URL.revokeObjectURL(url);
};

const chartTick = (value) => String(value || '').slice(-10);

// ── Risk Comparison Card ──────────────────────────────────────────────────────
function RiskComparisonCard({ comparison }) {
  if (!comparison || !comparison.kpis) return null;

  const { base, risk, delta } = comparison.kpis;
  const keyChanges = Array.isArray(comparison.key_changes) ? comparison.key_changes.slice(0, 3) : [];

  const fmtPct = (v) => (v !== null && v !== undefined && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
  const fmtNum = (v) => (v !== null && v !== undefined && Number.isFinite(v) ? v.toFixed(2) : '—');
  const fmtDelta = (v, invert = false) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const isPositive = invert ? v < 0 : v > 0;
    const sign = v > 0 ? '+' : '';
    return { label: `${sign}${v.toFixed(2)}`, good: isPositive };
  };

  const metrics = [
    {
      label: 'Service Level',
      base: fmtPct(base?.service_level),
      risk: fmtPct(risk?.service_level),
      delta: fmtDelta(delta?.service_level, false)
    },
    {
      label: 'Stockout Units',
      base: fmtNum(base?.stockout_units),
      risk: fmtNum(risk?.stockout_units),
      delta: fmtDelta(delta?.stockout_units, true)   // lower is better
    },
    {
      label: 'Holding Units',
      base: fmtNum(base?.holding_units),
      risk: fmtNum(risk?.holding_units),
      delta: fmtDelta(delta?.holding_units, true)    // lower is better
    }
  ];

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-900/10 p-4 space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">Risk-Aware Plan Comparison</p>
      </div>

      {/* KPI comparison table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[var(--text-muted)] border-b border-[var(--border-default)]">
              <th className="text-left pb-1 font-medium">Metric</th>
              <th className="text-right pb-1 font-medium">Base</th>
              <th className="text-right pb-1 font-medium">Risk-Aware</th>
              <th className="text-right pb-1 font-medium">Delta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {metrics.map((m) => (
              <tr key={m.label}>
                <td className="py-1.5 text-[var(--text-secondary)] font-medium">{m.label}</td>
                <td className="py-1.5 text-right text-[var(--text-secondary)]">{m.base}</td>
                <td className="py-1.5 text-right text-[var(--text-primary)] font-medium">{m.risk}</td>
                <td className="py-1.5 text-right">
                  {m.delta ? (
                    <span className={`font-medium ${m.delta.good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {m.delta.label}
                    </span>
                  ) : <span className="text-slate-400">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Top SKU changes */}
      {keyChanges.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wide">
            Top Changed SKUs
          </p>
          <div className="space-y-1.5">
            {keyChanges.map((change, idx) => (
              <div key={`${change.sku}-${idx}`} className="rounded-lg bg-[var(--surface-card)] border border-[var(--border-default)] px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[var(--text-primary)]">
                    {change.sku}{change.plant_id ? ` / ${change.plant_id}` : ''}
                  </span>
                  <span className={`text-[11px] font-semibold ${change.delta > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'}`}>
                    {change.delta > 0 ? '+' : ''}{change.delta?.toFixed(2)} units
                  </span>
                </div>
                {Array.isArray(change.reason_refs) && change.reason_refs.length > 0 && (
                  <p className="text-[10px] text-slate-500 mt-0.5 truncate">
                    {change.reason_refs[0]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CanvasPanel({
  onToggleOpen,
  activeTab,
  onTabChange,
  run,
  logs = [],
  stepStatuses = {},
  codeText = '',
  chartPayload = {},
  forecastSeriesGroups = [],
  downloads = [],
  topologyGraph = null,
  topologyRunId = null,
  onRunTopology = null,
  topologyRunning = false,
  // What-If Explorer props
  userId = null,
  latestPlanRunId = null,
  datasetProfileId = null,
  datasetProfileRow = null,
  // Popout/detach props
  onPopout = null,
  isDetached = false
}) {
  // Determine which step is currently active (running or next queued)
  const activeStep = (() => {
    const entries = Object.entries(stepStatuses);
    const running = entries.find(([, meta]) => meta?.status === 'running');
    if (running) return running[0];
    const queued = entries.find(([, meta]) => meta?.status === 'queued');
    return queued ? queued[0] : null;
  })();

  // Check if any step is currently running
  const hasRunningStep = Object.values(stepStatuses).some((meta) => meta?.status === 'running');

  // Series selector: use series_groups if available (50 SKUs), else fall back to flat rows
  const [selectedSeriesKey, setSelectedSeriesKey] = useState(null);

  // Legend click-to-toggle: tracks which dataKeys are hidden
  const [hiddenSeries, setHiddenSeries] = useState({});
  const handleLegendClick = useCallback((entry) => {
    const key = entry?.dataKey;
    if (!key) return;
    setHiddenSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const legendFormatter = useCallback(
    (value, entry) => (
      <span style={{ opacity: hiddenSeries[entry?.dataKey] ? 0.35 : 1, cursor: 'pointer', userSelect: 'none' }}>
        {value}
      </span>
    ),
    [hiddenSeries]
  );

  // Inventory Projection legend toggle
  const [hiddenInvSeries, setHiddenInvSeries] = useState({});
  const handleInvLegendClick = useCallback((entry) => {
    const key = entry?.dataKey;
    if (!key) return;
    setHiddenInvSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const invLegendFormatter = useCallback(
    (value, entry) => (
      <span style={{ opacity: hiddenInvSeries[entry?.dataKey] ? 0.35 : 1, cursor: 'pointer', userSelect: 'none' }}>
        {value}
      </span>
    ),
    [hiddenInvSeries]
  );

  // Export workbook state
  const [isExporting, setIsExporting] = useState(false);
  const [isAIExporting, setIsAIExporting] = useState(false);
  const [workbookArtifact, setWorkbookArtifact] = useState(null);
  const [exportStatus, setExportStatus] = useState(null); // { type: 'success'|'error'|'info', message: string }

  const handleExportWorkbook = useCallback(async () => {
    setIsExporting(true);
    setExportStatus(null);
    try {
      const bytes = exportWorkbook({
        chartPayload,
        downloads,
        runMeta: {
          run_id: run?.id,
          status: run?.status,
          workflow: run?.workflow
        }
      });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const artifact = {
        label: 'Export Workbook',
        fileName: `SmartOps_Export_${ts}.xlsx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: bytes
      };
      setWorkbookArtifact(artifact);
      downloadFile(artifact);
      setExportStatus({ type: 'success', message: 'Quick Export downloaded.' });
    } catch (err) {
      console.error('[CanvasPanel] exportWorkbook failed:', err);
      setExportStatus({ type: 'error', message: `Quick Export failed: ${err.message}` });
    } finally {
      setIsExporting(false);
    }
  }, [chartPayload, downloads, run]);

  const handleAIExportWorkbook = useCallback(async () => {
    setExportStatus(null);
    if (!run?.id) {
      setExportStatus({ type: 'error', message: 'No run_id available. Run a planning workflow first.' });
      return;
    }

    // Guard: warn if run is still in progress — artifacts may be incomplete
    const runStatus = (run.status || '').toLowerCase();
    if (['running', 'in_progress', 'pending'].includes(runStatus)) {
      setExportStatus({
        type: 'error',
        message: `Run ${run.id} is still "${run.status}". Please wait for it to complete before exporting.`
      });
      return;
    }

    setIsAIExporting(true);
    setExportStatus({ type: 'info', message: 'Connecting to ML API...' });
    try {
      // Determine currently selected focus series
      const focusGroups = (
        (Array.isArray(forecastSeriesGroups) && forecastSeriesGroups.length > 0 ? forecastSeriesGroups : null) ||
        (Array.isArray(chartPayload?.series_groups) && chartPayload.series_groups.length > 0 ? chartPayload.series_groups : null) ||
        []
      );
      const activeKey = selectedSeriesKey || focusGroups[0]?.key || null;
      const activeGroup = focusGroups.find(g => g.key === activeKey) || focusGroups[0] || null;

      // Primary: run_id (backend loads from DB). Fallback: inline data.
      // Serialise downloads but skip binary blobs (xlsx bytes etc.)
      const safeDownloads = (downloads || [])
        .filter(d => typeof d.content === 'string' || (typeof d.content === 'object' && !ArrayBuffer.isView(d.content) && !(d.content instanceof ArrayBuffer)))
        .map(d => ({
          label: d.label || d.fileName || '',
          fileName: d.fileName || d.label || '',
          content: typeof d.content === 'string' ? d.content : JSON.stringify(d.content),
          mimeType: d.mimeType || 'application/json',
        }));

      const payload = {
        version: 'v1',
        run_id: run.id,
        ai_insights: true,
        focus: activeGroup ? {
          series_key: activeGroup.key || null,
          sku: activeGroup.material_code || null,
          plant: activeGroup.plant_id || null,
          mode: 'selected',
        } : null,
        // Fallback data (used only when DB is unreachable)
        run_meta: { run_id: run.id, status: run.status, workflow: run.workflow },
        chart_payload: chartPayload || {},
        downloads: safeDownloads,
      };

      const baseUrl = import.meta.env.VITE_ML_API_URL || 'http://127.0.0.1:8000';

      setExportStatus({ type: 'info', message: 'Generating AI insights & building workbook...' });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      try {
        const response = await fetch(`${baseUrl}/export-workbook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Export failed: ${response.status} ${response.statusText}`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        link.href = url;
        link.download = `SmartOps_AI_Export_${run.id}_${ts}.xlsx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setExportStatus({ type: 'success', message: 'AI Export downloaded successfully!' });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        throw fetchErr;
      }
    } catch (err) {
      console.error('[CanvasPanel] AI export failed:', err);
      const isMlDown = err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.name === 'AbortError';
      const hint = isMlDown
        ? 'ML API unreachable — start it with: python run_ml_api.py'
        : `AI Export failed: ${err.message}`;
      setExportStatus({ type: 'error', message: hint });
    } finally {
      setIsAIExporting(false);
    }
  }, [run, selectedSeriesKey, forecastSeriesGroups, chartPayload, downloads]);
  // Priority: direct prop from parent (most reliable) > chartPayload store > empty
  const seriesGroups = (
    (Array.isArray(forecastSeriesGroups) && forecastSeriesGroups.length > 0 ? forecastSeriesGroups : null) ||
    (Array.isArray(chartPayload.series_groups) && chartPayload.series_groups.length > 0 ? chartPayload.series_groups : null) ||
    []
  );
  const effectiveGroupKey = selectedSeriesKey || seriesGroups[0]?.key || null;

  const actualVsForecast = seriesGroups.length > 0
    ? buildActualVsForecastSeries({ groups: seriesGroups }, { groupKey: effectiveGroupKey })
    : buildActualVsForecastSeries({ rows: chartPayload.actual_vs_forecast || [] });
  const actualVsForecastRows = actualVsForecast.rows;
  const showActual = actualVsForecast.series.some((series) => series.key === 'actual');
  const showP50 = actualVsForecast.series.some((series) => series.key === 'p50');
  const showP90 = actualVsForecast.series.some((series) => series.key === 'p90');
  const showLower = actualVsForecast.series.some((series) => series.key === 'lower');
  const showUpper = actualVsForecast.series.some((series) => series.key === 'upper');
  const hasRenderableActualVsForecastSeries = showActual || showP50 || showP90 || showLower || showUpper;

  return (
    <div className="w-full h-full flex flex-col bg-[var(--surface-card)] border-l border-[var(--border-default)]/60 overflow-hidden">
      {/* Header */}
      <div className="border-b border-[var(--border-default)]/60 px-4 py-3 bg-[var(--surface-base)] flex items-center justify-between flex-shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Canvas</h3>
          <p className="text-xs text-slate-500 truncate">
            {run?.status === 'running' ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
                </span>
                Execution running...
              </span>
            ) : run?.status === 'succeeded' ? (
              <span className="text-emerald-600 dark:text-emerald-400">Execution completed</span>
            ) : run?.status === 'failed' ? (
              <span className="text-red-600 dark:text-red-400">Execution failed</span>
            ) : (
              'Ready'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {run?.status && (
            <Badge
              type={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'warning' : 'info'}
              className="text-xs"
            >
              {run.status}
            </Badge>
          )}
          {onPopout && (
            <button
              type="button"
              onClick={onPopout}
              className="p-1.5 rounded-lg hover:bg-[var(--accent-hover)] text-slate-500 transition-colors"
              title={isDetached ? 'Dock back' : 'Detach to floating window'}
            >
              {isDetached ? <PanelRightClose className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleOpen}
            className="p-1.5 rounded-lg hover:bg-[var(--accent-hover)] text-slate-500 transition-colors"
            title={isDetached ? 'Close floating canvas' : 'Close Canvas'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-[var(--border-default)]/60 px-2 py-2 flex gap-1 overflow-x-auto flex-shrink-0 bg-[var(--surface-card)]">
        {TAB_OPTIONS.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap transition-all duration-150 ${
                isActive
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'hover:bg-[var(--accent-hover)] text-[var(--text-secondary)]'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-blue-600 dark:text-blue-400' : ''}`} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {activeTab === 'logs' && (
          <div className="space-y-4">
            {/* Step Status Panel */}
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-base)] p-3">
              <h4 className="text-xs font-semibold text-[var(--text-secondary)] mb-3 uppercase tracking-wide">
                Execution Steps
              </h4>
              <div className="space-y-1.5">
                {Object.entries(stepStatuses).map(([step, meta]) => {
                  const chip = statusChip(meta?.status);
                  const Icon = chip.icon;
                  const isActiveStep = activeStep === step;
                  const isRunning = meta?.status === 'running';

                  return (
                    <div
                      key={step}
                      className={`flex items-center justify-between text-xs rounded-lg px-3 py-2 transition-all duration-150 ${
                        isRunning
                          ? 'bg-blue-100/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50'
                          : isActiveStep && hasRunningStep
                          ? 'bg-blue-50/50 dark:bg-blue-900/10'
                          : 'hover:bg-white dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {/* Running indicator */}
                        {isRunning && (
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                          </span>
                        )}
                        <span className={`font-medium capitalize ${
                          isRunning 
                            ? 'text-blue-800 dark:text-blue-200' 
                            : 'text-[var(--text-secondary)]'
                        }`}>
                          {step}
                        </span>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        meta?.status === 'succeeded'
                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                          : meta?.status === 'failed'
                          ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                          : meta?.status === 'running'
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)]'
                      }`}>
                        <Icon className={`w-3 h-3 ${meta?.status === 'running' ? 'animate-spin' : ''}`} />
                        {chip.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Execution Logs */}
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-3">
              <h4 className="text-xs font-semibold text-[var(--text-secondary)] mb-3 uppercase tracking-wide">
                Logs
              </h4>
              {logs.length === 0 ? (
                <p className="text-xs text-slate-500 italic">Execution logs will appear here.</p>
              ) : (
                <div className="space-y-2">
                  {logs.map((log, idx) => (
                    <div 
                      key={log.id || idx} 
                      className="text-xs font-mono leading-relaxed"
                    >
                      <span className="text-slate-400 mr-2">[{log.step}]</span>
                      <span className="text-[var(--text-secondary)]">{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'code' && (
          <div className="rounded-xl border border-[var(--border-default)] overflow-hidden">
            <div className="bg-[var(--surface-subtle)] px-3 py-2 border-b border-[var(--border-default)] flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-secondary)]">Generated Code</span>
            </div>
            <pre className="text-xs bg-slate-900 text-slate-100 p-4 overflow-x-auto leading-relaxed">
              <code>{codeText || '# No executable code artifact yet.'}</code>
            </pre>
          </div>
        )}

        {activeTab === 'charts' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-[var(--border-default)] p-4">
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <p className="text-xs font-semibold text-[var(--text-secondary)]">Actual vs Forecast</p>
                {seriesGroups.length > 0 && (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-[var(--text-muted)] whitespace-nowrap">
                      SKU{seriesGroups.length > 1 ? ` (${seriesGroups.length})` : ''}:
                    </label>
                    {seriesGroups.length > 1 ? (
                      <select
                        value={effectiveGroupKey || ''}
                        onChange={(e) => {
                          setSelectedSeriesKey(e.target.value);
                          setHiddenSeries({});
                        }}
                        className="text-[11px] border border-[var(--border-default)] rounded-md px-2 py-1 bg-[var(--surface-card)] text-[var(--text-secondary)] max-w-[200px]"
                      >
                        {seriesGroups.map((g) => (
                          <option key={g.key} value={g.key}>
                            {g.material_code || g.key}{g.plant_id ? ` / ${g.plant_id}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[11px] font-medium text-[var(--text-secondary)] truncate max-w-[160px]">
                        {seriesGroups[0]?.material_code || seriesGroups[0]?.key || '—'}
                        {seriesGroups[0]?.plant_id ? ` / ${seriesGroups[0].plant_id}` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {actualVsForecastRows.length === 0 || !hasRenderableActualVsForecastSeries ? (
                <div className="h-48 md:h-64 w-full flex items-center justify-center text-slate-400 text-sm">
                  No data available
                </div>
              ) : (
                <div className="h-48 md:h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%" debounce={1}>
                    <LineChart data={actualVsForecastRows}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey={actualVsForecast.xKey} tickFormatter={chartTick} fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend
                        onClick={handleLegendClick}
                        formatter={legendFormatter}
                        wrapperStyle={{ cursor: 'pointer', fontSize: 11 }}
                      />
                      {showActual && (
                        <Line
                          type="monotone"
                          dataKey="actual"
                          name="Actual"
                          stroke="#10b981"
                          strokeWidth={2}
                          dot={false}
                          connectNulls={false}
                          hide={Boolean(hiddenSeries['actual'])}
                        />
                      )}
                      {showP50 && (
                        <Line
                          type="monotone"
                          dataKey="p50"
                          name="P50 (Forecast)"
                          stroke="#2563eb"
                          strokeWidth={2}
                          dot={false}
                          connectNulls={false}
                          hide={Boolean(hiddenSeries['p50'])}
                        />
                      )}
                      {showP90 && (
                        <Line
                          type="monotone"
                          dataKey="p90"
                          name="P90"
                          stroke="#1d4ed8"
                          strokeDasharray="4 4"
                          dot={false}
                          connectNulls={false}
                          hide={Boolean(hiddenSeries['p90'])}
                        />
                      )}
                      {showLower && (
                        <Line
                          type="monotone"
                          dataKey="lower"
                          name="Lower"
                          stroke="#60a5fa"
                          strokeDasharray="4 4"
                          dot={false}
                          connectNulls={false}
                          hide={Boolean(hiddenSeries['lower'])}
                        />
                      )}
                      {showUpper && (
                        <Line
                          type="monotone"
                          dataKey="upper"
                          name="Upper"
                          stroke="#60a5fa"
                          strokeDasharray="4 4"
                          dot={false}
                          connectNulls={false}
                          hide={Boolean(hiddenSeries['upper'])}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Inventory Projection — Recharts LineChart with with_plan + without_plan toggle */}
            {(() => {
              const rawInv = chartPayload.inventory_projection || [];
              const invRows = rawInv.map((row, i) => {
                if (row !== null && typeof row === 'object') {
                  return {
                    period: row.period ?? row.date ?? `T${i + 1}`,
                    with_plan: typeof row.with_plan === 'number' ? row.with_plan : null,
                    without_plan: typeof row.without_plan === 'number' ? row.without_plan : null
                  };
                }
                return { period: `T${i + 1}`, with_plan: typeof row === 'number' ? row : null, without_plan: null };
              });
              const hasWithoutPlan = invRows.some((r) => r.without_plan !== null && r.without_plan !== undefined);
              return (
                <div className="rounded-xl border border-[var(--border-default)] p-4">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-3">Inventory Projection</p>
                  {invRows.length === 0 ? (
                    <div className="h-48 md:h-64 w-full flex items-center justify-center text-slate-400 text-sm">No data available</div>
                  ) : (
                    <div className="h-48 md:h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%" debounce={1}>
                        <LineChart data={invRows}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="period" tickFormatter={chartTick} fontSize={11} />
                          <YAxis fontSize={11} />
                          <Tooltip />
                          <Legend
                            onClick={handleInvLegendClick}
                            formatter={invLegendFormatter}
                            wrapperStyle={{ cursor: 'pointer', fontSize: 11 }}
                          />
                          <Line
                            type="monotone"
                            dataKey="with_plan"
                            name="With Plan"
                            stroke="#059669"
                            strokeWidth={2}
                            dot={false}
                            connectNulls={false}
                            hide={Boolean(hiddenInvSeries['with_plan'])}
                          />
                          {hasWithoutPlan && (
                            <Line
                              type="monotone"
                              dataKey="without_plan"
                              name="Without Plan"
                              stroke="#94a3b8"
                              strokeDasharray="4 4"
                              strokeWidth={1.5}
                              dot={false}
                              connectNulls={false}
                              hide={Boolean(hiddenInvSeries['without_plan'])}
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Cost Breakdown — Recharts BarChart */}
            {(() => {
              const costRows = (chartPayload.cost_breakdown || []).map((row) => ({
                label: String(row.label ?? ''),
                value: Math.max(0, Number(row.value || 0))
              }));
              const BAR_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
              return (
                <div className="rounded-xl border border-[var(--border-default)] p-4">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-3">Cost Breakdown</p>
                  {costRows.length === 0 ? (
                    <div className="h-48 md:h-64 w-full flex items-center justify-center text-slate-400 text-sm">No data available</div>
                  ) : (
                    <div className="h-48 md:h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%" debounce={1}>
                        <BarChart data={costRows} margin={{ top: 4, right: 4, left: 0, bottom: 24 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="label" fontSize={11} tick={{ fill: '#64748b' }} interval={0} angle={-20} textAnchor="end" />
                          <YAxis fontSize={11} />
                          <Tooltip formatter={(v) => [v, 'Value']} />
                          <Bar dataKey="value" name="Cost" radius={[3, 3, 0, 0]}>
                            {costRows.map((_, i) => (
                              <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Risk-aware plan comparison card — only shown when risk_mode='on' */}
            {chartPayload.plan_comparison && (
              <RiskComparisonCard comparison={chartPayload.plan_comparison} />
            )}
          </div>
        )}

        {activeTab === 'data' && (
          <DataTab userId={userId} />
        )}

        {activeTab === 'topology' && (
          <TopologyTab
            topologyGraph={topologyGraph || chartPayload.topology_graph || null}
            topologyRunId={topologyRunId}
            onRunTopology={onRunTopology}
            topologyRunning={topologyRunning}
          />
        )}

        {activeTab === 'whatif' && (
          <WhatIfPanel
            userId={userId}
            baseRunId={latestPlanRunId}
            datasetProfileId={datasetProfileId}
            datasetProfileRow={datasetProfileRow}
          />
        )}

        {activeTab === 'downloads' && (
          <div className="space-y-2">
            {/* AI-Enhanced Export Workbook */}
            <div className="rounded-xl border border-blue-200 dark:border-blue-800/60 bg-blue-50/40 dark:bg-blue-900/10 p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-blue-800 dark:text-blue-300">
                  AI-Enhanced Export (.xlsx)
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {isAIExporting
                    ? 'Generating AI insights & building workbook...'
                    : 'Professional report with AI insights, charts & formatting'}
                </p>
              </div>
              <Button
                variant="primary"
                className="text-xs flex-shrink-0"
                onClick={handleAIExportWorkbook}
                disabled={isAIExporting || isExporting}
              >
                {isAIExporting ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <TableProperties className="w-3 h-3 mr-1" />
                )}
                {isAIExporting ? 'Building…' : 'AI Export'}
              </Button>
            </div>

            {/* Quick Export (existing SheetJS fallback) */}
            <div className="rounded-xl border border-[var(--border-default)] p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[var(--text-secondary)]">
                  Quick Export (.xlsx)
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Basic data-only workbook (no AI, no formatting)
                </p>
              </div>
              <Button
                variant="secondary"
                className="text-xs flex-shrink-0"
                onClick={handleExportWorkbook}
                disabled={isExporting || isAIExporting}
              >
                {isExporting ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <Download className="w-3 h-3 mr-1" />
                )}
                {isExporting ? 'Building…' : 'Quick'}
              </Button>
            </div>

            {/* Export status feedback */}
            {exportStatus && (
              <div className={`rounded-lg px-3 py-2 text-xs flex items-start gap-2 ${
                exportStatus.type === 'error'   ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/50' :
                exportStatus.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800/50' :
                                                  'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/50'
              }`}>
                {exportStatus.type === 'error' && <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                {exportStatus.type === 'success' && <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                {exportStatus.type === 'info' && <Loader2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 animate-spin" />}
                <span>{exportStatus.message}</span>
              </div>
            )}

            {/* Individual artifact downloads */}
            {[...downloads, ...(workbookArtifact ? [workbookArtifact] : [])].length === 0 ? (
              <div className="text-center py-6 text-slate-500">
                <Download className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-xs">No downloadable artifacts yet.</p>
              </div>
            ) : (
              [...downloads, ...(workbookArtifact ? [workbookArtifact] : [])].map((download) => (
                <div
                  key={`${download.fileName}-${download.label}`}
                  className="flex items-center justify-between rounded-xl border border-[var(--border-default)] p-3 hover:border-[var(--border-default)] transition-colors"
                >
                  <div className="min-w-0 mr-3">
                    <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                      {download.label || download.fileName}
                    </p>
                    <p className="text-[11px] text-slate-500 truncate">{download.fileName}</p>
                  </div>
                  <Button
                    variant="secondary"
                    className="text-xs flex-shrink-0"
                    onClick={() => downloadFile(download)}
                  >
                    <Download className="w-3 h-3 mr-1" />
                    Download
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
