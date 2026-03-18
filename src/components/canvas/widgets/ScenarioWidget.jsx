/**
 * ScenarioWidget — Pure canvas widget for scenario comparison artifacts.
 * Receives all data via props (no internal fetching).
 *
 * Supports: scenario_comparison, plan_comparison
 */

import React, { useMemo, useState } from 'react';
import { GitCompare, ArrowRight, ChevronDown } from 'lucide-react';

function DeltaBadge({ before, after }) {
  if (before == null || after == null) return null;
  const delta = after - before;
  const pct = before !== 0 ? ((delta / Math.abs(before)) * 100).toFixed(1) : '∞';
  const isPositive = delta > 0;
  return (
    <span className={`text-xs font-mono ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
      {isPositive ? '+' : ''}{pct}%
    </span>
  );
}

/**
 * @param {object} props
 * @param {object} props.data
 * @param {Array}  [props.data.scenarios] - [{ name, params, kpis: { total_cost, fill_rate, ... } }]
 * @param {object} [props.data.baseline] - baseline KPIs
 */
export default function ScenarioWidget({ data = {} }) {
  const scenarios = data.scenarios || [];
  const baseline = data.baseline || scenarios[0]?.kpis || {};

  const kpiKeys = useMemo(() => {
    const all = new Set();
    scenarios.forEach(s => Object.keys(s.kpis || {}).forEach(k => all.add(k)));
    return [...all];
  }, [scenarios]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <GitCompare size={18} className="text-violet-500" />
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Scenario Comparison ({scenarios.length} scenarios)
        </h3>
      </div>

      {/* Comparison Table */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {scenarios.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="text-left pb-2 font-medium">KPI</th>
                {scenarios.map((s, i) => (
                  <th key={i} className="text-right pb-2 font-medium">{s.name || `Scenario ${i + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kpiKeys.map(kpi => (
                <tr key={kpi} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-2 font-medium">{kpi.replace(/_/g, ' ')}</td>
                  {scenarios.map((s, i) => {
                    const val = s.kpis?.[kpi];
                    return (
                      <td key={i} className="py-2 text-right">
                        <span className="font-mono">{typeof val === 'number' ? val.toLocaleString() : (val ?? '-')}</span>
                        {i > 0 && <span className="ml-2"><DeltaBadge before={scenarios[0]?.kpis?.[kpi]} after={val} /></span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No scenario data available
          </div>
        )}
      </div>
    </div>
  );
}
