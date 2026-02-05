/**
 * Risk Dashboard - Details Panel Component（Bucket-Based Version）
 * 
 * 統一名詞：
 * - On hand
 * - Safety stock
 * - Net available
 * - Next time bucket（取代 Days to stockout）
 * - Inbound count/qty in horizon（buckets）
 */

import React, { useState } from 'react';
import { X, Package, AlertCircle, Calendar, TrendingDown, DollarSign, Zap, RotateCcw } from 'lucide-react';
import { getRiskLevelConfig, formatDate, formatNumber } from './mapDomainToUI';
import { formatCurrency } from '../../domains/risk/profitAtRiskCalculator';
import { simulateWhatIfExpedite } from '../../domains/risk/whatIfExpedite';

const DetailsPanel = ({
  details,
  onClose,
  horizonDays = 30
}) => {
  // ========== What-if Simulation State ==========
  const [expediteBuckets, setExpediteBuckets] = useState(1);
  const [simulationResult, setSimulationResult] = useState(null);
  
  // ========== What-if Handlers ==========
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
          點選表格列查看詳細資訊
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
                <span className="text-slate-400 dark:text-slate-500 italic" title="來源資料缺少料號欄位">
                  (unknown)
                </span>
              ) : (
                details.item
              )}
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              工廠: {details.plantId}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
            title="關閉"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* 風險警示 */}
        {details.riskLevel === 'critical' && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-red-900 dark:text-red-100 text-sm mb-1">
                  為什麼是 Critical？
                </div>
                <ul className="text-xs text-red-800 dark:text-red-200 space-y-0.5">
                  {details.reason && (
                    <li>• {details.reason}</li>
                  )}
                  {details.inboundCount === 0 && (
                    <li>• 未來 {horizonDays} 個 bucket 內無入庫</li>
                  )}
                  {details.inboundCount === 1 && (
                    <li>• 未來 {horizonDays} 個 bucket 僅 1 次入庫</li>
                  )}
                  {details.inboundQty < 10 && details.inboundCount > 0 && (
                    <li>• 入庫總量僅 {details.inboundQty}（風險偏高）</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Section 1: 庫存狀況 */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Package className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">庫存狀況</h4>
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
            {/* 公式說明 */}
            <div className="text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
              <div className="font-mono">Net available = On hand - Safety stock</div>
            </div>
          </div>
        </div>

        {/* Section 2: 未來供需（Bucket-Based）*/}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              未來 {horizonDays} buckets 供需
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
                {details.inboundCount || 0} 次
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

        {/* Section 3: 風險指標（Bucket-Based）*/}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">風險指標</h4>
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
              <span className="text-slate-600 dark:text-slate-400">Stockout probability</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {(details.probability * 100).toFixed(0)}%
              </span>
            </div>
            {/* 公式說明 */}
            <div className="text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
              <div className="font-mono">Gap qty = max(0, Safety stock - On hand)</div>
            </div>
          </div>
        </div>

        {/* Section 4: 補貨資訊（Supply Coverage 專屬）*/}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              未來 {horizonDays} 天內 PO 明細
            </h4>
          </div>
          
          {/* PO 統計摘要（Bucket-Based）*/}
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 mb-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Inbound count</span>
              <span className="font-bold text-lg text-blue-600 dark:text-blue-400">
                {details.inboundCount || 0} 次
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
          
          {/* PO Top 5 列表 */}
          {details.poDetails && details.poDetails.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase">
                PO 列表 (Top 5)
              </div>
              {details.poDetails.map((po, idx) => {
                // 確保 key 唯一：使用 poNumber + poLine + timeBucket + idx
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
                  還有 {details.inboundCount - 5} 筆 PO 未顯示
                </div>
              )}
            </div>
          ) : (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <div className="text-sm text-red-800 dark:text-red-200">
                ⚠️ 未來 {horizonDays} buckets 內無 PO
              </div>
              <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                建議盡快確認補貨計畫
              </div>
            </div>
          )}
        </div>

        {/* Section 5: Profit at Risk（M2 貨幣化）*/}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h4 className="font-semibold text-slate-700 dark:text-slate-300">
              Profit at Risk（貨幣化）
            </h4>
          </div>
          
          {/* Profit 來源標籤 */}
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
            {/* 公式說明 */}
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

        {/* Section 6: What-if Simulator（M3 - Expedite）*/}
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
            {/* 控制區 */}
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
              
              {/* 按鈕區 */}
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
            
            {/* 結果顯示 */}
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
                    {/* Changes 說明 */}
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
                    
                    {/* Delta 總結 */}
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
                    
                    {/* 公式說明 */}
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
                    
                    {/* 免責聲明 */}
                    <div className="text-xs text-slate-500 dark:text-slate-400 italic">
                      💡 This is a simplified simulation. Actual results may vary.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer Note */}
        <div className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-200 dark:border-slate-700">
          💡 計算邏輯：
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">domains/risk/coverageCalculator.js</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">profitAtRiskCalculator.js</code>
          +
          <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded mx-1">whatIfExpedite.js (M3)</code>
          <div className="mt-1 text-amber-600 dark:text-amber-400">
            ℹ️ Supply Coverage Risk（不依賴 Forecast）+ Profit at Risk（M2）+ What-if Simulator（M3）
          </div>
        </div>
      </div>
    </div>
  );
};

export default DetailsPanel;
