import React from 'react';
import { BarChart3, AlertTriangle, Info } from 'lucide-react';
import { Card, Badge } from '../ui';

const formatPct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'N/A');
const formatNum = (value) => (Number.isFinite(value) ? Number(value).toFixed(2) : 'N/A');

function DataQualityBadge({ dataQuality }) {
  if (!dataQuality) return null;

  const { coverage_level, fallbacks_used = [], dataset_fallbacks = [] } = dataQuality;
  const colors = {
    full: 'success',
    partial: 'warning',
    minimal: 'danger',
  };

  const fallbackCount = fallbacks_used.reduce((sum, f) => sum + (f.count || 1), 0);
  const degradedFeatures = dataset_fallbacks.filter(d => d.degradesCapability).length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge type={colors[coverage_level] || 'info'}>
        Data: {coverage_level}
      </Badge>
      {fallbackCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3" />
          {fallbackCount} field{fallbackCount !== 1 ? 's' : ''} estimated
        </span>
      )}
      {degradedFeatures > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
          <Info className="w-3 h-3" />
          {degradedFeatures} feature{degradedFeatures !== 1 ? 's' : ''} unavailable
        </span>
      )}
    </div>
  );
}

function DatasetFallbackHints({ datasetFallbacks = [], capabilities }) {
  const unavailable = capabilities
    ? Object.entries(capabilities).filter(([, cap]) => {
        const level = typeof cap === 'string' ? cap : cap?.level;
        return level === 'unavailable';
      })
    : [];

  if (datasetFallbacks.length === 0 && unavailable.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {unavailable.map(([key]) => (
        <p key={key} className="text-[10px] text-[var(--text-muted)] leading-tight">
          <span className="font-medium">{key.replace(/_/g, ' ')}</span> is unavailable due to missing data.
        </p>
      ))}
      {datasetFallbacks.map((fb, i) => (
        <p key={i} className="text-[10px] text-[var(--text-muted)] leading-tight">
          {fb.message}
        </p>
      ))}
    </div>
  );
}

export default function PlanSummaryCard({ payload }) {
  if (!payload) return null;

  const kpis = payload.kpis || {};
  const replay = payload.replay_metrics || {};
  const withPlan = replay.with_plan || {};
  const withoutPlan = replay.without_plan || {};
  const delta = replay.delta || {};
  const dataQuality = payload.data_quality || null;

  return (
    <Card category="plan" className="w-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-emerald-600" />
              Plan Summary
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              Run #{payload.run_id || 'N/A'} | {payload.workflow || 'workflow_unknown'}
            </p>
            <p className="text-xs text-[var(--text-muted)]">{payload.summary || 'Deterministic plan + verification completed.'}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge type="success">{payload.solver_status || 'unknown'}</Badge>
            <Badge type="info">Rows: {payload.total_plan_rows || 0}</Badge>
            {payload.multi_echelon_mode && payload.multi_echelon_mode !== 'off' && (
              <Badge type="warning">BOM mode</Badge>
            )}
          </div>
        </div>

        {dataQuality && <DataQualityBadge dataQuality={dataQuality} />}

        <div className="flex flex-wrap gap-2 text-xs">
          <Badge type="info">Service (with plan): {formatPct(withPlan.service_level_proxy)}</Badge>
          <Badge type="info">Service (no plan): {formatPct(withoutPlan.service_level_proxy)}</Badge>
          <Badge type="info">Service delta: {formatPct(delta.service_level_proxy)}</Badge>
          <Badge type="info">Stockout units: {formatNum(kpis.estimated_stockout_units)}</Badge>
          <Badge type="info">Holding units: {formatNum(kpis.estimated_holding_units)}</Badge>
          <Badge type="info">Cost proxy: {formatNum(kpis.estimated_total_cost)}</Badge>
          {payload.component_plan_rows > 0 && (
            <Badge type="info">Component rows: {payload.component_plan_rows}</Badge>
          )}
        </div>

        {dataQuality && <DatasetFallbackHints datasetFallbacks={dataQuality.dataset_fallbacks} capabilities={dataQuality.capabilities} />}
      </div>
    </Card>
  );
}
