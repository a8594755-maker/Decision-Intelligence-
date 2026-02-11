import { useMemo } from 'react';
import { AlertTriangle, AlertCircle, CheckCircle2 } from 'lucide-react';

/**
 * RiskListView Component (Plan B - Master-Detail List)
 * Simplified list view as alternative to card grid
 * 
 * Reserved for Phase 2 implementation. Currently provides basic list
 * functionality while maintaining interface compatibility.
 * 
 * @param {Object} props
 * @param {Array} props.risks - Array of risk items
 * @param {string} props.selectedRowId - ID of currently selected row
 * @param {Function} props.onRowSelect - Callback when a row is selected
 * @param {boolean} props.loading - Loading state
 * @param {React.ReactNode} props.detailsPanel - Details panel to show on the right
 */
export default function RiskListView({ 
  risks, 
  selectedRowId, 
  onRowSelect,
  loading,
  detailsPanel
}) {
  // Sort by status priority and profit at risk
  const sortedRisks = useMemo(() => {
    if (!risks || risks.length === 0) return [];
    
    return [...risks].sort((a, b) => {
      // Priority: Critical > Warning > OK
      const statusOrder = { critical: 3, warning: 2, ok: 1 };
      const aPriority = statusOrder[a.riskLevel?.toLowerCase()] || 0;
      const bPriority = statusOrder[b.riskLevel?.toLowerCase()] || 0;
      
      if (aPriority !== bPriority) return bPriority - aPriority;
      
      // Then by profit at risk
      return (b.profitAtRisk || 0) - (a.profitAtRisk || 0);
    });
  }, [risks]);

  const getStatusConfig = (riskLevel) => {
    const configs = {
      critical: {
        icon: AlertTriangle,
        bgColor: 'bg-red-100 dark:bg-red-900/30',
        textColor: 'text-red-700 dark:text-red-400',
        borderColor: 'border-l-red-500',
        label: 'Critical'
      },
      warning: {
        icon: AlertCircle,
        bgColor: 'bg-orange-100 dark:bg-orange-900/30',
        textColor: 'text-orange-700 dark:text-orange-400',
        borderColor: 'border-l-orange-400',
        label: 'Warning'
      },
      ok: {
        icon: CheckCircle2,
        bgColor: 'bg-green-100 dark:bg-green-900/30',
        textColor: 'text-green-700 dark:text-green-400',
        borderColor: 'border-l-green-400',
        label: 'OK'
      }
    };
    return configs[riskLevel?.toLowerCase()] || configs.ok;
  };

  const formatCurrency = (value) => {
    if (!value || value === 0) return '—';
    return `$${value.toLocaleString()}`;
  };

  const formatDays = (days) => {
    if (days === null || days === undefined) return '—';
    if (days <= 0) return 'Stockout';
    return `${days} days`;
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 px-4 md:px-6 py-6">
        <div className="lg:col-span-7 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
          <div className="space-y-3">
            {[...Array(8)].map((_, i) => (
              <div 
                key={i} 
                className="h-14 bg-slate-100 dark:bg-slate-700/50 rounded-lg animate-pulse"
              />
            ))}
          </div>
        </div>
        <div className="lg:col-span-5">
          <div className="h-96 bg-slate-100 dark:bg-slate-700/50 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (sortedRisks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <div className="w-24 h-24 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
          <svg 
            className="w-12 h-12 text-slate-300 dark:text-slate-600" 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={1.5} 
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" 
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100 mb-2">
          No Risk Items
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 text-center max-w-md">
          No matching risk items under current filters, or all items are in good status.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 px-4 md:px-6 py-6">
      {/* Left: Simplified List */}
      <div className={`${selectedRowId ? 'lg:col-span-7' : 'lg:col-span-12'} bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-300">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-300">
                  Material / Plant
                </th>
                <th className="px-4 py-3 text-right font-semibold text-slate-700 dark:text-slate-300">
                  Profit at Risk
                </th>
                <th className="px-4 py-3 text-right font-semibold text-slate-700 dark:text-slate-300">
                  Days Left
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {sortedRisks.map((risk) => {
                const config = getStatusConfig(risk.riskLevel);
                const StatusIcon = config.icon;
                const isSelected = selectedRowId === risk.id;
                
                return (
                  <tr
                    key={risk.id || `${risk.item}-${risk.plantId}`}
                    onClick={() => onRowSelect?.(risk)}
                    className={`
                      cursor-pointer transition-colors duration-200
                      hover:bg-slate-50 dark:hover:bg-slate-700/50
                      ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-l-blue-500' : ''}
                      ${config.borderColor} border-l-[3px]
                    `}
                  >
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.bgColor} ${config.textColor}`}>
                        <StatusIcon className="w-3 h-3" />
                        {config.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {risk.item || '(unknown)'}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {risk.plantId}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-semibold ${
                        risk.riskLevel === 'critical' ? 'text-red-600 dark:text-red-400' :
                        risk.riskLevel === 'warning' ? 'text-orange-600 dark:text-orange-400' :
                        'text-slate-600 dark:text-slate-400'
                      }`}>
                        {formatCurrency(risk.profitAtRisk)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-sm ${
                        risk.daysToStockout === null ? 'text-slate-400 dark:text-slate-500' :
                        risk.daysToStockout <= 0 ? 'text-red-600 dark:text-red-400 font-bold' :
                        risk.daysToStockout < 7 ? 'text-orange-600 dark:text-orange-400' :
                        'text-green-600 dark:text-green-400'
                      }`}>
                        {formatDays(risk.daysToStockout)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right: Details Panel (when selected) */}
      {selectedRowId && detailsPanel && (
        <div className="lg:col-span-5">
          {detailsPanel}
        </div>
      )}
    </div>
  );
}
