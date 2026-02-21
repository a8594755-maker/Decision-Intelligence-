import React, { useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Download, Code2, BarChart3, Terminal, ChevronRight, X, ShieldAlert, Share2, FlaskConical, ExternalLink, PanelRightClose } from 'lucide-react';
import { Card, Button, Badge } from '../ui';
import { SimpleLineChart, SimpleBarChart } from '../charts';
import TopologyTab from './TopologyTab';
import WhatIfPanel from '../whatif/WhatIfPanel';
import {
  LineChart,
  Line,
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
  const payload = typeof download.content === 'string'
    ? download.content
    : JSON.stringify(download.content ?? {}, null, 2);
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
            <tr className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="text-left pb-1 font-medium">Metric</th>
              <th className="text-right pb-1 font-medium">Base</th>
              <th className="text-right pb-1 font-medium">Risk-Aware</th>
              <th className="text-right pb-1 font-medium">Delta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {metrics.map((m) => (
              <tr key={m.label}>
                <td className="py-1.5 text-slate-700 dark:text-slate-300 font-medium">{m.label}</td>
                <td className="py-1.5 text-right text-slate-600 dark:text-slate-400">{m.base}</td>
                <td className="py-1.5 text-right text-slate-800 dark:text-slate-200 font-medium">{m.risk}</td>
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
          <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-2 uppercase tracking-wide">
            Top Changed SKUs
          </p>
          <div className="space-y-1.5">
            {keyChanges.map((change, idx) => (
              <div key={`${change.sku}-${idx}`} className="rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-800 dark:text-slate-200">
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
  const seriesGroups = Array.isArray(chartPayload.series_groups) ? chartPayload.series_groups : [];
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
    <div className="w-full h-full flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700/60 overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-200 dark:border-slate-700/60 px-4 py-3 bg-slate-50/80 dark:bg-slate-900/90 flex items-center justify-between flex-shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Canvas</h3>
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
              className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition-colors"
              title={isDetached ? 'Dock back' : 'Detach to floating window'}
            >
              {isDetached ? <PanelRightClose className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleOpen}
            className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition-colors"
            title={isDetached ? 'Close floating canvas' : 'Close Canvas'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 dark:border-slate-700/60 px-2 py-2 flex gap-1 overflow-x-auto flex-shrink-0 bg-white dark:bg-slate-900">
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
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400'
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
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30 p-3">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3 uppercase tracking-wide">
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
                            : 'text-slate-700 dark:text-slate-300'
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
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
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
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3 uppercase tracking-wide">
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
                      <span className="text-slate-700 dark:text-slate-300">{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'code' && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="bg-slate-100 dark:bg-slate-800 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">Generated Code</span>
            </div>
            <pre className="text-xs bg-slate-900 text-slate-100 p-4 overflow-x-auto leading-relaxed">
              <code>{codeText || '# No executable code artifact yet.'}</code>
            </pre>
          </div>
        )}

        {activeTab === 'charts' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">Actual vs Forecast</p>
                {seriesGroups.length > 1 && (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      Series ({seriesGroups.length} total):
                    </label>
                    <select
                      value={effectiveGroupKey || ''}
                      onChange={(e) => setSelectedSeriesKey(e.target.value)}
                      className="text-[11px] border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 max-w-[200px]"
                    >
                      {seriesGroups.map((g) => (
                        <option key={g.key} value={g.key}>
                          {g.material_code || g.key}{g.plant_id ? ` / ${g.plant_id}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {actualVsForecastRows.length === 0 || !hasRenderableActualVsForecastSeries ? (
                <div className="h-48 md:h-64 w-full flex items-center justify-center text-slate-400 text-sm">
                  No data available
                </div>
              ) : (
                <div className="h-48 md:h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={actualVsForecastRows}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey={actualVsForecast.xKey} tickFormatter={chartTick} fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend />
                      {showActual && (
                        <Line
                          type="monotone"
                          dataKey="actual"
                          name="Actual"
                          stroke="#10b981"
                          strokeWidth={2}
                          dot={false}
                          connectNulls={false}
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
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3">Inventory Projection</p>
              <SimpleLineChart
                data={(chartPayload.inventory_projection || []).map((row) => row.with_plan ?? 0)}
                color="#059669"
              />
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3">Cost Breakdown</p>
              <SimpleBarChart
                data={(chartPayload.cost_breakdown || []).map((row) => Math.max(0, Number(row.value || 0)))}
                labels={(chartPayload.cost_breakdown || []).map((row) => row.label)}
                colorClass="bg-emerald-500"
              />
            </div>

            {/* Risk-aware plan comparison card — only shown when risk_mode='on' */}
            {chartPayload.plan_comparison && (
              <RiskComparisonCard comparison={chartPayload.plan_comparison} />
            )}
          </div>
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
            {downloads.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                <Download className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-xs">No downloadable artifacts yet.</p>
              </div>
            ) : (
              downloads.map((download) => (
                <div 
                  key={`${download.fileName}-${download.label}`} 
                  className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-700 p-3 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                >
                  <div className="min-w-0 mr-3">
                    <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
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
