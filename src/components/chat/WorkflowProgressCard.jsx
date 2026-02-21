import React, { useMemo, useState } from 'react';
import { Loader2, RefreshCw, PlayCircle } from 'lucide-react';
import { Card, Button, Badge } from '../ui';

const STEP_LABELS = {
  profile: 'Profile',
  contract: 'Contract',
  validate: 'Validate',
  forecast: 'Forecast',
  optimize: 'Optimize',
  compute_risk: 'Compute Risk',
  exceptions: 'Exceptions',
  verify: 'Verify',
  report: 'Report'
};

const statusBadgeType = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'succeeded' || normalized === 'skipped') return 'success';
  if (normalized === 'failed') return 'warning';
  if (normalized === 'running') return 'info';
  return 'default';
};

export default function WorkflowProgressCard({
  payload,
  snapshot,
  onResume,
  onReplay
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
            <Badge type={running ? 'info' : (succeeded ? 'success' : failed ? 'warning' : 'default')}>
              {(run?.status || payload?.status || 'unknown').toUpperCase()}
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

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => onResume?.(payload?.run_id || run?.id)}
            disabled={running || succeeded}
          >
            <PlayCircle className="w-3 h-3 mr-1" />
            Resume
          </Button>
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => onReplay?.(payload?.run_id || run?.id, {
              use_cached_forecast: supportsCacheReuse ? reuseCachedForecast : false,
              use_cached_plan: supportsCacheReuse ? reuseCachedPlan : false
            })}
            disabled={!run?.id}
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Replay
          </Button>
        </div>
      </div>
    </Card>
  );
}
