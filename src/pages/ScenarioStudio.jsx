/**
 * Scenario Studio
 *
 * Dedicated page for comparing baseline vs multiple what-if scenarios.
 * Users can create scenarios with parameter overrides and see KPI deltas.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitCompare, Plus, Play, Trash2, TrendingUp, TrendingDown, Minus,
  ArrowLeft, ChevronDown, AlertCircle
} from 'lucide-react';
import { Card, Badge, Button } from '../components/ui';
import { runWhatIfScenario } from '../domains/risk/whatIfEngine';

const SCENARIO_TEMPLATES = [
  {
    id: 'exclude_po',
    label: 'Without Open POs',
    description: 'What if all pending POs are removed?',
    action: { type: 'exclude_open_po', scope: 'all' },
  },
  {
    id: 'demand_20',
    label: 'Demand +20%',
    description: 'What if demand spikes by 20%?',
    action: { type: 'stressed_demand', demandMultiplier: 1.2, scope: 'all' },
  },
  {
    id: 'demand_50',
    label: 'Demand +50%',
    description: 'Stress test: 50% demand increase',
    action: { type: 'stressed_demand', demandMultiplier: 1.5, scope: 'all' },
  },
  {
    id: 'lt_7',
    label: 'Lead Time +7 days',
    description: 'What if lead times increase by 1 week?',
    action: { type: 'lead_time_stress', leadTimeDelta: 7, scope: 'all' },
  },
  {
    id: 'lt_14',
    label: 'Lead Time +14 days',
    description: 'What if lead times increase by 2 weeks?',
    action: { type: 'lead_time_stress', leadTimeDelta: 14, scope: 'all' },
  },
  {
    id: 'expedite_1',
    label: 'Expedite 1 Bucket',
    description: 'Shift all inbound 1 bucket earlier',
    action: { type: 'expedite', byBuckets: 1, scope: 'all' },
  },
];

function DeltaBadge({ before, after, lowerIsBetter = false, format = 'number' }) {
  if (before == null || after == null) return <span className="text-slate-400">--</span>;
  const delta = after - before;
  if (delta === 0) return <span className="text-slate-400 flex items-center gap-0.5"><Minus className="w-3 h-3" /> No change</span>;

  const isGood = lowerIsBetter ? delta < 0 : delta > 0;
  const color = isGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  const Icon = delta > 0 ? TrendingUp : TrendingDown;
  const sign = delta > 0 ? '+' : '';

  let formatted;
  if (format === 'percent') formatted = `${sign}${(delta * 100).toFixed(1)}%`;
  else if (format === 'currency') formatted = `${sign}$${Math.abs(delta).toLocaleString()}`;
  else formatted = `${sign}${delta.toFixed(2)}`;

  return (
    <span className={`flex items-center gap-0.5 ${color}`}>
      <Icon className="w-3 h-3" />
      {formatted}
    </span>
  );
}

function ScenarioCard({ scenario, onRemove }) {
  const result = scenario.result;
  return (
    <Card className="!p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{scenario.label}</h3>
          <p className="text-xs text-slate-500">{scenario.description}</p>
        </div>
        <button onClick={onRemove} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-500">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {result ? (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-slate-500">P(Stockout)</span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-medium">{((result.after?.pStockout || 0) * 100).toFixed(1)}%</span>
              <DeltaBadge
                before={result.before?.pStockout}
                after={result.after?.pStockout}
                lowerIsBetter
                format="percent"
              />
            </div>
          </div>
          <div>
            <span className="text-slate-500">Impact (USD)</span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-medium">${(result.after?.impactUsd || 0).toLocaleString()}</span>
              <DeltaBadge
                before={result.before?.impactUsd}
                after={result.after?.impactUsd}
                lowerIsBetter
                format="currency"
              />
            </div>
          </div>
          <div>
            <span className="text-slate-500">Risk Score</span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-medium">{(result.after?.score || 0).toFixed(0)}</span>
              <DeltaBadge before={result.before?.score} after={result.after?.score} lowerIsBetter />
            </div>
          </div>
          <div>
            <span className="text-slate-500">ROI</span>
            <div className="mt-0.5">
              <span className={`font-bold ${result.roi > 0 ? 'text-emerald-600' : result.roi < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                {result.roi > 0 ? '+' : ''}{(result.roi * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <AlertCircle className="w-4 h-4" />
          Click "Run Scenarios" to compute results
        </div>
      )}

      {result?.after?.note && (
        <p className="text-[10px] text-slate-400 italic">{result.after.note}</p>
      )}
    </Card>
  );
}

export default function ScenarioStudio() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState([]);
  const [baselineInput, setBaselineInput] = useState({
    materialCode: 'SAMPLE-001',
    plantId: 'P1',
    onHand: 500,
    safetyStock: 100,
    gapQty: 200,
    pStockout: 0.7,
    impactUsd: 50000,
    costUsd: 0,
    inboundLines: [
      { poNumber: 'PO-001', bucket: '2026-W12', qty: 150 },
    ],
  });

  const addScenario = useCallback((template) => {
    setScenarios(prev => [...prev, {
      id: `${template.id}_${Date.now()}`,
      label: template.label,
      description: template.description,
      action: template.action,
      result: null,
    }]);
  }, []);

  const removeScenario = useCallback((id) => {
    setScenarios(prev => prev.filter(s => s.id !== id));
  }, []);

  const runAllScenarios = useCallback(() => {
    setScenarios(prev => prev.map(s => ({
      ...s,
      result: runWhatIfScenario(baselineInput, s.action),
    })));
  }, [baselineInput]);

  const baselineResult = useMemo(() => {
    return {
      pStockout: baselineInput.pStockout,
      impactUsd: baselineInput.impactUsd,
      score: baselineInput.pStockout * baselineInput.impactUsd,
      costUsd: baselineInput.costUsd,
    };
  }, [baselineInput]);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="w-5 h-5 text-slate-500" />
          </button>
          <div>
            <p className="text-xs font-semibold tracking-widest uppercase text-indigo-500">WHAT-IF</p>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              Scenario Studio
            </h1>
          </div>
        </div>

        {/* Baseline + Scenarios grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Baseline column */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Baseline</h2>
            <Card className="!p-4 border-2 border-indigo-200 dark:border-indigo-800 space-y-3">
              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-slate-500">On Hand</label>
                    <input
                      type="number"
                      value={baselineInput.onHand}
                      onChange={e => setBaselineInput(prev => ({ ...prev, onHand: Number(e.target.value) }))}
                      className="w-full mt-0.5 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-slate-500">Safety Stock</label>
                    <input
                      type="number"
                      value={baselineInput.safetyStock}
                      onChange={e => setBaselineInput(prev => ({ ...prev, safetyStock: Number(e.target.value) }))}
                      className="w-full mt-0.5 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-slate-500">Gap Qty</label>
                    <input
                      type="number"
                      value={baselineInput.gapQty}
                      onChange={e => setBaselineInput(prev => ({ ...prev, gapQty: Number(e.target.value) }))}
                      className="w-full mt-0.5 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-slate-500">Impact (USD)</label>
                    <input
                      type="number"
                      value={baselineInput.impactUsd}
                      onChange={e => setBaselineInput(prev => ({ ...prev, impactUsd: Number(e.target.value) }))}
                      className="w-full mt-0.5 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-slate-700 text-xs">
                <div>
                  <span className="text-slate-500">P(Stockout)</span>
                  <div className="font-medium mt-0.5">{(baselineResult.pStockout * 100).toFixed(1)}%</div>
                </div>
                <div>
                  <span className="text-slate-500">Risk Score</span>
                  <div className="font-medium mt-0.5">{baselineResult.score.toFixed(0)}</div>
                </div>
              </div>
            </Card>

            {/* Scenario templates */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Add Scenario</h3>
              {SCENARIO_TEMPLATES.map(tmpl => (
                <button
                  key={tmpl.id}
                  onClick={() => addScenario(tmpl)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-left transition-colors"
                >
                  <Plus className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{tmpl.label}</span>
                    <p className="text-[10px] text-slate-400 truncate">{tmpl.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Scenarios column (2/3 width) */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Scenarios ({scenarios.length})
              </h2>
              {scenarios.length > 0 && (
                <Button variant="primary" size="sm" onClick={runAllScenarios}>
                  <Play className="w-4 h-4 mr-1" />
                  Run All Scenarios
                </Button>
              )}
            </div>

            {scenarios.length === 0 ? (
              <Card className="!p-8 text-center">
                <GitCompare className="w-12 h-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
                <p className="text-sm text-slate-500">No scenarios yet</p>
                <p className="text-xs text-slate-400 mt-1">
                  Add scenarios from the templates on the left to compare against the baseline.
                </p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {scenarios.map(s => (
                  <ScenarioCard
                    key={s.id}
                    scenario={s}
                    onRemove={() => removeScenario(s.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
