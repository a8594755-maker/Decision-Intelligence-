import { X, Zap, GitBranch, Package, Clock, DollarSign, TrendingUp, History, Box } from 'lucide-react';
import { useState } from 'react';
import Button from '../ui/Button';

/**
 * RiskDetailModal Component
 * Drawer/Modal for displaying risk details
 * 
 * Desktop: Right-side drawer (480px width)
 * Mobile: Full-screen modal
 * 
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether modal is open
 * @param {Function} props.onClose - Close callback
 * @param {Object} props.riskData - Risk data to display
 * @param {Object} props.user - Current user
 * @param {number} props.horizonDays - Horizon in days
 * @param {Object} props.activeForecastRun - Active forecast run
 * @param {Object} props.probSeries - Probability series data
 * @param {Function} props.loadProbSeriesForKey - Function to load probability series
 * @param {boolean} props.hasProbResults - Whether probability results exist
 * @param {Object} props.revenueState - Revenue state data
 * @param {Object} props.riskScoreData - Risk score data
 * @param {Object} props.replayDraft - Replay draft data
 */
export default function RiskDetailModal({
  isOpen,
  onClose,
  riskData,
  user,
  horizonDays,
  activeForecastRun,
  probSeries,
  loadProbSeriesForKey,
  hasProbResults,
  revenueState,
  riskScoreData,
  replayDraft
}) {
  const [activeTab, setActiveTab] = useState('inventory');

  if (!isOpen || !riskData) return null;

  // Status configuration
  const getStatusConfig = (riskLevel) => {
    const configs = {
      critical: {
        label: 'Critical',
        bgColor: 'bg-red-100 dark:bg-red-900/30',
        textColor: 'text-red-700 dark:text-red-400',
        borderColor: 'border-red-500',
        iconColor: 'text-red-600 dark:text-red-400'
      },
      warning: {
        label: 'Warning',
        bgColor: 'bg-orange-100 dark:bg-orange-900/30',
        textColor: 'text-orange-700 dark:text-orange-400',
        borderColor: 'border-orange-400',
        iconColor: 'text-orange-600 dark:text-orange-400'
      },
      ok: {
        label: 'OK',
        bgColor: 'bg-green-100 dark:bg-green-900/30',
        textColor: 'text-green-700 dark:text-green-400',
        borderColor: 'border-green-400',
        iconColor: 'text-green-600 dark:text-green-400'
      }
    };
    return configs[riskLevel?.toLowerCase()] || configs.ok;
  };

  const statusConfig = getStatusConfig(riskData.riskLevel);

  // Format currency
  const formatCurrency = (value, currency = 'USD') => {
    if (!value || value === 0) return '$0';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0
    }).format(value);
  };

  // Format number
  const formatNumber = (value) => {
    if (!value && value !== 0) return '—';
    return value.toLocaleString();
  };

  // Handle expedite action
  const handleExpedite = () => {
    console.log('Expedite action for:', riskData.item);
    // TODO: Implement expedite logic
  };

  // Handle substitute action
  const handleSubstitute = () => {
    console.log('Substitute action for:', riskData.item);
    // TODO: Implement substitute logic
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Container */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] bg-white dark:bg-slate-900 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col">
        
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-200 dark:border-slate-700">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusConfig.bgColor} ${statusConfig.textColor}`}>
                {statusConfig.label}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {riskData.plantId}
              </span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate">
              {riskData.item || '(unknown)'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {riskData.description || '—'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors ml-2"
          >
            <X className="w-5 h-5 text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Financial Summary */}
        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">Profit at Risk</p>
              <p className={`text-2xl font-bold ${statusConfig.iconColor}`}>
                {formatCurrency(riskData.profitAtRisk, riskData.currency)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500 dark:text-slate-400">Risk Score</p>
              <p className="text-lg font-semibold text-purple-600 dark:text-purple-400">
                {riskData.riskScore?.toLocaleString() || '—'}
              </p>
            </div>
          </div>
          
          {/* Revenue at Risk Row */}
          {(riskData.revMarginAtRisk || riskData.revPenaltyAtRisk || riskData.revTotalAtRisk) && (
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
              {riskData.revMarginAtRisk > 0 && (
                <div className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Margin:</span>
                  <span className="ml-1 font-medium text-rose-600 dark:text-rose-400">
                    ${riskData.revMarginAtRisk.toLocaleString()}
                  </span>
                </div>
              )}
              {riskData.revPenaltyAtRisk > 0 && (
                <div className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Penalty:</span>
                  <span className="ml-1 font-medium text-orange-600 dark:text-orange-400">
                    ${riskData.revPenaltyAtRisk.toLocaleString()}
                  </span>
                </div>
              )}
              {riskData.revTotalAtRisk > 0 && (
                <div className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Total:</span>
                  <span className="ml-1 font-medium text-red-600 dark:text-red-400">
                    ${riskData.revTotalAtRisk.toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700">
          {[
            { id: 'inventory', label: 'Inventory Status', icon: Package },
            { id: 'bom', label: 'BOM Trace', icon: Box },
            { id: 'audit', label: 'Audit', icon: History }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/20'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          
          {/* Inventory Tab */}
          {activeTab === 'inventory' && (
            <div className="space-y-6">
              {/* Key Metrics Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <Package className="w-4 h-4" />
                    <span className="text-xs">Net Available</span>
                  </div>
                  <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                    {formatNumber(riskData.netAvailable)}
                  </p>
                </div>
                
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <TrendingUp className="w-4 h-4" />
                    <span className="text-xs">Gap Qty</span>
                  </div>
                  <p className={`text-xl font-semibold ${riskData.gapQty > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
                    {formatNumber(riskData.gapQty)}
                  </p>
                </div>
                
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <Clock className="w-4 h-4" />
                    <span className="text-xs">Days to Stockout</span>
                  </div>
                  <p className={`text-xl font-semibold ${
                    riskData.daysToStockout === null ? 'text-slate-400 dark:text-slate-500' :
                    riskData.daysToStockout <= 0 ? 'text-red-600 dark:text-red-400' :
                    riskData.daysToStockout < 7 ? 'text-orange-600 dark:text-orange-400' :
                    'text-green-600 dark:text-green-400'
                  }`}>
                    {riskData.daysToStockout === null ? '—' :
                     riskData.daysToStockout <= 0 ? 'Stockout' :
                     `${riskData.daysToStockout} days`}
                  </p>
                </div>
                
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <DollarSign className="w-4 h-4" />
                    <span className="text-xs">Next Bucket</span>
                  </div>
                  <p className="text-xl font-semibold text-slate-900 dark:text-slate-100 font-mono">
                    {riskData.nextTimeBucket || '—'}
                  </p>
                </div>
              </div>

              {/* Probabilistic Data */}
              {hasProbResults && riskData.pStockout !== undefined && (
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                  <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3">
                    Probabilistic Forecast
                  </h4>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">P(Stockout)</p>
                      <p className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                        {(riskData.pStockout * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">Stockout P50</p>
                      <p className="text-lg font-semibold text-blue-900 dark:text-blue-100 font-mono">
                        {riskData.stockoutBucketP50 || '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">Stockout P90</p>
                      <p className="text-lg font-semibold text-blue-900 dark:text-blue-100 font-mono">
                        {riskData.stockoutBucketP90 || '—'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Supply Breakdown */}
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
                  Supply Breakdown
                </h4>
                <div className="space-y-2">
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">On Hand</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.onHand)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Open PO</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.openPO)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Inbound (Horizon)</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.inboundQty)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Total Demand</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.totalDemand)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Net Available</span>
                    <span className={`text-sm font-bold ${riskData.netAvailable < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
                      {formatNumber(riskData.netAvailable)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* BOM Tab */}
          {activeTab === 'bom' && (
            <div className="text-center py-12">
              <Box className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-4" />
              <p className="text-slate-500 dark:text-slate-400">
                BOM Trace feature in development
              </p>
              <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
                Will show parent material structure for {riskData.item}
              </p>
            </div>
          )}

          {/* Audit Tab */}
          {activeTab === 'audit' && (
            <div className="text-center py-12">
              <History className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-4" />
              <p className="text-slate-500 dark:text-slate-400">
                Audit Timeline feature in development
              </p>
              <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
                Will show What-if simulation history
              </p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex gap-3">
            <Button
              onClick={handleExpedite}
              variant="primary"
              icon={Zap}
              className="flex-1"
            >
              Simulate Expedite
            </Button>
            <Button
              onClick={handleSubstitute}
              variant="outline"
              icon={GitBranch}
              className="flex-1"
            >
              View Substitutes
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
