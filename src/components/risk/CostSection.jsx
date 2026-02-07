/**
 * Milestone 5: Cost Section Component for Risk Details Panel
 * 
 * Displays cost forecast results (expedite/substitution/disruption) 
 * for a selected risk item with fallback message if no cost data available.
 */

import React, { useState, useEffect } from 'react';
import { DollarSign, AlertCircle, TrendingDown, Package, Zap, ArrowRightLeft } from 'lucide-react';
import { Card, Badge } from '../ui';
import { getCostResultsByKey } from '../../services/costForecastService';

const CostSection = ({ 
  userId, 
  materialCode, 
  plantId, 
  costRunId,
  hasCostResults 
}) => {
  const [costData, setCostData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const key = `${materialCode}|${plantId}`;

  useEffect(() => {
    const loadCostData = async () => {
      if (!userId || !costRunId || !materialCode || !plantId) {
        setCostData(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const result = await getCostResultsByKey(userId, costRunId);
        
        if (result.success) {
          const keyData = result.data.find(r => r.key === key);
          setCostData(keyData || null);
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    loadCostData();
  }, [userId, costRunId, materialCode, plantId, key]);

  // Fallback: No cost run available
  if (!hasCostResults && !costRunId) {
    return (
      <Card className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
        <div className="p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
                Cost Forecast Not Available
              </h4>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                No cost forecast has been run for this inventory projection.
              </p>
              <a 
                href="/forecasts?tab=cost_forecast" 
                className="text-sm text-purple-600 hover:text-purple-700 font-medium inline-flex items-center gap-1"
              >
                Go to Forecasts → Cost
                <ArrowRightLeft className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // Loading state
  if (loading) {
    return (
      <Card className="bg-slate-50 dark:bg-slate-800/50">
        <div className="p-4">
          <div className="flex items-center gap-3">
            <div className="animate-spin w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full" />
            <span className="text-slate-600 dark:text-slate-400">Loading cost data...</span>
          </div>
        </div>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
        <div className="p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">
                Error Loading Cost Data
              </h4>
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // No data for this key
  if (!costData) {
    return (
      <Card className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
        <div className="p-4">
          <div className="flex items-start gap-3">
            <Package className="w-5 h-5 text-slate-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
                No Cost Data for This Key
              </h4>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Key <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">{key}</code> was not included in the cost forecast run.
              </p>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // Calculate cheapest action
  const costs = {
    expedite: costData.expedite_cost || 0,
    substitution: costData.substitution_cost || 0,
    disruption: costData.disruption_cost || 0
  };
  
  const cheapestAction = Object.entries(costs).sort((a, b) => a[1] - b[1])[0];
  const totalCost = costs.expedite + costs.substitution + costs.disruption;

  return (
    <Card className="bg-slate-50 dark:bg-slate-800/50">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-green-500" />
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">
              Cost Analysis
            </h3>
          </div>
          {costData.costs && costData.costs[cheapestAction[0]]?.inputs?.pStockout !== undefined && (
            <Badge variant={costData.costs[cheapestAction[0]].inputs.pStockout > 0.2 ? 'red' : 'green'}>
              P(Stockout): {(costData.costs[cheapestAction[0]].inputs.pStockout * 100).toFixed(1)}%
            </Badge>
          )}
        </div>

        {/* Cost Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Expedite */}
          <div className={`p-3 rounded-lg border ${
            cheapestAction[0] === 'expedite' 
              ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30' 
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Zap className={`w-4 h-4 ${cheapestAction[0] === 'expedite' ? 'text-blue-500' : 'text-slate-400'}`} />
                <span className="text-sm font-medium">Expedite</span>
              </div>
              {cheapestAction[0] === 'expedite' && (
                <Badge variant="blue" className="text-xs">Best</Badge>
              )}
            </div>
            <div className="text-xl font-bold">${costs.expedite.toLocaleString()}</div>
            {costData.costs?.expedite?.breakdown && (
              <div className="text-xs text-slate-500 mt-1">
                {costData.costs.expedite.breakdown.quantity?.toLocaleString()} × ${costData.costs.expedite.breakdown.unit_cost}
              </div>
            )}
          </div>

          {/* Substitution */}
          <div className={`p-3 rounded-lg border ${
            cheapestAction[0] === 'substitution' 
              ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/30' 
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <ArrowRightLeft className={`w-4 h-4 ${cheapestAction[0] === 'substitution' ? 'text-amber-500' : 'text-slate-400'}`} />
                <span className="text-sm font-medium">Substitution</span>
              </div>
              {cheapestAction[0] === 'substitution' && (
                <Badge variant="amber" className="text-xs">Best</Badge>
              )}
            </div>
            <div className="text-xl font-bold">${costs.substitution.toLocaleString()}</div>
            {costData.costs?.substitution?.breakdown && (
              <div className="text-xs text-slate-500 mt-1">
                Fixed: ${costData.costs.substitution.breakdown.fixed_cost?.toLocaleString()}
              </div>
            )}
          </div>

          {/* Disruption */}
          <div className={`p-3 rounded-lg border ${
            cheapestAction[0] === 'disruption' 
              ? 'border-red-400 bg-red-50 dark:bg-red-900/30' 
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <TrendingDown className={`w-4 h-4 ${cheapestAction[0] === 'disruption' ? 'text-red-500' : 'text-slate-400'}`} />
                <span className="text-sm font-medium">Disruption</span>
              </div>
              {cheapestAction[0] === 'disruption' && (
                <Badge variant="red" className="text-xs">Best</Badge>
              )}
            </div>
            <div className="text-xl font-bold">${costs.disruption.toLocaleString()}</div>
            {costData.costs?.disruption?.breakdown && (
              <div className="text-xs text-slate-500 mt-1">
                P(Stockout): {(costData.costs.disruption.breakdown.p_stockout_applied * 100).toFixed(1)}%
              </div>
            )}
          </div>
        </div>

        {/* Total & Recommendation */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-700">
          <div>
            <span className="text-sm text-slate-600 dark:text-slate-400">Total Cost:</span>
            <span className="ml-2 text-lg font-bold text-slate-900 dark:text-slate-100">${totalCost.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600 dark:text-slate-400">Recommended:</span>
            <Badge 
              variant={
                cheapestAction[0] === 'expedite' ? 'blue' : 
                cheapestAction[0] === 'substitution' ? 'amber' : 'red'
              }
              className="capitalize"
            >
              {cheapestAction[0]}
            </Badge>
            <span className="text-sm font-medium text-green-600">
              Save ${(Math.max(...Object.values(costs)) - cheapestAction[1]).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Inputs Summary */}
        {costData.costs?.expedite?.inputs && (
          <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
            <div className="text-xs text-slate-500 space-y-1">
              <div className="flex gap-4">
                <span>Shortage: <strong>{costData.costs.expedite.inputs.shortageQty?.toLocaleString() || 0}</strong></span>
                <span>Expected Min: <strong>{costData.costs.expedite.inputs.expectedMinAvailable?.toLocaleString() || 'N/A'}</strong></span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

export default CostSection;
