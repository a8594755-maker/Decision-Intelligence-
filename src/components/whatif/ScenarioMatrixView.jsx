/**
 * ScenarioMatrixView.jsx — Multi-scenario side-by-side comparison matrix (Gap 6A).
 *
 * Props:
 *   summary    — output of buildMultiScenarioSummary()
 *   onExport?  — custom export handler; falls back to inline CSV download
 *   onSelectScenario? — (scenario) => void
 */

import React from 'react';
import { Trophy, TrendingUp, TrendingDown, Download, Star } from 'lucide-react';
import { Card, Badge } from '../ui';
import { exportMultiScenarioToCsv } from '../../utils/buildMultiScenarioSummary';

// ── Delta badge ───────────────────────────────────────────────────────────────

function DeltaBadge({ delta, goodDirection }) {
  if (delta == null) return <span className="text-slate-400 text-[10px]">{'\u2014'}</span>;

  const isGood = goodDirection === 'up' ? delta > 0 : delta < 0;
  const isNeutral = delta === 0;

  const color = isNeutral
    ? 'text-slate-400'
    : isGood
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-500 dark:text-red-400';

  const prefix = delta > 0 ? '+' : '';
  const Icon = isNeutral ? null : isGood ? TrendingUp : TrendingDown;

  return (
    <span className={`text-[10px] font-medium ${color} flex items-center gap-0.5 justify-center`}>
      {Icon && <Icon className="w-2.5 h-2.5 inline" />}
      {prefix}
      {typeof delta === 'number' && Math.abs(delta) < 1
        ? `${(delta * 100).toFixed(1)}pp`
        : delta?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
    </span>
  );
}

// ── Scenario column header ────────────────────────────────────────────────────

function ScenarioHeader({ scenario, isRecommended, onClick }) {
  const hasOverrides = Object.keys(scenario.overrides || {}).length > 0;

  return (
    <th
      className={`px-3 py-2 text-center min-w-[110px] cursor-pointer transition-colors
        ${isRecommended
          ? 'bg-emerald-50 dark:bg-emerald-900/20 border-b-2 border-emerald-500'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
      onClick={() => onClick?.(scenario)}
    >
      <div className="space-y-1">
        {isRecommended && (
          <div className="flex justify-center">
            <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
              <Star className="w-2.5 h-2.5" /> RECOMMENDED
            </span>
          </div>
        )}
        <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-tight">
          {scenario.name}
        </p>
        {hasOverrides && (
          <div className="flex flex-wrap justify-center gap-0.5">
            {Object.entries(scenario.overrides)
              .filter(([, v]) => v != null)
              .slice(0, 2)
              .map(([k, v]) => (
                <span
                  key={k}
                  className="text-[9px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1 py-0.5 rounded"
                >
                  {k}: {String(v).slice(0, 8)}
                </span>
              ))}
          </div>
        )}
        <Badge type={scenario.status === 'cached' ? 'success' : 'info'} className="text-[9px] px-1 py-0">
          {scenario.status === 'cached' ? 'Cached' : 'New'}
        </Badge>
      </div>
    </th>
  );
}

// ── KPI row ───────────────────────────────────────────────────────────────────

function KpiRow({ kpiDef, values, recommendedName }) {
  return (
    <tr className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50/50 dark:hover:bg-slate-800/20">
      <td className="px-3 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
        {kpiDef.kpi_label}
        <span className="ml-1 text-[9px] text-slate-400">
          ({kpiDef.good_direction === 'up' ? '\u2191' : '\u2193'})
        </span>
      </td>

      {values.map((cell) => (
        <td
          key={cell.scenario_name}
          className={`px-3 py-2.5 text-center transition-colors
            ${cell.is_best ? 'bg-emerald-50/70 dark:bg-emerald-900/10' : ''}
            ${cell.scenario_name === recommendedName ? 'bg-emerald-50/40 dark:bg-emerald-900/5' : ''}`}
        >
          <div className="space-y-0.5">
            <p className={`text-xs font-semibold
              ${cell.is_best ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-100'}`}>
              {cell.formatted}
              {cell.is_best && <span className="ml-1 text-[9px] text-emerald-600">{'\u2605'}</span>}
            </p>
            {cell.delta_vs_base != null && (
              <DeltaBadge delta={cell.delta_vs_base} goodDirection={kpiDef.good_direction} />
            )}
          </div>
        </td>
      ))}
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ScenarioMatrixView({ summary, onExport, onSelectScenario }) {
  if (!summary?.scenarios?.length) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-slate-400">
        No scenario comparison data available.
      </div>
    );
  }

  const { scenarios, kpi_matrix, recommended_scenario } = summary;
  const recommendedName = recommended_scenario?.name;

  // Recommended scenario first, then by descending score
  const sorted = [...scenarios].sort((a, b) => {
    if (a.name === recommendedName) return -1;
    if (b.name === recommendedName) return 1;
    return (b.recommendation_score ?? 0) - (a.recommendation_score ?? 0);
  });

  const handleExportCsv = () => {
    if (onExport) { onExport(); return; }
    const csv = exportMultiScenarioToCsv(summary);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scenario_comparison_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="w-full overflow-hidden">
      <div className="space-y-3">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-500" />
            <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              Scenario Comparison
            </h4>
            <Badge type="info">{scenarios.length} scenarios</Badge>
          </div>
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
        </div>

        {/* Recommendation banner */}
        {recommended_scenario && (
          <div className="flex items-start gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 px-3 py-2">
            <Star className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                Recommended: {recommended_scenario.name}
              </p>
              {recommended_scenario.key_reasons?.length > 0 && (
                <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5">
                  {recommended_scenario.key_reasons.join(' \u00B7 ')}
                </p>
              )}
            </div>
          </div>
        )}

        {/* KPI matrix table */}
        <div className="overflow-x-auto -mx-1">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-600">
                <th className="px-3 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">
                  KPI
                </th>
                {sorted.map((s) => (
                  <ScenarioHeader
                    key={s.name}
                    scenario={s}
                    isRecommended={s.name === recommendedName}
                    onClick={onSelectScenario}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {kpi_matrix.map((row) => (
                <KpiRow
                  key={row.kpi_key}
                  kpiDef={row}
                  values={sorted.map((s) =>
                    row.values.find((v) => v.scenario_name === s.name) ||
                    { scenario_name: s.name, raw: null, formatted: '\u2014', delta_vs_base: null, is_best: false },
                  )}
                  recommendedName={recommendedName}
                />
              ))}

              {/* Composite score row */}
              <tr className="border-t border-slate-200 dark:border-slate-600 bg-slate-50/50 dark:bg-slate-800/20">
                <td className="px-3 py-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                  Composite Score
                </td>
                {sorted.map((s) => (
                  <td key={s.name} className="px-3 py-2 text-center">
                    <span className={`text-xs font-bold
                      ${s.name === recommendedName
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-slate-600 dark:text-slate-300'}`}>
                      {s.recommendation_score != null
                        ? `${(s.recommendation_score * 100).toFixed(0)}`
                        : '\u2014'}
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

      </div>
    </Card>
  );
}
