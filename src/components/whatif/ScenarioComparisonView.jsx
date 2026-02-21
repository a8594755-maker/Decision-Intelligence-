/**
 * ScenarioComparisonView
 *
 * Renders the comparison between base and scenario runs.
 * Shows KPI cards (base / scenario / delta) and top SKU changes table.
 */

import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';

function fmt(value, type = 'number') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (type === 'pct') return `${(value * 100).toFixed(2)}%`;
  if (type === 'pct_pp') {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(2)} pp`;
  }
  if (type === 'delta') {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}`;
  }
  return value.toFixed(2);
}

function DeltaChip({ value, goodDirection = 'up' }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  const isPositive = value > 0;
  const isGood = goodDirection === 'up' ? isPositive : !isPositive;
  const color = isGood
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-red-500 dark:text-red-400';
  const Icon = isPositive ? TrendingUp : TrendingDown;

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${color}`}>
      <Icon className="w-3 h-3" />
      {fmt(value, 'delta')}
    </span>
  );
}

function KpiCard({ label, base, scenario, delta, type, goodDirection }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">{label}</p>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-xs text-slate-400 mb-0.5">Base</p>
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{fmt(base, type)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-0.5">Scenario</p>
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{fmt(scenario, type)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-0.5">Δ</p>
          <DeltaChip value={delta} goodDirection={goodDirection} />
        </div>
      </div>
    </div>
  );
}

function TopChangesTable({ changes }) {
  if (!changes || changes.length === 0) {
    return (
      <p className="text-xs text-slate-400 text-center py-4">
        No significant SKU-level changes detected.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700">
            <th className="text-left py-1.5 pr-2 font-medium text-slate-500">SKU</th>
            <th className="text-left py-1.5 pr-2 font-medium text-slate-500">Plant</th>
            <th className="text-right py-1.5 pr-2 font-medium text-slate-500">Field</th>
            <th className="text-right py-1.5 pr-2 font-medium text-slate-500">Base</th>
            <th className="text-right py-1.5 pr-2 font-medium text-slate-500">Scenario</th>
            <th className="text-right py-1.5 font-medium text-slate-500">Δ</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((row, i) => (
            <tr key={`${row.sku}|${row.plant_id}|${i}`} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <td className="py-1.5 pr-2 font-mono text-slate-700 dark:text-slate-300 truncate max-w-[90px]" title={row.sku}>{row.sku}</td>
              <td className="py-1.5 pr-2 text-slate-500">{row.plant_id || '—'}</td>
              <td className="py-1.5 pr-2 text-right text-slate-500">{row.field}</td>
              <td className="py-1.5 pr-2 text-right text-slate-600 dark:text-slate-300">{fmt(row.base)}</td>
              <td className="py-1.5 pr-2 text-right text-slate-600 dark:text-slate-300">{fmt(row.scenario)}</td>
              <td className="py-1.5 text-right">
                <DeltaChip value={row.delta} goodDirection={row.delta > 0 ? 'up' : 'down'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ScenarioComparisonView({ comparison, scenarioName }) {
  if (!comparison) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
        <AlertTriangle className="w-4 h-4" />
        Comparison data unavailable.
      </div>
    );
  }

  const { kpis = {}, top_changes = [], notes = [], overrides = {} } = comparison;
  const base = kpis.base || {};
  const scenario = kpis.scenario || {};
  const delta = kpis.delta || {};

  const activeOverrides = useMemo(() => {
    return Object.entries(overrides)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${v}`);
  }, [overrides]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {scenarioName || 'Scenario'} vs Base
        </h3>
        {activeOverrides.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {activeOverrides.map((o) => (
              <span key={o} className="inline-block bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs px-1.5 py-0.5 rounded">
                {o}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-2">
        <KpiCard
          label="Service Level"
          base={base.service_level_proxy}
          scenario={scenario.service_level_proxy}
          delta={delta.service_level_proxy}
          type="pct"
          goodDirection="up"
        />
        <KpiCard
          label="Stockout Units"
          base={base.stockout_units}
          scenario={scenario.stockout_units}
          delta={delta.stockout_units}
          type="number"
          goodDirection="down"
        />
        <KpiCard
          label="Holding Units"
          base={base.holding_units}
          scenario={scenario.holding_units}
          delta={delta.holding_units}
          type="number"
          goodDirection="down"
        />
        <KpiCard
          label="Est. Total Cost"
          base={base.estimated_total_cost}
          scenario={scenario.estimated_total_cost}
          delta={delta.estimated_total_cost}
          type="number"
          goodDirection="down"
        />
      </div>

      {/* Top Changes */}
      <div>
        <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
          Top SKU Changes ({top_changes.length})
        </h4>
        <TopChangesTable changes={top_changes} />
      </div>

      {/* Notes */}
      {notes.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Notes</h4>
          <ul className="space-y-0.5">
            {notes.map((note, i) => (
              <li key={i} className="text-xs text-slate-500 dark:text-slate-400">
                • {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Run IDs */}
      <div className="text-xs text-slate-400 border-t border-slate-100 dark:border-slate-700 pt-2">
        Base run #{comparison.base_run_id} → Scenario run #{comparison.scenario_run_id}
      </div>
    </div>
  );
}
