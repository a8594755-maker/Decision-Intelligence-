import React, { useState } from 'react';
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, Badge } from '../ui';

const fmt = (v, isPercent = false) => {
  if (!Number.isFinite(Number(v))) return 'N/A';
  return isPercent ? `${(Number(v) * 100).toFixed(1)}%` : Number(v).toFixed(0);
};

const fmtDelta = (v, lowerIsBetter = false) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const good = lowerIsBetter ? n < 0 : n > 0;
  return { label: `${n > 0 ? '+' : ''}${n.toFixed(0)}`, good };
};

const KPI_ROWS = [
  { key: 'service_level', label: 'Service Level', isPercent: true, lowerIsBetter: false },
  { key: 'stockout_units', label: 'Stockout Units', isPercent: false, lowerIsBetter: true },
  { key: 'holding_units', label: 'Holding Units', isPercent: false, lowerIsBetter: true }
];

export default function RiskAwarePlanComparisonCard({ payload }) {
  const [rulesOpen, setRulesOpen] = useState(false);

  if (!payload) return null;

  const kpis = payload.kpis || { base: {}, risk: {}, delta: {} };
  const keyChanges = Array.isArray(payload.key_changes) ? payload.key_changes.slice(0, 5) : [];
  const rulesFired = Array.isArray(payload.rules_fired) ? payload.rules_fired : [];

  return (
    <Card category="plan" className="w-full border border-amber-200 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3">

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              Risk-Aware Plan Comparison
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              Run #{payload.run_id || 'N/A'} | mode: {payload.risk_mode || 'on'}
            </p>
          </div>
          <Badge type="warning">{payload.num_impacted_skus || 0} impacted SKUs</Badge>
        </div>

        {/* KPI comparison table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-[var(--border-default)]">
            <thead className="bg-[var(--surface-subtle)]">
              <tr>
                <th className="px-2 py-1 text-left">Metric</th>
                <th className="px-2 py-1 text-right">Base</th>
                <th className="px-2 py-1 text-right">Risk-Aware</th>
                <th className="px-2 py-1 text-right">Delta</th>
              </tr>
            </thead>
            <tbody>
              {KPI_ROWS.map(({ key, label, isPercent, lowerIsBetter }) => {
                const base = kpis.base?.[key];
                const risk = kpis.risk?.[key];
                const delta = kpis.delta?.[key];
                const d = fmtDelta(delta, lowerIsBetter);
                return (
                  <tr key={key} className="border-t border-[var(--border-default)]">
                    <td className="px-2 py-1 text-[var(--text-secondary)]">{label}</td>
                    <td className="px-2 py-1 text-right">{fmt(base, isPercent)}</td>
                    <td className="px-2 py-1 text-right">{fmt(risk, isPercent)}</td>
                    <td className={`px-2 py-1 text-right font-medium ${d ? (d.good ? 'text-green-600' : 'text-red-600') : 'text-[var(--text-muted)]'}`}>
                      {d ? d.label : 'N/A'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Key changed SKUs */}
        {keyChanges.length > 0 && (
          <div>
            <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Top Changed SKUs</p>
            <div className="space-y-1">
              {keyChanges.map((change, i) => {
                const delta = Number(change.order_qty_delta ?? change.delta ?? 0);
                const isPositive = delta > 0;
                return (
                  <div
                    key={change.sku_key || i}
                    className={`flex items-center justify-between text-xs px-2 py-1 rounded ${isPositive ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-[var(--surface-subtle)]'}`}
                  >
                    <span className="font-mono text-[var(--text-secondary)]">{change.sku_key || change.material_code || `SKU-${i}`}</span>
                    <span className={`font-medium ${isPositive ? 'text-amber-700 dark:text-amber-400' : 'text-[var(--text-secondary)]'}`}>
                      {isPositive ? '+' : ''}{delta.toFixed(0)} units
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Collapsible rules section */}
        {rulesFired.length > 0 && (
          <div>
            <button
              className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              onClick={() => setRulesOpen((prev) => !prev)}
            >
              {rulesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {rulesFired.length} rule{rulesFired.length !== 1 ? 's' : ''} fired
            </button>
            {rulesOpen && (
              <div className="mt-1 space-y-1">
                {rulesFired.map((rule) => (
                  <div key={rule.rule_id} className="text-xs px-2 py-1 bg-[var(--surface-subtle)] rounded">
                    <span className="font-mono text-amber-700 dark:text-amber-400 mr-1">{rule.rule_id}</span>
                    <span className="text-[var(--text-secondary)]">{rule.description}</span>
                    {rule.applies_to && (
                      <span className="ml-1 text-[var(--text-muted)]">({rule.applies_to} SKUs)</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </Card>
  );
}
