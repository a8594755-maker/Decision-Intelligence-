import React, { useState } from 'react';
import { AlertTriangle, DollarSign, CheckCircle, XCircle, Shield } from 'lucide-react';
import { Card, Badge, Button } from '../ui';

/**
 * RiskReplanCard
 *
 * Displays a "risk-triggered re-plan recommendation" card in the chat thread.
 * Lets the user approve / dismiss a solver re-run with risk-adjusted params.
 */
export default function RiskReplanCard({ payload, onDecision }) {
  const [decided, setDecided] = useState(false);
  const [decidedOption, setDecidedOption] = useState(null);

  if (!payload) return null;

  const { trigger, recommended_params, benefit, decision_options, status } = payload;
  const isCompleted = decided || status !== 'pending';

  const handleDecision = (option) => {
    setDecided(true);
    setDecidedOption(option.id);
    onDecision?.({
      action: option.action,
      params: option.params,
      datasetProfileId: trigger.dataset_profile_id,
      sourceCardRunId: trigger.source_risk_run_id,
    });
  };

  return (
    <Card className="border-l-4 border-orange-500 bg-gradient-to-br from-orange-50 to-white dark:from-orange-900/20 dark:to-slate-800">
      <div className="space-y-4">

        {/* Header */}
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-6 h-6 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-lg text-orange-800 dark:text-orange-300">
              Risk Detected: Re-plan Recommended
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              {recommended_params.reason}
            </p>
          </div>
        </div>

        {/* Risk summary metrics */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white dark:bg-slate-700 rounded-lg p-3 text-center border border-slate-200 dark:border-slate-600">
            <div className="text-2xl font-bold text-orange-600">{trigger.high_risk_sku_count}</div>
            <div className="text-xs text-slate-500 mt-1">High-risk SKUs</div>
          </div>
          <div className="bg-white dark:bg-slate-700 rounded-lg p-3 text-center border border-slate-200 dark:border-slate-600">
            <div className="text-2xl font-bold text-red-600">{trigger.max_risk_score}</div>
            <div className="text-xs text-slate-500 mt-1">Max Risk Score</div>
          </div>
          <div className="bg-white dark:bg-slate-700 rounded-lg p-3 text-center border border-slate-200 dark:border-slate-600">
            <div className="text-2xl font-bold text-green-600">
              -{benefit.estimated_stockout_reduction_pct}%
            </div>
            <div className="text-xs text-slate-500 mt-1">Est. Stockout Reduction</div>
          </div>
        </div>

        {/* High-risk SKU list (top 5) */}
        {trigger.high_risk_skus?.length > 0 && (
          <div>
            <div className="text-xs font-medium text-slate-500 mb-2">High-risk SKU Details</div>
            <div className="space-y-1">
              {trigger.high_risk_skus.map((sku, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between text-sm bg-white dark:bg-slate-700 rounded px-3 py-1.5 border border-slate-200 dark:border-slate-600"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={sku.risk_score > 80 ? 'danger' : 'warning'} className="text-xs">
                      {sku.risk_score}
                    </Badge>
                    <span className="font-mono text-xs">{sku.sku}</span>
                    {sku.plant_id && (
                      <span className="text-xs text-slate-400">@ {sku.plant_id}</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    P(stockout)={((sku.p_stockout ?? 0) * 100).toFixed(0)}%
                    {sku.impact_usd > 0 && (
                      <span className="ml-2 text-red-500">${sku.impact_usd.toLocaleString()}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommended params */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-medium text-blue-800 dark:text-blue-300">Recommended Parameters</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-slate-500">Safety stock factor: </span>
              <span className="font-semibold text-blue-700 dark:text-blue-300">
                {recommended_params.safety_stock_alpha}x
              </span>
            </div>
            <div>
              <span className="text-slate-500">Stockout penalty multiplier: </span>
              <span className="font-semibold text-blue-700 dark:text-blue-300">
                {recommended_params.stockout_penalty_multiplier}x
              </span>
            </div>
          </div>
        </div>

        {/* Benefit estimate */}
        <div className="flex items-center gap-2 text-sm">
          <DollarSign className="w-4 h-4 text-green-500" />
          <span className="text-slate-600 dark:text-slate-400">
            Est. net benefit:{' '}
            <span className={`font-semibold ml-1 ${benefit.estimated_net_benefit_usd >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {benefit.estimated_net_benefit_usd >= 0 ? '+' : ''}
              ${Math.abs(benefit.estimated_net_benefit_usd).toLocaleString()} USD
            </span>
            <span className="text-xs text-slate-400 ml-1">
              (avoided stockout ${benefit.estimated_stockout_avoidance_usd?.toLocaleString()} - holding cost ${benefit.estimated_holding_cost_increase_usd?.toLocaleString()})
            </span>
          </span>
        </div>

        {/* Decision buttons */}
        {!isCompleted ? (
          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
            {decision_options?.map((option) => (
              <Button
                key={option.id}
                variant={option.variant === 'primary' ? 'default' : option.variant === 'warning' ? 'outline' : 'ghost'}
                size="sm"
                onClick={() => handleDecision(option)}
                className={
                  option.variant === 'warning'
                    ? 'border-orange-400 text-orange-700 hover:bg-orange-50'
                    : ''
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
            {decidedOption === 'dismiss' ? (
              <XCircle className="w-4 h-4 text-slate-400" />
            ) : (
              <CheckCircle className="w-4 h-4 text-green-500" />
            )}
            <span className="text-sm text-slate-500">
              {decidedOption === 'dismiss' ? 'Recommendation dismissed' : 'Approved — re-planning in progress...'}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
