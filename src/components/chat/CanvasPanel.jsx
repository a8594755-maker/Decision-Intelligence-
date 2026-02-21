import React from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Download, Code2, BarChart3, Terminal, ChevronRight, X } from 'lucide-react';
import { Card, Button, Badge } from '../ui';
import { SimpleLineChart, SimpleBarChart } from '../charts';

const TAB_OPTIONS = [
  { id: 'logs', label: 'Log View', icon: Terminal },
  { id: 'code', label: 'Code View', icon: Code2 },
  { id: 'charts', label: 'Charts', icon: BarChart3 },
  { id: 'downloads', label: 'Downloads', icon: Download }
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

export default function CanvasPanel({
  onToggleOpen,
  activeTab,
  onTabChange,
  run,
  logs = [],
  stepStatuses = {},
  codeText = '',
  chartPayload = {},
  downloads = []
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
          <button
            type="button"
            onClick={onToggleOpen}
            className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition-colors"
            title="Close Canvas"
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
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3">Actual vs Forecast</p>
              <SimpleLineChart
                data={(chartPayload.actual_vs_forecast || []).map((row) => row.actual ?? row.forecast ?? 0)}
                color="#2563eb"
              />
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
          </div>
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
