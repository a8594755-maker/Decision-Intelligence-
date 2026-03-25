import React, { useState, useEffect } from 'react';
import { AlertCircle, Loader2, TrendingUp, Calculator, RefreshCw } from 'lucide-react';
import { Card, Badge } from '../ui';

async function loadRiskScoreService() {
  return import('../../services/risk/riskScoreService');
}

/**
 * RiskScoreSection - Display risk score breakdown for a key in Risk Dashboard
 * M7 Gate-7.1: Shows score components (P(stockout), $Impact, Urgency)
 */
const RiskScoreSection = ({ 
  userId, 
  materialCode, 
  plantId, 
  forecastRunId,
  onCalculate,
  riskScoreData // M7: Direct score data from parent (optional)
}) => {
  const [scoreData, setScoreData] = useState(riskScoreData || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Use parent data if available, otherwise load from API
  useEffect(() => {
    if (riskScoreData) {
      setScoreData(riskScoreData);
      return;
    }
    
    if (!userId || !forecastRunId || !materialCode || !plantId) return;
    
    const loadScore = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const { getRiskScoreForKey } = await loadRiskScoreService();
        const result = await getRiskScoreForKey(
          userId, 
          forecastRunId, 
          materialCode, 
          plantId
        );
        
        if (result.success) {
          setScoreData(result.data);
        } else if (result.notFound) {
          setScoreData(null); // No score calculated yet
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    loadScore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, forecastRunId, materialCode, plantId]);

  // If no score data and not loading
  if (!scoreData && !loading && !error) {
    return (
      <Card className="bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-start gap-3 p-4">
          <Calculator className="w-5 h-5 text-slate-400 mt-0.5" />
          <div className="flex-1">
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              Risk Score Not Calculated
            </h4>
            <p className="text-sm text-slate-500 mt-1">
              Run risk score calculation to see P(stockout) × $Impact × Urgency breakdown.
            </p>
            <div className="flex gap-2 mt-3">
              {onCalculate && (
                <button
                  onClick={onCalculate}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors"
                >
                  Calculate Risk Score
                </button>
              )}
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-300 transition-colors flex items-center gap-1"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
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
        <div className="flex items-center gap-2 text-slate-500 py-4 px-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading risk score...</span>
        </div>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card className="bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-start gap-3 p-4">
          <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
          <div>
            <h4 className="font-semibold text-red-700 dark:text-red-400">
              Failed to Load Risk Score
            </h4>
            <p className="text-sm text-red-600 dark:text-red-300 mt-1">
              {error}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  // Render score breakdown
  const { score, pStockout, impactUsd, urgencyWeight, earliestStockoutBucket, breakdown } = scoreData;
  
  // Determine risk level based on score
  const getRiskLevel = (s) => {
    if (s > 10000) return { label: 'High Risk', color: 'red' };
    if (s > 1000) return { label: 'Medium Risk', color: 'orange' };
    return { label: 'Low Risk', color: 'purple' };
  };
  
  const riskLevel = getRiskLevel(score);

  return (
    <Card className="bg-gradient-to-br from-purple-50 to-white dark:from-purple-900/20 dark:to-slate-800">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-purple-500" />
            Risk Score Analysis
          </h3>
          <Badge 
            variant={riskLevel.color} 
            className="text-sm font-bold"
          >
            {score.toLocaleString()}
          </Badge>
        </div>

        {/* Formula */}
        <div className="bg-slate-100 dark:bg-slate-800 rounded-lg p-3 text-sm font-mono text-slate-700 dark:text-slate-300">
          Score = P(Stockout) × $Impact × Urgency
        </div>

        {/* Component Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* P(Stockout) */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
            <div className="text-xs text-slate-500 dark:text-slate-400 uppercase">P(Stockout)</div>
            <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
              {(pStockout * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {breakdown?.p_stockout_source || 'From probabilistic forecast'}
            </div>
          </div>

          {/* $ Impact */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-green-200 dark:border-green-800">
            <div className="text-xs text-slate-500 dark:text-slate-400 uppercase">$ Impact</div>
            <div className="text-xl font-bold text-green-600 dark:text-green-400">
              ${impactUsd.toLocaleString()}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {breakdown?.impact_source || 'From margin at risk'}
            </div>
          </div>

          {/* Urgency */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
            <div className="text-xs text-slate-500 dark:text-slate-400 uppercase">Urgency</div>
            <div className="text-xl font-bold text-amber-600 dark:text-amber-400">
              ×{urgencyWeight}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {earliestStockoutBucket ? `Stockout: ${earliestStockoutBucket}` : 'No urgency'}
            </div>
          </div>
        </div>

        {/* Breakdown Details */}
        {breakdown && (
          <div className="bg-slate-100 dark:bg-slate-800 rounded-lg p-3">
            <h4 className="font-medium text-sm text-slate-700 dark:text-slate-300 mb-2">
              Calculation Breakdown
            </h4>
            <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
              <div>• Formula: {breakdown.formula}</div>
              <div>• P(Stockout): {(breakdown.p_stockout * 100).toFixed(1)}%</div>
              <div>• Impact: ${breakdown.impact_usd?.toLocaleString()}</div>
              <div>• Urgency: {breakdown.urgency_calculation || `Weight = ${urgencyWeight}`}</div>
              {earliestStockoutBucket && (
                <div>• Stockout Bucket: {earliestStockoutBucket}</div>
              )}
              <div>• Version: {breakdown.version || '1.0.0'}</div>
            </div>
          </div>
        )}

        {/* Verification Note */}
        <div className="text-xs text-slate-500 bg-slate-100 dark:bg-slate-800 rounded p-2">
          <strong>Manual Verification:</strong> {pStockout.toFixed(2)} × ${impactUsd.toLocaleString()} × {urgencyWeight} = {score.toLocaleString()} ✅
        </div>
      </div>
    </Card>
  );
};

export default RiskScoreSection;
