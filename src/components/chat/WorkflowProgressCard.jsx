import React, { useMemo, useState } from 'react';
import { Loader2, RefreshCw, PlayCircle, HelpCircle } from 'lucide-react';
import { Card, Button, Badge } from '../ui';

const STEP_LABELS = {
  profile: 'Profile',
  contract: 'Contract',
  validate: 'Validate',
  forecast: 'Forecast',
  risk_scan: 'Risk Scan',
  bom_explosion: 'BOM Explosion',
  optimize: 'Optimize',
  compute_risk: 'Compute Risk',
  exceptions: 'Exceptions',
  topology: 'Topology',
  verify_replay: 'Verify/Replay',
  verify: 'Verify',
  report: 'Report'
};

const statusBadgeType = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'succeeded' || normalized === 'skipped') return 'success';
  if (normalized === 'failed') return 'warning';
  if (normalized === 'running') return 'info';
  if (normalized === 'blocked' || normalized === 'waiting_user') return 'warning';
  return 'default';
};

export default function WorkflowProgressCard({
  payload,
  snapshot,
  onResume,
  onReplay,
  onCancel
}) {
  const safePayload = payload || {};

  const [reuseCachedForecast, setReuseCachedForecast] = useState(true);
  const [reuseCachedPlan, setReuseCachedPlan] = useState(true);

  const run = snapshot?.run || safePayload?.run || null;
  const steps = useMemo(() => {
    const source = snapshot?.steps || safePayload?.steps || [];
    return Array.isArray(source) ? source : [];
  }, [snapshot?.steps, safePayload?.steps]);

  if (!payload) return null;

  const running = String(run?.status || '').toLowerCase() === 'running';
  const failed = String(run?.status || '').toLowerCase() === 'failed';
  const succeeded = String(run?.status || '').toLowerCase() === 'succeeded';
  const paused = String(run?.status || '').toLowerCase() === 'waiting_user';
  const asyncJobId = safePayload?.job_id || run?.job_id || run?.meta?.job_id || run?.meta?.async_job_id || null;
  const hasAsyncJob = Boolean(asyncJobId);
  const resolvedRunId = payload?.run_id || run?.id || null;
  const workflowName = String(run?.workflow || payload?.workflow || '').toLowerCase();
  const workflowLabel = workflowName.includes('workflow_b')
    ? 'Workflow B Progress'
    : 'Workflow A Progress';
  const supportsCacheReuse = workflowName.includes('workflow_a');

  return (
    <Card className="w-full border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/10">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{workflowLabel}</h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Run #{run?.id || payload?.run_id || 'N/A'} | {run?.workflow || payload?.workflow || 'workflow_unknown'} | Status: {run?.status || payload?.status || 'unknown'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running && <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />}
            <Badge type={running ? 'info' : (paused ? 'warning' : (succeeded ? 'success' : failed ? 'warning' : 'default'))}>
              {paused ? 'PAUSED' : (run?.status || payload?.status || 'unknown').toUpperCase()}
            </Badge>
          </div>
        </div>

        <div className="space-y-2">
          {steps.map((stepRow) => (
            <div key={stepRow.step} className="flex items-center justify-between text-xs border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-white/80 dark:bg-slate-900/40">
              <span className="font-medium">{STEP_LABELS[stepRow.step] || stepRow.step}</span>
              <div className="flex items-center gap-2">
                {stepRow.error_code && (
                  <span className="text-[10px] text-red-600 dark:text-red-300">{stepRow.error_code}</span>
                )}
                <Badge type={statusBadgeType(stepRow.status)}>
                  {String(stepRow.status || 'queued').toUpperCase()}
                </Badge>
              </div>
            </div>
          ))}
        </div>

        {supportsCacheReuse && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={reuseCachedForecast}
                onChange={(event) => setReuseCachedForecast(event.target.checked)}
              />
              reuse cached forecast
            </label>
            <label className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={reuseCachedPlan}
                onChange={(event) => setReuseCachedPlan(event.target.checked)}
              />
              reuse cached plan
            </label>
          </div>
        )}

        {paused && (
          <div className="flex items-center gap-2 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <HelpCircle className="w-3.5 h-3.5 shrink-0" />
            <span>Paused — waiting for user confirmation. Answer the questions above to resume.</span>
          </div>
        )}
        {hasAsyncJob && (
          <div className="rounded border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/40 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
            This run is managed by async job <strong>{asyncJobId}</strong>. Resume/replay from this card is not available.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => onResume?.(resolvedRunId, asyncJobId)}
            disabled={running || succeeded || hasAsyncJob}
          >
            <PlayCircle className="w-3 h-3 mr-1" />
            {paused ? 'Resume after answering' : 'Resume'}
          </Button>
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => onReplay?.(resolvedRunId, {
              use_cached_forecast: supportsCacheReuse ? reuseCachedForecast : false,
              use_cached_plan: supportsCacheReuse ? reuseCachedPlan : false
            }, asyncJobId)}
            disabled={!resolvedRunId || hasAsyncJob}
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Replay
          </Button>
          {running && hasAsyncJob && onCancel && (
            <Button
              variant="secondary"
              className="text-xs"
              onClick={() => onCancel?.(resolvedRunId, asyncJobId)}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
