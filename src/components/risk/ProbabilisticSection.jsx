/**
 * Probabilistic Section - Monte Carlo Fan Chart for Risk Dashboard
 * Step 2: P0 - Shows P(stockout), inv_p10/p50/p90 per bucket
 */

import React, { useState, useEffect } from 'react';
import { TrendingUp, AlertCircle, Loader2 } from 'lucide-react';
import { formatNumber } from './mapDomainToUI';

const ProbabilisticSection = ({
  details,
  probSeries,
  loadProbSeries,
  hasProbResults
}) => {
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const key = `${details?.item}|${details?.plantId}`;

  // Load series when component mounts or key changes
  useEffect(() => {
    if (!details?.item || !details?.plantId || !loadProbSeries) return;
    
    const loadData = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await loadProbSeries(details.item, details.plantId);
        setSeries(data || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    // Check if we already have cached series
    if (probSeries && probSeries[key]) {
      setSeries(probSeries[key]);
    } else if (hasProbResults) {
      loadData();
    }
  }, [details?.item, details?.plantId, loadProbSeries, probSeries, key, hasProbResults]);

  // Determine if this row has prob data in summary
  const hasProbData = details?.pStockout !== undefined && details?.pStockout !== null;

  if (!hasProbResults) {
    return (
      <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <h4 className="font-semibold text-slate-700 dark:text-slate-300">
            Monte Carlo Forecast
          </h4>
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">
          No probabilistic results yet. 
          <br />
          <span className="text-xs">
            Go to <strong>Forecasts → Inventory → Probabilistic (Monte Carlo)</strong> to run simulation.
          </span>
        </div>
      </div>
    );
  }

  if (!hasProbData) {
    return (
      <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <h4 className="font-semibold text-slate-700 dark:text-slate-300">
            Monte Carlo Forecast
          </h4>
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">
          This key was not included in the Monte Carlo simulation (limited to top keys by shortage).
        </div>
      </div>
    );
  }

  return (
    <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 border border-purple-200 dark:border-purple-800">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="w-4 h-4 text-purple-600 dark:text-purple-400" />
        <h4 className="font-semibold text-purple-700 dark:text-purple-300">
          Monte Carlo Forecast (Trials: {details.trials || 200}, Seed: {details.seed || 'N/A'})
        </h4>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-white dark:bg-slate-800 rounded p-2">
          <div className="text-xs text-slate-500 dark:text-slate-400">P(Stockout)</div>
          <div className={`text-lg font-bold ${
            details.pStockout > 0.5 ? 'text-red-600' :
            details.pStockout > 0.2 ? 'text-amber-600' :
            'text-green-600'
          }`}>
            {(details.pStockout * 100).toFixed(1)}%
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded p-2">
          <div className="text-xs text-slate-500 dark:text-slate-400">Expected Shortage</div>
          <div className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {formatNumber(details.expectedShortage || 0)}
          </div>
        </div>
      </div>

      {/* Stockout Buckets */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-amber-50 dark:bg-amber-900/20 rounded p-2">
          <div className="text-xs text-amber-600 dark:text-amber-400">Stockout P50</div>
          <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            {details.stockoutBucketP50 || 'No stockout'}
          </div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded p-2">
          <div className="text-xs text-red-600 dark:text-red-400">Stockout P90</div>
          <div className="text-sm font-semibold text-red-700 dark:text-red-300">
            {details.stockoutBucketP90 || 'No stockout'}
          </div>
        </div>
      </div>

      {/* Fan Chart Table */}
      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-purple-500" />
          <span className="ml-2 text-sm text-slate-500">Loading series...</span>
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 py-2">
          <AlertCircle className="w-4 h-4 inline mr-1" />
          Error loading series: {error}
        </div>
      ) : series.length > 0 ? (
        <div>
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
            Inventory Fan Chart
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-white dark:bg-slate-800">
                <tr>
                  <th className="px-2 py-1 text-left">Bucket</th>
                  <th className="px-2 py-1 text-right">P10</th>
                  <th className="px-2 py-1 text-right">P50</th>
                  <th className="px-2 py-1 text-right">P90</th>
                  <th className="px-2 py-1 text-right">P(Stockout)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                {series.map((s, idx) => (
                  <tr 
                    key={idx}
                    className={s.p_stockout_bucket > 0.5 ? 'bg-red-50 dark:bg-red-900/10' : 
                               s.p_stockout_bucket > 0.2 ? 'bg-amber-50 dark:bg-amber-900/10' : ''}
                  >
                    <td className="px-2 py-1 font-mono">{s.time_bucket}</td>
                    <td className="px-2 py-1 text-right text-slate-600">{formatNumber(s.inv_p10)}</td>
                    <td className="px-2 py-1 text-right font-semibold">{formatNumber(s.inv_p50)}</td>
                    <td className="px-2 py-1 text-right text-slate-600">{formatNumber(s.inv_p90)}</td>
                    <td className="px-2 py-1 text-right">
                      <span className={s.p_stockout_bucket > 0.5 ? 'text-red-600 font-semibold' :
                                     s.p_stockout_bucket > 0.2 ? 'text-amber-600' : 'text-green-600'}>
                        {(s.p_stockout_bucket * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-500 py-2">
          No series data available for this key.
        </div>
      )}

      {/* Bloodline Info */}
      {details.trials && (
        <div className="mt-3 pt-2 border-t border-purple-200 dark:border-purple-700 text-xs text-slate-500 dark:text-slate-400">
          Monte Carlo with lognormal demand sampling and 2-point arrival mixing.
        </div>
      )}
    </div>
  );
};

export default ProbabilisticSection;
