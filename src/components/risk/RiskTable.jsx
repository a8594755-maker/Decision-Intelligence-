/**
 * Risk Dashboard - Risk Table Component（Bucket-Based Version）
 * 
 * 統一名詞：
 * - Days to stockout（Bucket-based 無此概念）
 * - Net available
 * - Gap qty
 * - Next time bucket（取代 Next inbound ETA）
 */

import React, { useState } from 'react';
import { ChevronUp, ChevronDown, Info, Package } from 'lucide-react';
import { getRiskLevelConfig, formatDate, formatNumber } from './mapDomainToUI';
import { formatCurrency } from '../../domains/risk/profitAtRiskCalculator';

const RiskTable = ({
  risks = [],
  selectedRowId,
  onRowSelect,
  loading = false
}) => {
  const [sortConfig, setSortConfig] = useState({
    key: 'profitAtRisk',  // M2: 預設按 Profit at Risk 排序
    direction: 'desc'      // 降序（最大損失在前）
  });

  const sortedRisks = React.useMemo(() => {
    const sorted = [...risks];
    
    if (sortConfig.key) {
      sorted.sort((a, b) => {
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
    
    return sorted;
  }, [risks, sortConfig]);

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
        <div className="text-slate-500">載入資料中...</div>
      </div>
    );
  }

  if (sortedRisks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-500">
        <Package className="w-16 h-16 text-slate-300 dark:text-slate-600 mb-4" />
        <p className="text-lg font-medium">無符合條件的資料</p>
        <p className="text-sm mt-1">請調整篩選條件</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0 z-10">
          <tr>
            <th 
              onClick={() => handleSort('materialCode')}
              className="px-3 py-3 text-left text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <div className="flex items-center gap-1">
                料號
                {renderSortIcon('materialCode')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('plantId')}
              className="px-3 py-3 text-left text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <div className="flex items-center gap-1">
                工廠
                {renderSortIcon('plantId')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('riskLevel')}
              className="px-3 py-3 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <div className="flex items-center justify-center gap-1">
                狀態
                {renderSortIcon('riskLevel')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('netAvailable')}
              className="px-3 py-3 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <div className="flex items-center justify-end gap-1">
                Net available
                {renderSortIcon('netAvailable')}
              </div>
            </th>
            
            <th 
              onClick={() => handleSort('gapQty')}
              className="px-3 py-3 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <div className="flex items-center justify-end gap-1">
                Gap qty
                {renderSortIcon('gapQty')}
              </div>
            </th>
            
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300">
              Next bucket
            </th>
            
            <th 
              onClick={() => handleSort('profitAtRisk')}
              className="px-3 py-3 text-right text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <div className="flex items-center justify-end gap-1">
                Profit at Risk
                {renderSortIcon('profitAtRisk')}
              </div>
            </th>
            
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300">
              操作
            </th>
          </tr>
        </thead>
        
        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
          {sortedRisks.map((risk, index) => {
            const config = getRiskLevelConfig(risk.riskLevel);
            
            // 確保 key 唯一：使用組合 key（item + factory + eta + index）
            const uniqueKey = `${risk.item || 'unknown'}-${risk.plantId || 'unknown'}-${risk.nextInboundEta || 'none'}-${index}`;
            
            return (
              <tr 
                key={uniqueKey} 
                onClick={() => onRowSelect(risk)}
                className={getRowClassName(risk)}
              >
                <td className="px-3 py-2.5 font-medium">
                  {risk.item === '(unknown)' ? (
                    <span 
                      className="text-slate-400 dark:text-slate-500 italic" 
                      title="來源資料缺少料號欄位"
                    >
                      (unknown)
                    </span>
                  ) : (
                    <span className="text-slate-900 dark:text-slate-100">
                      {risk.item}
                    </span>
                  )}
                </td>
                
                <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300">
                  {risk.plantId}
                </td>
                
                <td className="px-3 py-2.5 text-center">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${config.bgColor} ${config.textColor}`}>
                    <span>{config.icon}</span>
                    <span>{config.label}</span>
                  </span>
                </td>
                
                <td className="px-3 py-2.5 text-right text-slate-700 dark:text-slate-300">
                  {formatNumber(risk.netAvailable)}
                </td>
                
                <td className="px-3 py-2.5 text-right">
                  {risk.gapQty > 0 ? (
                    <span className="text-red-600 dark:text-red-400 font-medium">
                      -{formatNumber(risk.gapQty)}
                    </span>
                  ) : (
                    <span className="text-slate-400">0</span>
                  )}
                </td>
                
                <td className="px-3 py-2.5 text-center text-xs text-slate-600 dark:text-slate-400">
                  {risk.nextTimeBucket ? (
                    <span className="font-mono">{risk.nextTimeBucket}</span>
                  ) : (
                    <span className="text-slate-400">N/A</span>
                  )}
                </td>
                
                <td className="px-3 py-2.5 text-right">
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
                        <span className="text-xs text-amber-600 dark:text-amber-400" title="Using assumption">
                          ~
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-slate-400">$0</span>
                  )}
                </td>
                
                <td className="px-3 py-2.5 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRowSelect(risk);
                    }}
                    className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 p-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    title="查看詳情"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default RiskTable;
