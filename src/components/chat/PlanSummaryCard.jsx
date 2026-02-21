import React from 'react';
import { BarChart3 } from 'lucide-react';
import { Card, Badge } from '../ui';

const formatPct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'N/A');
const formatNum = (value) => (Number.isFinite(value) ? Number(value).toFixed(2) : 'N/A');

export default function PlanSummaryCard({ payload }) {
  if (!payload) return null;

  const kpis = payload.kpis || {};
  const replay = payload.replay_metrics || {};
  const withPlan = replay.with_plan || {};
  const withoutPlan = replay.without_plan || {};
  const delta = replay.delta || {};

  return (
    <Card className="w-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-emerald-600" />
              Plan Summary
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Run #{payload.run_id || 'N/A'} | {payload.workflow || 'workflow_unknown'}
            </p>
            <p className="text-xs text-slate-500">{payload.summary || 'Deterministic plan + verification completed.'}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge type="success">{payload.solver_status || 'unknown'}</Badge>
            <Badge type="info">Rows: {payload.total_plan_rows || 0}</Badge>
            {payload.multi_echelon_mode && payload.multi_echelon_mode !== 'off' && (
              <Badge type="warning">BOM mode</Badge>
            )}
          </div>
        </div>

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
      </div>
    </Card>
  );
}
