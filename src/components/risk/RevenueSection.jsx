import React, { useState, useEffect } from 'react';
import { TrendingUp, AlertCircle, Loader2 } from 'lucide-react';
import { Card, Badge } from '../ui';
import { getRevenueSeriesForKey } from '../../services/revenueForecastService';

/**
 * RevenueSection - Display revenue/margin at risk for a key in Risk Dashboard
 * M6 Gate-R5: Shows bucket breakdown for FG keys
 */
const RevenueSection = ({ 
  userId, 
  materialCode, 
  plantId, 
  revenueRunId,
  summaryData,
  hasRevenueData 
}) => {
  const [seriesData, setSeriesData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Load series data when expanded
  useEffect(() => {
    if (!userId || !revenueRunId || !materialCode || !plantId) return;
    
    const loadSeries = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const result = await getRevenueSeriesForKey(
          userId, 
          revenueRunId, 
          materialCode, 
          plantId
        );
        
        if (result.success) {
          setSeriesData(result.data);
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    loadSeries();
  }, [userId, revenueRunId, materialCode, plantId]);

  // If no revenue data at all
  if (!hasRevenueData) {
    return (
      <Card className="bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-start gap-3 p-4">
          <AlertCircle className="w-5 h-5 text-slate-400 mt-0.5" />
          <div>
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              No Revenue Data for This Key
            </h4>
            <p className="text-sm text-slate-500 mt-1">
              Key {materialCode}|{plantId} was not included in the revenue forecast run.
              <br />
              <span className="text-xs">(MVP v1 only supports FG-level revenue analysis)</span>
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-to-br from-pink-50 to-white dark:from-pink-900/20 dark:to-slate-800">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-pink-500" />
            Revenue Impact Analysis
          </h3>
          {summaryData && (
            <Badge variant="pink" className="text-sm">
              Total: ${summaryData.totalAtRisk?.toLocaleString() || 0}
            </Badge>
          )}
        </div>

        {/* Summary Cards */}
        {summaryData && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-pink-200 dark:border-pink-800">
              <div className="text-sm text-slate-600 dark:text-slate-400">Margin at Risk</div>
              <div className="text-xl font-bold text-rose-600 dark:text-rose-400">
                ${summaryData.marginAtRisk?.toLocaleString() || 0}
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-orange-200 dark:border-orange-800">
              <div className="text-sm text-slate-600 dark:text-slate-400">Penalty at Risk</div>
              <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
                ${summaryData.penaltyAtRisk?.toLocaleString() || 0}
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-red-200 dark:border-red-800">
              <div className="text-sm text-slate-600 dark:text-slate-400">Total at Risk</div>
              <div className="text-xl font-bold text-red-600 dark:text-red-400">
                ${summaryData.totalAtRisk?.toLocaleString() || 0}
              </div>
            </div>
          </div>
        )}

        {/* Bucket Breakdown */}
        <div>
          <h4 className="font-medium text-sm text-slate-700 dark:text-slate-300 mb-2">
            Bucket Breakdown
          </h4>
          
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading bucket data...</span>
            </div>
          ) : error ? (
            <div className="text-red-500 text-sm py-2">
              Failed to load bucket details: {error}
            </div>
          ) : seriesData.length === 0 ? (
            <div className="text-slate-500 text-sm py-2">
              No bucket-level data available
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800">
                  <tr>
                    <th className="px-2 py-1 text-left text-xs font-medium">Bucket</th>
                    <th className="px-2 py-1 text-right text-xs font-medium">Demand</th>
                    <th className="px-2 py-1 text-right text-xs font-medium">Impacted</th>
                    <th className="px-2 py-1 text-right text-xs font-medium">Margin/Unit</th>
                    <th className="px-2 py-1 text-right text-xs font-medium">Margin at Risk</th>
                    <th className="px-2 py-1 text-right text-xs font-medium">Penalty</th>
                    <th className="px-2 py-1 text-right text-xs font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {seriesData.map((row, idx) => (
                    <tr key={idx} className="hover:bg-white/50">
                      <td className="px-2 py-1 font-mono text-xs">{row.time_bucket}</td>
                      <td className="px-2 py-1 text-right">{row.demand_qty?.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right font-semibold">{row.impacted_qty?.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right">${row.margin_per_unit?.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right text-rose-600">
                        ${row.expected_margin_at_risk?.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right text-orange-600">
                        ${row.expected_penalty_at_risk?.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right font-bold text-red-600">
                        ${((row.expected_margin_at_risk || 0) + (row.expected_penalty_at_risk || 0)).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Verification Note */}
        <div className="text-xs text-slate-500 bg-slate-100 dark:bg-slate-800 rounded p-2">
          <strong>Calculation:</strong> Impacted Qty × Margin/Unit = Margin at Risk
          {seriesData.length > 0 && (
            <div className="mt-1">
              Example: {seriesData[0]?.impacted_qty?.toLocaleString()} × ${seriesData[0]?.margin_per_unit} = ${seriesData[0]?.expected_margin_at_risk?.toLocaleString()} ✅
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

export default RevenueSection;
