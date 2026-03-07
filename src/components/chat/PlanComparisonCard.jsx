/**
 * PlanComparisonCard.jsx
 *
 * Shows side-by-side KPI comparison between two plans.
 * Used when user says "compare with last plan" or after a parameter change + re-run.
 */

import React from 'react';
import { GitCompareArrows, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import Card from '../ui/Card';
import Badge from '../ui/Badge';

function formatKpi(key, value) {
  if (value == null) return '—';
  if (key.includes('cost')) return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (key.includes('service_level')) return `${(Number(value) * 100).toFixed(1)}%`;
  if (key.includes('units')) return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(value);
}

function DeltaBadge({ delta }) {
  if (!delta || delta.absolute == null) return <Badge type="info">—</Badge>;

  const isPositive = delta.absolute > 0;
  const isNeutral = delta.absolute === 0;

  if (isNeutral) {
    return (
      <Badge type="info">
        <Minus className="w-3 h-3 inline mr-0.5" />
        0
      </Badge>
    );
  }

  return (
    <Badge type={isPositive ? 'warning' : 'success'}>
      {isPositive ? (
        <TrendingUp className="w-3 h-3 inline mr-0.5" />
      ) : (
        <TrendingDown className="w-3 h-3 inline mr-0.5" />
      )}
      {delta.percent != null ? `${delta.percent > 0 ? '+' : ''}${delta.percent}%` : `${delta.absolute > 0 ? '+' : ''}${delta.absolute}`}
    </Badge>
  );
}

function ServiceLevelDeltaBadge({ delta }) {
  if (!delta || delta.absolute == null) return <Badge type="info">—</Badge>;

  const isPositive = delta.absolute > 0;
  const isNeutral = delta.absolute === 0;

  if (isNeutral) {
    return <Badge type="info"><Minus className="w-3 h-3 inline mr-0.5" />0</Badge>;
  }

  // Higher service level is good
  return (
    <Badge type={isPositive ? 'success' : 'danger'}>
      {isPositive ? (
        <TrendingUp className="w-3 h-3 inline mr-0.5" />
      ) : (
        <TrendingDown className="w-3 h-3 inline mr-0.5" />
      )}
      {(Math.abs(delta.absolute) * 100).toFixed(1)} pp
    </Badge>
  );
}

function StockoutDeltaBadge({ delta }) {
  if (!delta || delta.absolute == null) return <Badge type="info">—</Badge>;

  const isNeutral = delta.absolute === 0;
  if (isNeutral) return <Badge type="info"><Minus className="w-3 h-3 inline mr-0.5" />0</Badge>;

  // Fewer stockout units is good
  const isGood = delta.absolute < 0;
  return (
    <Badge type={isGood ? 'success' : 'danger'}>
      {isGood ? <TrendingDown className="w-3 h-3 inline mr-0.5" /> : <TrendingUp className="w-3 h-3 inline mr-0.5" />}
      {delta.percent != null ? `${delta.percent > 0 ? '+' : ''}${delta.percent}%` : Math.abs(delta.absolute).toLocaleString()}
    </Badge>
  );
}

const KPI_ROWS = [
  { key: 'estimated_total_cost', label: 'Total Cost', DeltaComponent: DeltaBadge },
  { key: 'estimated_service_level', label: 'Service Level', DeltaComponent: ServiceLevelDeltaBadge },
  { key: 'estimated_stockout_units', label: 'Stockout Units', DeltaComponent: StockoutDeltaBadge },
  { key: 'estimated_holding_units', label: 'Holding Units', DeltaComponent: DeltaBadge },
];

export default function PlanComparisonCard({ payload }) {
  if (!payload) return null;

  const { previous, current, deltas } = payload;

  return (
    <Card className="border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/10">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <GitCompareArrows className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              Plan Comparison
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              Run #{previous?.run_id ?? '?'} vs Run #{current?.run_id ?? '?'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {current?.solver_status && (
              <Badge type={current.solver_status === 'optimal' ? 'success' : current.solver_status === 'feasible' ? 'info' : 'danger'}>
                {current.solver_status}
              </Badge>
            )}
            {current?.risk_mode === 'on' && (
              <Badge type="warning">Risk-Aware</Badge>
            )}
          </div>
        </div>

        {/* KPI Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left py-1.5 pr-3 font-medium text-slate-500 dark:text-slate-400">KPI</th>
                <th className="text-right py-1.5 px-3 font-medium text-slate-500 dark:text-slate-400">Previous</th>
                <th className="text-right py-1.5 px-3 font-medium text-slate-500 dark:text-slate-400">Current</th>
                <th className="text-right py-1.5 pl-3 font-medium text-slate-500 dark:text-slate-400">Change</th>
              </tr>
            </thead>
            <tbody>
              {KPI_ROWS.map(({ key, label, DeltaComponent: _DeltaComponent }) => (
                <tr key={key} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="py-1.5 pr-3 font-medium text-slate-700 dark:text-slate-300">{label}</td>
                  <td className="text-right py-1.5 px-3 text-slate-600 dark:text-slate-400 tabular-nums">
                    {formatKpi(key, previous?.kpis?.[key])}
                  </td>
                  <td className="text-right py-1.5 px-3 text-slate-900 dark:text-slate-100 font-medium tabular-nums">
                    {formatKpi(key, current?.kpis?.[key])}
                  </td>
                  <td className="text-right py-1.5 pl-3">
                    <DeltaComponent delta={deltas?.[key]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
