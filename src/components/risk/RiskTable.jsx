/**
 * Risk Dashboard - Risk Table Component（Bucket-Based Version）
 * 
 * Unified terminology:
 * - Days to stockout (not applicable in Bucket-based)
 * - Net available
 * - Gap qty
 * - Next time bucket (replaces Next inbound ETA)
 */

import React, { useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, Info, Package } from 'lucide-react';
import { getRiskLevelConfig, formatNumber } from './mapDomainToUI';
import { formatCurrency } from '../../domains/risk/profitAtRiskCalculator';

const RISK_ROW_HEIGHT = 33;
const VIRTUALIZE_THRESHOLD = 50;
const COL_COUNT = 16;

const RiskTable = ({
  risks = [],
  selectedRowId,
  onRowSelect,
  loading = false,
  probResults = {} // Step 2: P0 - Probabilistic results map
}) => {
  const [sortConfig, setSortConfig] = useState({
    key: 'profitAtRisk',  // M2: Default sort by Profit at Risk
    direction: 'desc'      // Descending (largest loss first)
  });

  const parentRef = useRef(null);

  const sortedRisks = React.useMemo(() => {
    // Merge probResults into risks
    const merged = risks.map(risk => {
      const key = `${risk.item}|${risk.plantId}`;
      const prob = probResults[key];
      if (prob) {
        return {
          ...risk,
          pStockout: prob.p_stockout,
          stockoutBucketP50: prob.stockout_bucket_p50,
          stockoutBucketP90: prob.stockout_bucket_p90,
          expectedShortage: prob.expected_shortage_qty,
          expectedMinAvailable: prob.expected_min_available,
          trials: prob.trials,
          seed: prob.seed
        };
      }
      return risk;
    });

    if (sortConfig.key) {
      merged.sort((a, b) => {
        let aVal = a[sortConfig.key];
        let bVal = b[sortConfig.key];
        
        if (sortConfig.key === 'daysToStockout') {
          aVal = aVal === Infinity ? 999999 : aVal;
          bVal = bVal === Infinity ? 999999 : bVal;
        }
        
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    
    return merged;
  }, [risks, probResults, sortConfig]);

  const shouldVirtualize = sortedRisks.length >= VIRTUALIZE_THRESHOLD;

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is required here for large risk tables
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? sortedRisks.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => RISK_ROW_HEIGHT,
    overscan: 15,
  });

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const renderSortIcon = (key) => {
    if (sortConfig.key !== key) {
      return <ChevronUp className="w-3 h-3 text-slate-300" />;
    }
    return sortConfig.direction === 'asc' 
      ? <ChevronUp className="w-3 h-3 text-blue-600" />
      : <ChevronDown className="w-3 h-3 text-blue-600" />;
  };

  const getRowClassName = (risk) => {
    const isSelected = selectedRowId === risk.id;
    const config = getRiskLevelConfig(risk.riskLevel);
    
    let baseClass = 'cursor-pointer transition-colors';
    
    if (isSelected) {
      return `${baseClass} ${config.lightBg} ${config.darkLightBg} border-l-4 ${config.borderColor}`;
    }
    
    if (risk.riskLevel === 'critical') {
      return `${baseClass} hover:bg-red-50 dark:hover:bg-red-900/10`;
    } else if (risk.riskLevel === 'warning') {
      return `${baseClass} hover:bg-yellow-50 dark:hover:bg-yellow-900/10`;
    }
    
    return `${baseClass} hover:bg-slate-50 dark:hover:bg-slate-800/50`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-slate-500">Loading data...</div>
      </div>
    );
  }

  if (sortedRisks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-500">
        <Package className="w-16 h-16 text-slate-300 dark:text-slate-600 mb-4" />
        <p className="text-lg font-medium">No matching data</p>
        <p className="text-sm mt-1">Please adjust filter criteria</p>
      </div>
    );
  }

  const renderRiskRow = (risk, index) => {
    const config = getRiskLevelConfig(risk.riskLevel);
    const uniqueKey = `${risk.item || 'unknown'}-${risk.plantId || 'unknown'}-${risk.nextInboundEta || 'none'}-${index}`;

    return (
      <tr
        key={uniqueKey}
        onClick={() => onRowSelect(risk)}
        className={getRowClassName(risk)}
      >
        <td className="px-3 py-1.5 font-medium sticky left-0 z-10 bg-white dark:bg-slate-800 border-r border-slate-100 dark:border-slate-700/50 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
          {risk.item === '(unknown)' ? (
            <span className="text-slate-400 dark:text-slate-500 italic" title="Source data missing material code field">(unknown)</span>
          ) : (
            <span className="text-slate-900 dark:text-slate-100">{risk.item}</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300 sticky left-[140px] z-10 bg-white dark:bg-slate-800 border-r border-slate-100 dark:border-slate-700/50">
          {risk.plantId}
        </td>
        <td className="px-2 py-1.5 text-center sticky left-[220px] z-10 bg-white dark:bg-slate-800 border-r border-slate-100 dark:border-slate-700/50">
          <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${config.bgColor} ${config.textColor}`}>
            <span>{config.icon}</span>
            <span>{config.label}</span>
          </span>
        </td>
        <td className="px-2 py-1.5 text-right text-slate-700 dark:text-slate-300">
          {formatNumber(risk.netAvailable)}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.gapQty > 0 ? (
            <span className="text-red-600 dark:text-red-400 font-medium">-{formatNumber(risk.gapQty)}</span>
          ) : (
            <span className="text-slate-400">0</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right text-slate-700 dark:text-slate-300">
          {typeof risk.daysToStockout === 'number' && risk.daysToStockout !== Infinity ? `${risk.daysToStockout} days` : '—'}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.pStockout !== undefined && risk.pStockout !== null ? (
            <span className={`font-medium ${
              risk.pStockout > 0.5 ? 'text-red-600 dark:text-red-400' :
              risk.pStockout > 0.2 ? 'text-amber-600 dark:text-amber-400' :
              'text-green-600 dark:text-green-400'
            }`}>
              {(risk.pStockout * 100).toFixed(1)}%
            </span>
          ) : (
            <span className="text-slate-400" title="Run Monte Carlo in Forecasts→Inventory">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-center text-slate-600 dark:text-slate-400">
          {risk.nextTimeBucket ? <span className="font-mono">{risk.nextTimeBucket}</span> : <span className="text-slate-400">N/A</span>}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.profitAtRisk > 0 ? (
            <div className="flex flex-col items-end">
              <span className={`font-semibold ${
                risk.riskLevel === 'critical' ? 'text-red-600 dark:text-red-400' :
                risk.riskLevel === 'warning' ? 'text-yellow-600 dark:text-yellow-400' :
                'text-slate-700 dark:text-slate-300'
              }`}>
                {formatCurrency(risk.profitAtRisk, risk.currency)}
              </span>
              {risk.profitAtRiskReason === 'ASSUMPTION' && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400" title="Using assumption">~</span>
              )}
            </div>
          ) : (
            <span className="text-slate-400">$0</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-center">
          {(() => {
            const q = risk.dataQualityLevel || 'missing';
            const cfg = {
              verified: { dot: 'bg-green-500', label: 'Verified', title: 'All data from real sources' },
              partial:  { dot: 'bg-blue-500',  label: 'Partial',  title: 'One field uses fallback' },
              estimated:{ dot: 'bg-amber-500', label: 'Est.',     title: 'Multiple fields use fallbacks' },
              missing:  { dot: 'bg-red-500',   label: 'Missing',  title: 'No financial data available' },
            }[q] || { dot: 'bg-slate-400', label: '?', title: 'Unknown' };
            const aCount = risk.assumptionCount || 0;
            return (
              <span className="inline-flex items-center gap-1" title={cfg.title}>
                <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                <span className="text-[10px] text-slate-500 dark:text-slate-400">{cfg.label}</span>
                {aCount > 0 && (
                  <span className="text-[9px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 px-1 rounded-full font-semibold" title={`${aCount} assumption(s)`}>
                    {aCount}
                  </span>
                )}
              </span>
            );
          })()}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.revMarginAtRisk != null ? (
            <span className={`font-semibold ${risk.revMarginAtRisk > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'}`}>
              ${risk.revMarginAtRisk.toLocaleString()}
            </span>
          ) : (
            <span className="text-slate-300" title="No revenue data / not FG key">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.revPenaltyAtRisk != null ? (
            <span className={risk.revPenaltyAtRisk > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-slate-400'}>
              ${risk.revPenaltyAtRisk.toLocaleString()}
            </span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.revTotalAtRisk != null ? (
            <span className={`font-bold ${risk.revTotalAtRisk > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-400'}`}>
              ${risk.revTotalAtRisk.toLocaleString()}
            </span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.riskScore != null ? (
            <span className={`font-bold ${
              risk.riskScore > 10000 ? 'text-red-600 dark:text-red-400' :
              risk.riskScore > 1000 ? 'text-orange-600 dark:text-orange-400' :
              risk.riskScore > 0 ? 'text-purple-600 dark:text-purple-400' :
              'text-slate-400'
            }`}>
              {risk.riskScore > 0 ? risk.riskScore.toLocaleString() : '0'}
            </span>
          ) : (
            <span className="text-slate-300" title="Click 'Calculate Risk Scores' to compute">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right">
          {risk.decisionRankingScore != null ? (
            <span className={`font-bold text-xs ${
              risk.decisionRankingScore > 0.7 ? 'text-red-600 dark:text-red-400' :
              risk.decisionRankingScore > 0.4 ? 'text-orange-600 dark:text-orange-400' :
              'text-slate-500 dark:text-slate-400'
            }`}>
              {risk.decisionRankingScore.toFixed(2)}
            </span>
          ) : (
            <span className="text-slate-300">--</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-center">
          <div className="flex items-center gap-1 justify-center">
            {risk.topAction && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-active)] text-[var(--brand-600)] font-medium truncate max-w-[60px]"
                title={risk.topAction.description}
              >
                {risk.topAction.title.split(' ').slice(0, 2).join(' ')}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onRowSelect(risk); }}
              className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 p-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20"
              title="View details"
            >
              <Info className="w-4 h-4" />
            </button>
          </div>
        </td>
      </tr>
    );
  };

  const tableHead = (
    <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0 z-10">
      <tr>
            <th 
              onClick={() => handleSort('materialCode')}
              className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 sticky left-0 z-20 bg-slate-100 dark:bg-slate-800 w-[140px] min-w-[140px]"
            >
              <div className="flex items-center gap-1">
                Material
                {renderSortIcon('materialCode')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('plantId')}
              className="px-2 py-2 text-left text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 sticky left-[140px] z-20 bg-slate-100 dark:bg-slate-800 w-[80px] min-w-[80px]"
            >
              <div className="flex items-center gap-1">
                Plant
                {renderSortIcon('plantId')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('riskLevel')}
              className="px-2 py-2 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 sticky left-[220px] z-20 bg-slate-100 dark:bg-slate-800 w-[70px] min-w-[70px]"
            >
              <div className="flex items-center justify-center gap-1">
                Status
                {renderSortIcon('riskLevel')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('netAvailable')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[85px] min-w-[85px]"
            >
              <div className="flex items-center justify-end gap-1">
                Net Avail
                {renderSortIcon('netAvailable')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('gapQty')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[75px] min-w-[75px]"
            >
              <div className="flex items-center justify-end gap-1">
                Gap
                {renderSortIcon('gapQty')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('daysToStockout')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[80px] min-w-[80px]"
              title="Displayed when Forecast Run is selected and component_demand is available"
            >
              <div className="flex items-center justify-end gap-1">
                Days Left
                {renderSortIcon('daysToStockout')}
              </div>
            </th>

            <th 
              onClick={() => handleSort('pStockout')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[70px] min-w-[70px]"
              title="Monte Carlo P(stockout) from probabilistic forecast"
            >
              <div className="flex items-center justify-end gap-1">
                P(Stock)
                {renderSortIcon('pStockout')}
              </div>
            </th>
            
            <th className="px-2 py-2 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 w-[85px] min-w-[85px]">
              Next Bkt
            </th>
            
            <th
              onClick={() => handleSort('profitAtRisk')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[95px] min-w-[95px]"
            >
              <div className="flex items-center justify-end gap-1">
                Profit @ Risk
                {renderSortIcon('profitAtRisk')}
              </div>
            </th>

            <th
              onClick={() => handleSort('dataQualityLevel')}
              className="px-2 py-2 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[60px] min-w-[60px]"
              title="Data quality: verified / partial / estimated / missing"
            >
              <div className="flex items-center justify-center gap-1">
                Quality
                {renderSortIcon('dataQualityLevel')}
              </div>
            </th>

            <th className="px-2 py-2 text-right text-xs font-semibold uppercase text-rose-600 dark:text-rose-400 w-[85px] min-w-[85px]">
              Rev Margin
            </th>
            
            <th className="px-2 py-2 text-right text-xs font-semibold uppercase text-orange-600 dark:text-orange-400 w-[85px] min-w-[85px]">
              Rev Penalty
            </th>
            
            <th className="px-2 py-2 text-right text-xs font-semibold uppercase text-red-600 dark:text-red-400 w-[85px] min-w-[85px]">
              Rev Total
            </th>
            
            <th 
              onClick={() => handleSort('riskScore')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-purple-600 dark:text-purple-400 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[70px] min-w-[70px]"
            >
              <div className="flex items-center justify-end gap-1">
                Score
                {renderSortIcon('riskScore')}
              </div>
            </th>
            
            <th
              onClick={() => handleSort('decisionRankingScore')}
              className="px-2 py-2 text-right text-xs font-semibold uppercase text-[var(--brand-600)] cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 w-[55px] min-w-[55px]"
            >
              <div className="flex items-center justify-end gap-1">
                Rank
                {renderSortIcon('decisionRankingScore')}
              </div>
            </th>

            <th className="px-2 py-2 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 w-[100px] min-w-[100px]">
              Actions
            </th>
          </tr>
        </thead>
    );

  if (shouldVirtualize) {
    const virtualRows = virtualizer.getVirtualItems();
    return (
      <div ref={parentRef} className="overflow-auto risk-table-scroll" style={{ maxHeight: 600 }}>
        <table className="w-full text-xs border-collapse">
          {tableHead}
          <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
            {virtualRows.length > 0 && (
              <tr style={{ height: virtualRows[0].start }}>
                <td colSpan={COL_COUNT} style={{ padding: 0, border: 'none' }} />
              </tr>
            )}
            {virtualRows.map((vr) => renderRiskRow(sortedRisks[vr.index], vr.index))}
            {virtualRows.length > 0 && (
              <tr style={{ height: virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end }}>
                <td colSpan={COL_COUNT} style={{ padding: 0, border: 'none' }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto risk-table-scroll">
      <table className="w-full text-xs border-collapse">
        {tableHead}
        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
          {sortedRisks.map((risk, index) => renderRiskRow(risk, index))}
        </tbody>
      </table>
    </div>
  );
};

export default RiskTable;
