/**
 * Risk Dashboard - KPI Cards Component
 * 
 * Unified terminology: All data derived from parent uiRows
 */

import React from 'react';
import { AlertTriangle, TrendingDown, DollarSign, Clock } from 'lucide-react';
import { Card } from '../ui';

const KPICards = ({
  criticalCount = 0,
  _warningCount = 0,
  shortageWithinHorizon = 0,
  profitAtRisk = 0,
  criticalProfitAtRisk = 0,
  totalItems = 0,
  dataSnapshotTime = null,
  horizonDays = 30,
  itemsWithRealFinancials = 0,
  itemsWithAssumption = 0,
  usingFallback = false
}) => {
  const formatTime = (date) => {
    if (!date) return 'Loading...';
    const d = new Date(date);
    if (isNaN(d.getTime())) return 'Unknown';
    
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hour}:${minute}`;
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Card 1: Critical Items */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-3xl font-bold text-red-600 dark:text-red-400">
              {criticalCount}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Critical Risk Items
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {totalItems} materials total
            </div>
          </div>
          <div className="bg-red-100 dark:bg-red-900/30 p-3 rounded-lg">
            <AlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400" />
          </div>
        </div>
      </Card>

      {/* Card 2: Shortage within Horizon */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-3xl font-bold text-yellow-600 dark:text-yellow-400">
              {shortageWithinHorizon}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Risk within {horizonDays} buckets
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              CRITICAL + WARNING
            </div>
          </div>
          <div className="bg-yellow-100 dark:bg-yellow-900/30 p-3 rounded-lg">
            <TrendingDown className="w-6 h-6 text-yellow-600 dark:text-yellow-400" />
          </div>
        </div>
      </Card>

      {/* Card 3: Total Profit at Risk (M2) */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-3xl font-bold text-red-600 dark:text-red-400">
              ${Math.round(profitAtRisk).toLocaleString()}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Total Profit at Risk
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Critical: ${Math.round(criticalProfitAtRisk).toLocaleString()}
            </div>
            <div className="text-xs mt-0.5 flex items-center gap-1.5">
              {usingFallback ? (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  Estimated
                </span>
              ) : (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  Verified
                </span>
              )}
              <span className="text-slate-400">
                {itemsWithRealFinancials} real / {itemsWithAssumption} est.
              </span>
            </div>
          </div>
          <div className="bg-red-100 dark:bg-red-900/30 p-3 rounded-lg">
            <DollarSign className="w-6 h-6 text-red-600 dark:text-red-400" />
          </div>
        </div>
      </Card>

      {/* Card 4: Data Snapshot Time */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="text-xs text-slate-500 dark:text-slate-400 uppercase mb-1">
              Data Snapshot Time
            </div>
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              {formatTime(dataSnapshotTime)}
            </div>
            <div className="text-xs text-green-600 dark:text-green-400 mt-1">
              ✓ Data synced
            </div>
          </div>
          <div className="bg-slate-100 dark:bg-slate-700 p-3 rounded-lg">
            <Clock className="w-6 h-6 text-slate-600 dark:text-slate-400" />
          </div>
        </div>
      </Card>
    </div>
  );
};

export default KPICards;
