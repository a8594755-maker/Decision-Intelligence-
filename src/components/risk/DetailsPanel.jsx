/**
 * Risk Dashboard - Details Panel Component（Bucket-Based Version）
 * 
 * Unified terminology:
 * - On hand
 * - Safety stock
 * - Net available
 * - Next time bucket (replaces Days to stockout)
 * - Inbound count/qty in horizon (buckets)
 */

import React, { useState } from 'react';
import { X, Package, AlertCircle, Calendar, TrendingDown, DollarSign, Zap, RotateCcw } from 'lucide-react';
import { getRiskLevelConfig, formatDate, formatNumber } from './mapDomainToUI';
import { formatCurrency } from '../../domains/risk/profitAtRiskCalculator';
import { simulateWhatIfExpedite } from '../../domains/risk/whatIfExpedite';
import ProbabilisticSection from './ProbabilisticSection';
import CostSection from './CostSection';
import RevenueSection from './RevenueSection';
import RiskScoreSection from './RiskScoreSection';
import WhatIfSection from './WhatIfSection';
import ComputationTraceSection from './ComputationTraceSection';
import ActionsSection from './ActionsSection';

const DetailsPanel = ({
  details,
  user, // M7.2: User object for What-if service
  onClose,
  horizonDays = 30,
  activeForecastRun = null,
  probSeries = null, // Step 2: P0 - Prob series data
  loadProbSeriesForKey = null, // Step 2: P0 - Function to load series
  hasProbResults = false, // Step 2: P0 - Whether prob results exist
  revenueState = { mode: 'none', summaryByKey: {} }, // M6 Gate-R5: Revenue data
  riskScoreData = null, // M7 Gate-7.1: Risk score from parent
  replayDraft = null // M7.3 WP3: Replay draft for What-if
}) => {
  // ========== What-if Simulation State ==========
  const [expediteBuckets, setExpediteBuckets] = useState(1);
  const [simulationResult, setSimulationResult] = useState(null);
  const [whatIfResult, setWhatIfResult] = useState(null);
  const [_runningWhatIf, setRunningWhatIf] = useState(false);
  
  // ========== What-if Handlers ==========
  const handleRunWhatIf = async (action) => {
    if (!details || !activeForecastRun?.id) return;
    
    setRunningWhatIf(true);
    try {
      const { runWhatIf } = await import('../../services/planning/whatIfService');
      
      const keyContext = {
        materialCode: details.item,
        plantId: details.plantId,
        onHand: details.onHand || 0,
        safetyStock: details.safetyStock || 0,
        gapQty: details.gapQty || 0,
        nextStockoutBucket: details.nextTimeBucket,
        inboundLines: details.poDetails?.map(po => ({
          poNumber: po.poNumber,
          bucket: po.timeBucket,
          qty: po.qty
        })) || []
      };
      
      const result = await runWhatIf(
        user?.id, // Use user.id from prop
        activeForecastRun.id,
        keyContext,
        action
      );
      
      if (result.success) {
        setWhatIfResult(result);
      }
    } catch (error) {
      console.error('What-if failed:', error);
    } finally {
      setRunningWhatIf(false);
    }
  };
  
  const handleSimulate = () => {
    if (!details || !details.poDetails || details.poDetails.length === 0) {
      setSimulationResult({
        success: false,
        reason: 'NO_INBOUND'
      });
      return;
    }
    
    const result = simulateWhatIfExpedite({
      poLines: details.poDetails,
      rowContext: {
        item: details.item,
        factory: details.plantId,
        onHand: details.onHand || 0,
        safetyStock: details.safetyStock || 0,
        profitPerUnit: details.profitPerUnit || 10
      },
      expediteBuckets,
      horizonBuckets: horizonDays
    });
    
    setSimulationResult(result);
  };
  
  const handleReset = () => {
    setSimulationResult(null);
  };
  
  if (!details) {
    return (
      <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 p-6 flex flex-col items-center justify-center h-full min-h-[400px]">
        <Package className="w-16 h-16 text-slate-300 dark:text-slate-600 mb-4" />
        <p className="text-slate-500 dark:text-slate-400 text-center">
          Click a table row to view details
        </p>
      </div>
    );
  }

  const config = getRiskLevelConfig(details.riskLevel);

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg h-full overflow-y-auto">
      {/* Header */}
      <div className={`sticky top-0 ${config.lightBg} ${config.darkLightBg} border-b border-slate-200 dark:border-slate-700 p-4 z-10`}>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${config.bgColor} ${config.textColor}`}>
                {config.icon} {config.label}
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
              {details.item === '(unknown)' ? (
                <span className="text-slate-400 dark:text-slate-500 italic" title="Source data missing material code field">
                  (unknown)
                </span>
              ) : (
                details.item
              )}
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Plant: {details.plantId}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* Traceability: Forecast Run */}
        {activeForecastRun && (
          <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/50 rounded-lg p-2">
            <span className="font-medium text-slate-600 dark:text-slate-300">Forecast Run:</span>{' '}
            {activeForecastRun.scenario_name || 'baseline'} ({String(activeForecastRun.id).slice(0, 8)}…)
            <br />
            <span>Go to Planning → Forecasts, select the corresponding BOM Explosion batch → Trace to view FG→Component traceability</span>
          </div>
        )}
        {/* Risk Alert */}
        {details.riskLevel === 'critical' && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-red-900 dark:text-red-100 text-sm mb-1">
                  Why is it Critical?
                </div>
                <ul className="text-xs text-red-800 dark:text-red-200 space-y-0.5">
                  {details.reason && (
                    <li>• {details.reason}</li>
                  )}
                  {details.inboundCount === 0 && (
                    <li>• No inbound within next {horizonDays} buckets</li>
                  )}
                  {details.inboundCount === 1 && (
                    <li>• Only 1 inbound within next {horizonDays} buckets</li>
                  )}
                  {details.inboundQty < 10 && details.inboundCount > 0 && (
                    <li>• Total inbound qty only {details.inboundQty} (higher risk)</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Section 1: Inventory Status */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Package className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">Inventory Status</h4>
          </div>
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">On hand</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatNumber(details.onHand)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Safety stock</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatNumber(details.safetyStock)}
              </span>
            </div>
            <div className="border-t border-slate-200 dark:border-slate-700 pt-2 flex justify-between text-sm">
              <span className="text-slate-700 dark:text-slate-300 font-medium">Net available</span>
              <span className={`font-bold ${
                details.netAvailable < 0 
                  ? 'text-red-600 dark:text-red-400' 
                  : 'text-green-600 dark:text-green-400'
              }`}>
                {formatNumber(details.netAvailable)}
              </span>
            </div>
            {/* Formula explanation */}
            <div className="text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
              <div className="font-mono">Net available = On hand - Safety stock</div>
            </div>
          </div>
        </div>

        {/* Section 2: Future Supply & Demand (Bucket-Based) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              Next {horizonDays} Buckets Supply & Demand
            </h4>
          </div>
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Current bucket</span>
              <span className="font-mono text-xs text-slate-900 dark:text-slate-100">
                {details.currentBucket || 'N/A'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Horizon buckets</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {horizonDays}
              </span>
            </div>
            <div className="border-t border-slate-200 dark:border-slate-700 pt-2 flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Inbound count (horizon)</span>
              <span className={`font-bold text-lg ${
                details.inboundCount === 0 ? 'text-red-600 dark:text-red-400' :
                details.inboundCount === 1 ? 'text-yellow-600 dark:text-yellow-400' :
                'text-blue-600 dark:text-blue-400'
              }`}>
                {details.inboundCount || 0}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Inbound qty (horizon)</span>
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                +{formatNumber(details.inboundQty || 0)}
              </span>
            </div>
          </div>
        </div>

        {/* Section 3: Risk Indicators (Bucket-Based) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">Risk Indicators</h4>
          </div>
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Next time bucket</span>
              <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                {details.nextTimeBucket || 'N/A'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Risk status</span>
              <span className={`font-bold ${
                details.riskLevel === 'critical' ? 'text-red-600 dark:text-red-400' :
                details.riskLevel === 'warning' ? 'text-yellow-600 dark:text-yellow-400' :
                'text-green-600 dark:text-green-400'
              }`}>
                {details.status || 'OK'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Gap qty</span>
              <span className={`font-semibold ${
                details.gapQty > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'
              }`}>
                {details.gapQty > 0 ? `-${formatNumber(details.gapQty)}` : '0'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Days to stockout</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {typeof details.daysToStockout === 'number' && details.daysToStockout !== Infinity
                  ? `${details.daysToStockout} days`
                  : '—'}
              </span>
            </div>
            {details.shortageDate && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-400">Shortage date</span>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {formatDate(details.shortageDate)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Stockout probability</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {(details.probability * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Lead time (used for this P(stockout))</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {details.leadTimeDaysUsed != null ? `${details.leadTimeDaysUsed} days` : '—'}
                {details.leadTimeDaysSource === 'fallback' && (
                  <span className="ml-1 text-amber-600 dark:text-amber-400 text-xs" title="No supplier lead_time_days, using system default">(default)</span>
                )}
              </span>
            </div>
            {/* Formula explanation */}
            <div className="text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
              <div className="font-mono">Gap qty = max(0, Safety stock - On hand)</div>
              {typeof details.daysToStockout === 'number' && details.daysToStockout !== Infinity && (
                <div className="font-mono mt-0.5">Days to stockout / P(stockout) from Inventory domain (component_demand)</div>
              )}
              <div className="mt-0.5">Lead time source: {details.leadTimeDaysSource === 'supplier' ? 'suppliers.lead_time_days' : 'System default (7 days)'}</div>
            </div>
          </div>
        </div>

        {/* Section 4: Replenishment Info (Supply Coverage) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              PO Details within Next {horizonDays} Buckets
            </h4>
          </div>
          
          {/* PO Summary (Bucket-Based) */}
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 mb-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Inbound count</span>
              <span className="font-bold text-lg text-blue-600 dark:text-blue-400">
                {details.inboundCount || 0}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Total inbound qty</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatNumber(details.inboundQty || 0)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Next bucket</span>
              <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                {details.nextTimeBucket || 'N/A'}
              </span>
            </div>
          </div>
          
          {/* PO List (Top 5) */}
          {details.poDetails && details.poDetails.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase">
                PO List (Top 5)
              </div>
              {details.poDetails.map((po, idx) => {
                // Ensure unique key: use poNumber + poLine + timeBucket + idx
                const poKey = `${po.poNumber}-${po.poLine || ''}-${po.timeBucket}-${idx}`;
                
                return (
                  <div 
                    key={poKey}
                    className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5"
                  >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                      {po.poNumber}
                      {po.poLine && <span className="ml-1 text-slate-400">-{po.poLine}</span>}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                      #{idx + 1}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
                      <Calendar className="w-3.5 h-3.5" />
                      <span className="font-mono text-xs">{po.timeBucket}</span>
                    </div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      Qty: {formatNumber(po.qty)}
                    </div>
                  </div>
                </div>
                );
              })}
              
              {details.inboundCount > 5 && (
                <div className="text-xs text-center text-slate-500 dark:text-slate-400 pt-1">
                  {details.inboundCount - 5} more POs not shown
                </div>
              )}
            </div>
          ) : (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <div className="text-sm text-red-800 dark:text-red-200">
                ⚠️ No PO within next {horizonDays} buckets
              </div>
              <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                Recommend confirming replenishment plan as soon as possible
              </div>
            </div>
          )}
        </div>

        {/* Section 5: Profit at Risk (M2 Monetization) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              Profit at Risk (Monetization)
            </h4>
          </div>
          
          {/* Profit source label */}
          <div className="mb-2">
            {details.profitAtRiskReason === 'REAL' && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                ✓ Real financials
              </span>
            )}
            {details.profitAtRiskReason === 'ASSUMPTION' && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                ~ Assumption
              </span>
            )}
            {details.profitAtRiskReason === 'MISSING' && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400">
                ⚠ Missing financials
              </span>
            )}
          </div>
          
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Profit per unit</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatCurrency(details.profitPerUnit || 0, details.currency)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Exposure qty</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatNumber(details.exposureQty || 0)}
              </span>
            </div>
            <div className="border-t border-slate-200 dark:border-slate-700 pt-2 flex justify-between text-sm">
              <span className="text-slate-700 dark:text-slate-300 font-medium">Profit at Risk</span>
              <span className={`font-bold text-lg ${
                details.profitAtRisk > 0 
                  ? 'text-red-600 dark:text-red-400' 
                  : 'text-slate-900 dark:text-slate-100'
              }`}>
                {formatCurrency(details.profitAtRisk || 0, details.currency)}
              </span>
            </div>
            {/* Formula explanation */}
            <div className="text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
              <div className="font-mono">profitAtRisk = max(0, gapQty) * profitPerUnit</div>
              {details.profitAtRiskReason === 'MISSING' && (
                <div className="text-amber-600 dark:text-amber-400 mt-1">
                  ⚠️ Missing financials for this item
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section 5.5: Data Confidence & Assumptions */}
        {details.assumptions && details.assumptions.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="w-4 h-4 text-slate-600 dark:text-slate-400" />
              <h4 className="font-semibold text-slate-700 dark:text-slate-300 flex-1">
                Data Confidence
              </h4>
              {details.confidence_score != null && (
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  details.confidence_score >= 0.8 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                  details.confidence_score >= 0.5 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
                  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                }`}>
                  {Math.round(details.confidence_score * 100)}%
                </span>
              )}
            </div>
            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-2">
              {details.assumptions.map((a, idx) => (
                <div key={a.field} className={`flex items-start gap-2 text-xs ${idx > 0 ? 'pt-2 border-t border-slate-200 dark:border-slate-700' : ''}`}>
                  <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                    a.source === 'missing' ? 'bg-red-500' : a.isDefault ? 'bg-amber-500' : 'bg-green-500'
                  }`} />
                  <div className="flex-1">
                    <div className="font-medium text-slate-700 dark:text-slate-300">
                      {a.field} = {a.value ?? 'N/A'}
                      {a.source === 'missing' && <span className="ml-1 text-red-600 dark:text-red-400">(missing)</span>}
                      {a.isDefault && a.source !== 'missing' && <span className="ml-1 text-amber-600 dark:text-amber-400">(default)</span>}
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">{a.note}</div>
                    {a.impact && a.impact.sensitivityNote && (
                      <div className={`mt-0.5 ${
                        a.impact.severity === 'high' ? 'text-red-600 dark:text-red-400' :
                        a.impact.severity === 'medium' ? 'text-amber-600 dark:text-amber-400' :
                        'text-slate-400 dark:text-slate-500'
                      }`}>
                        {a.impact.sensitivityNote}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Section 5.6: Computation Trace */}
        <ComputationTraceSection trace={details.computationTrace} />

        {/* Section 5.7: Recommended Actions */}
        <ActionsSection
          actions={details.recommendedActions || []}
          decisionRankingScore={details.decisionRankingScore}
        />

        {/* Section 6: What-if Simulator (M3 - Expedite) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              What-if Simulator
            </h4>
            <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs font-semibold rounded">
              MVP
            </span>
          </div>
          
          <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-3 space-y-3">
            {/* Controls */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block">
                Scenario: Expedite earliest inbound
              </label>
              <div className="flex gap-2">
                <select
                  value={expediteBuckets}
                  onChange={(e) => setExpediteBuckets(parseInt(e.target.value, 10))}
                  className="flex-1 px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-purple-500"
                  disabled={simulationResult !== null}
                >
                  <option value={1}>Expedite by 1 bucket</option>
                  <option value={2}>Expedite by 2 buckets</option>
                  <option value={3}>Expedite by 3 buckets</option>
                </select>
              </div>
              
              {/* Buttons */}
              <div className="flex gap-2">
                {!simulationResult ? (
                  <button
                    onClick={handleSimulate}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    <Zap className="w-4 h-4" />
                    Simulate
                  </button>
                ) : (
                  <button
                    onClick={handleReset}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-600 hover:bg-slate-700 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Reset
                  </button>
                )}
              </div>
            </div>
            
            {/* Results */}
            {simulationResult && (
              <div className="pt-3 border-t border-purple-300 dark:border-purple-700">
                {!simulationResult.success ? (
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-2.5">
                    <div className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                      ⚠️ No inbound to expedite
                    </div>
                    <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      This item has no PO within available horizon.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Changes description */}
                    <div className="bg-white dark:bg-slate-800 rounded-lg p-2 text-xs">
                      <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                        📦 Simulated Change:
                      </div>
                      <div className="text-slate-600 dark:text-slate-400 space-y-0.5">
                        <div>
                          <span className="font-medium">Expedite earliest inbound:</span>
                          <div className="ml-2 mt-0.5">
                            <span className="font-mono text-purple-600 dark:text-purple-400">{simulationResult.changes.fromBucket}</span>
                            {' → '}
                            <span className="font-mono text-purple-600 dark:text-purple-400">{simulationResult.changes.toBucket}</span>
                            <span className="ml-1 text-slate-500">(qty: {formatNumber(simulationResult.changes.qty)})</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Before vs After */}
                    <div className="grid grid-cols-2 gap-2">
                      {/* Before */}
                      <div className="bg-slate-100 dark:bg-slate-700/50 rounded-lg p-2">
                        <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                          Before
                        </div>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">Status</span>
                            <span className={`font-semibold ${
                              simulationResult.before.status === 'CRITICAL' ? 'text-red-600' :
                              simulationResult.before.status === 'WARNING' ? 'text-yellow-600' : 'text-green-600'
                            }`}>
                              {simulationResult.before.status}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">Next</span>
                            <span className="font-mono text-xs font-semibold">{simulationResult.before.nextBucket || 'N/A'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">Inbound(H3)</span>
                            <span className="font-semibold">{formatNumber(simulationResult.before.inboundQtyWithinHorizon)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400 text-xs" title="Base Gap (Safety - On hand)">Base Gap</span>
                            <span className={`font-semibold ${
                              simulationResult.before.baseGapQty > 0 ? 'text-red-600' : 'text-green-600'
                            }`}>
                              {formatNumber(simulationResult.before.baseGapQty)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400 text-xs" title="Effective Gap (after inbound in horizon)">Eff. Gap</span>
                            <span className={`font-semibold ${
                              simulationResult.before.effectiveGap > 0 ? 'text-red-600' : 'text-green-600'
                            }`}>
                              {formatNumber(simulationResult.before.effectiveGap)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">P@R</span>
                            <span className="font-semibold">{formatCurrency(simulationResult.before.profitAtRisk)}</span>
                          </div>
                        </div>
                      </div>
                      
                      {/* After */}
                      <div className="bg-green-100 dark:bg-green-900/30 rounded-lg p-2">
                        <div className="text-xs font-semibold text-green-700 dark:text-green-300 mb-1.5">
                          After
                        </div>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">Status</span>
                            <span className={`font-semibold ${
                              simulationResult.after.status === 'CRITICAL' ? 'text-red-600' :
                              simulationResult.after.status === 'WARNING' ? 'text-yellow-600' : 'text-green-600'
                            }`}>
                              {simulationResult.after.status}
                              {simulationResult.delta.statusImproved && (
                                <span className="ml-1 text-green-600">↑</span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">Next</span>
                            <span className="font-mono text-xs font-semibold">{simulationResult.after.nextBucket || 'N/A'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">Inbound(H3)</span>
                            <span className={`font-semibold ${
                              simulationResult.delta.inboundQtyWithinHorizonDelta > 0 ? 'text-green-600' : 'text-slate-900'
                            }`}>
                              {formatNumber(simulationResult.after.inboundQtyWithinHorizon)}
                              {simulationResult.delta.inboundQtyWithinHorizonDelta !== 0 && (
                                <span className="ml-0.5 text-xs">
                                  ({simulationResult.delta.inboundQtyWithinHorizonDelta > 0 ? '+' : ''}{formatNumber(simulationResult.delta.inboundQtyWithinHorizonDelta)})
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400 text-xs" title="Base Gap (Safety - On hand)">Base Gap</span>
                            <span className={`font-semibold ${
                              simulationResult.after.baseGapQty > 0 ? 'text-red-600' : 'text-green-600'
                            }`}>
                              {formatNumber(simulationResult.after.baseGapQty)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400 text-xs" title="Effective Gap (after inbound in horizon)">Eff. Gap</span>
                            <span className={`font-semibold ${
                              simulationResult.after.effectiveGap > 0 ? 'text-red-600' : 'text-green-600'
                            }`}>
                              {formatNumber(simulationResult.after.effectiveGap)}
                              {simulationResult.delta.effectiveGapDelta !== 0 && (
                                <span className={`ml-0.5 text-xs ${
                                  simulationResult.delta.effectiveGapDelta < 0 ? 'text-green-600' : 'text-red-600'
                                }`}>
                                  ({simulationResult.delta.effectiveGapDelta > 0 ? '+' : ''}{formatNumber(simulationResult.delta.effectiveGapDelta)})
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-600 dark:text-slate-400">P@R</span>
                            <span className={`font-semibold ${
                              simulationResult.delta.profitAtRiskDelta < 0 ? 'text-green-600' : 'text-red-600'
                            }`}>
                              {formatCurrency(simulationResult.after.profitAtRisk)}
                              {simulationResult.delta.profitAtRiskDelta !== 0 && (
                                <span className="ml-0.5 text-xs font-bold">
                                  ({simulationResult.delta.profitAtRiskDelta > 0 ? '+' : ''}{formatCurrency(simulationResult.delta.profitAtRiskDelta)})
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Delta Summary */}
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-2">
                      <div className="text-xs font-semibold text-blue-900 dark:text-blue-100 mb-1">
                        📊 Impact Summary
                      </div>
                      <div className="space-y-0.5 text-xs text-blue-800 dark:text-blue-200">
                        {simulationResult.delta.statusImproved ? (
                          <div>✅ Status improved: {simulationResult.before.status} → {simulationResult.after.status}</div>
                        ) : simulationResult.delta.statusChanged ? (
                          <div>⚠️ Status changed: {simulationResult.before.status} → {simulationResult.after.status}</div>
                        ) : (
                          <div>➡️ Status unchanged: {simulationResult.before.status}</div>
                        )}
                        
                        <div>
                          Inbound in Horizon: 
                          <span className={`ml-1 font-semibold ${
                            simulationResult.delta.inboundQtyWithinHorizonDelta > 0 ? 'text-green-600' : 'text-slate-600'
                          }`}>
                            {simulationResult.delta.inboundQtyWithinHorizonDelta >= 0 ? '+' : ''}{formatNumber(simulationResult.delta.inboundQtyWithinHorizonDelta)}
                          </span>
                        </div>
                        
                        <div>
                          Effective Gap: 
                          <span className={`ml-1 font-semibold ${
                            simulationResult.delta.effectiveGapDelta < 0 ? 'text-green-600' : 
                            simulationResult.delta.effectiveGapDelta > 0 ? 'text-red-600' : 'text-slate-600'
                          }`}>
                            {simulationResult.delta.effectiveGapDelta >= 0 ? '+' : ''}{formatNumber(simulationResult.delta.effectiveGapDelta)}
                          </span>
                        </div>
                        
                        <div>
                          Profit at Risk: 
                          <span className={`ml-1 font-bold ${
                            simulationResult.delta.profitAtRiskDelta < 0 ? 'text-green-600' : 
                            simulationResult.delta.profitAtRiskDelta > 0 ? 'text-red-600' : 'text-slate-600'
                          }`}>
                            {simulationResult.delta.profitAtRiskDelta >= 0 ? '+' : ''}{formatCurrency(simulationResult.delta.profitAtRiskDelta)}
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    {/* Formula explanation */}
                    <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-2">
                      <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                        📐 Calculation Formula
                      </div>
                      <div className="space-y-0.5 text-xs font-mono text-slate-600 dark:text-slate-400">
                        <div>baseGap = max(0, safetyStock - onHand)</div>
                        <div>effectiveGap = max(0, baseGap - inboundQtyInHorizon)</div>
                        <div>profitAtRisk = effectiveGap * profitPerUnit</div>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 pt-1 border-t border-slate-200 dark:border-slate-700">
                        <span className="font-medium">Horizon starts from:</span>{' '}
                        {simulationResult.before.nextBucket || simulationResult.after.nextBucket || 'derived from earliest inbound'}
                      </div>
                    </div>
                    
                    {/* Disclaimer */}
                    <div className="text-xs text-slate-500 dark:text-slate-400 italic">
                      💡 This is a simplified simulation. Actual results may vary.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Section 6.5: Probabilistic Forecast Fan Chart (Step 2: P0) */}
        <ProbabilisticSection
          details={details}
          probSeries={probSeries}
          loadProbSeries={loadProbSeriesForKey}
          hasProbResults={hasProbResults}
        />

        {/* Section 6.6: Cost Forecast Analysis (Milestone 5) */}
        <CostSection
          userId={details?.userId}
          materialCode={details?.item}
          plantId={details?.plantId}
          costRunId={activeForecastRun?.id}
          hasCostResults={!!activeForecastRun?.id}
        />

        {/* Section 6.7: Revenue at Risk Analysis (Milestone 6 Gate-R5) */}
        <RevenueSection
          userId={details?.userId}
          materialCode={details?.item}
          plantId={details?.plantId}
          revenueRunId={activeForecastRun?.id}
          summaryData={revenueState.summaryByKey?.[`${details?.item}|${details?.plantId}`]}
          hasRevenueData={!!revenueState.summaryByKey?.[`${details?.item}|${details?.plantId}`]}
        />

        {/* Section 6.8: Risk Score Analysis (Milestone 7 Gate-7.1) */}
        <RiskScoreSection
          userId={details?.userId}
          materialCode={details?.item}
          plantId={details?.plantId}
          forecastRunId={activeForecastRun?.id}
          riskScoreData={riskScoreData}
        />

        {/* Section 6.9: What-if Simulator (Milestone 7.2 WP2) */}
        <WhatIfSection
          userId={details?.userId}
          materialCode={details?.item}
          plantId={details?.plantId}
          bomRunId={activeForecastRun?.id}
          keyContext={{
            onHand: details?.onHand,
            safetyStock: details?.safetyStock,
            gapQty: details?.gapQty,
            inboundLines: details?.poDetails?.map(po => ({
              poNumber: po.poNumber,
              bucket: po.timeBucket,
              qty: po.qty
            })),
            pStockout: riskScoreData?.pStockout || (details?.gapQty > 0 ? 1.0 : 0.0),
            impactUsd: riskScoreData?.impactUsd || 0
          }}
          onRunWhatIf={handleRunWhatIf}
          result={whatIfResult}
          replayDraft={replayDraft} // M7.3 WP3: Replay draft
        />

        {/* Footer Note */}
        <div className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-200 dark:border-slate-700">
          💡 Calculation logic:
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">domains/risk/coverageCalculator.js</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">profitAtRiskCalculator.js</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">whatIfExpedite.js (M3)</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">inventoryProbForecast.js (4-B Monte Carlo)</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">costForecast.js (M5)</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">revenueForecast.js (M6)</code>
          <div className="mt-1 text-amber-600 dark:text-amber-400">
            ℹ️ Supply Coverage Risk + Profit at Risk (M2) + What-if Simulator (M3) + Probabilistic Forecast (4-B) + Cost Forecast (M5) + Revenue at Risk (M6)
          </div>
        </div>
      </div>
    </div>
  );
};

export default DetailsPanel;
