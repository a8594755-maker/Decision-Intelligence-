import { useMemo } from 'react';
import RiskCard from './RiskCard';

/**
 * RiskCardGrid Component
 * Container for RiskCard components with grid layout and sorting
 * 
 * @param {Object} props
 * @param {Array} props.risks - Array of risk items
 * @param {string} props.selectedRowId - ID of currently selected row
 * @param {Function} props.onRowSelect - Callback when a card is selected
 * @param {Function} props.onExpedite - Callback for expedite action
 * @param {Function} props.onSubstitute - Callback for substitute action
 * @param {boolean} props.loading - Loading state
 * @param {string} props.sortBy - Sort field (default: 'profitAtRisk')
 * @param {string} props.sortOrder - Sort order (default: 'desc')
 */
export default function RiskCardGrid({ 
  risks, 
  selectedRowId, 
  onRowSelect, 
  onExpedite, 
  onSubstitute,
  loading,
  sortBy = 'profitAtRisk',
  sortOrder = 'desc'
}) {
  // Sort risks by profit at risk (descending) by default
  const sortedRisks = useMemo(() => {
    if (!risks || risks.length === 0) return [];
    
    return [...risks].sort((a, b) => {
      let aVal, bVal;
      
      switch (sortBy) {
        case 'profitAtRisk':
          aVal = a.profitAtRisk || 0;
          bVal = b.profitAtRisk || 0;
          break;
        case 'daysToStockout':
          // Handle null/undefined days - put them at the end
          aVal = a.daysToStockout === null || a.daysToStockout === undefined ? Infinity : a.daysToStockout;
          bVal = b.daysToStockout === null || b.daysToStockout === undefined ? Infinity : b.daysToStockout;
          break;
        case 'status': {
          // Critical (3) > Warning (2) > OK (1)
          const statusOrder = { critical: 3, warning: 2, ok: 1 };
          aVal = statusOrder[a.status?.toLowerCase()] || 0;
          bVal = statusOrder[b.status?.toLowerCase()] || 0;
          break;
        }
        case 'materialCode':
          aVal = a.materialCode || '';
          bVal = b.materialCode || '';
          return sortOrder === 'desc' 
            ? bVal.localeCompare(aVal)
            : aVal.localeCompare(bVal);
        default:
          aVal = a[sortBy] || 0;
          bVal = b[sortBy] || 0;
      }
      
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });
  }, [risks, sortBy, sortOrder]);

  // Transform risk data for card display
  const transformRiskForCard = (risk) => {
    // Map from existing risk data structure to card interface
    return {
      id: risk.id || `${risk.item}-${risk.plantId}`,
      materialCode: risk.item || '(unknown)',
      plant: risk.plantId || '',
      description: risk.description || '',
      status: risk.riskLevel || 'ok',
      profitAtRisk: risk.profitAtRisk || 0,
      marginAtRisk: risk.revMarginAtRisk || 0,
      penalty: risk.revPenaltyAtRisk || 0,
      daysToStockout: risk.daysToStockout ?? (risk.nextTimeBucket ? parseInt(risk.nextTimeBucket.replace(/[^0-9]/g, '')) * 7 : null),
      stockoutDate: risk.nextTimeBucket || null,
      netAvailable: risk.netAvailableQty || risk.onHand || 0,
      gapQty: risk.gapQty || Math.max(0, (risk.totalDemand || 0) - (risk.netAvailableQty || 0)),
      actions: {
        canExpedite: true,
        canSubstitute: true
      },
      // Preserve original data for callbacks
      _original: risk
    };
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 px-4 md:px-6 py-6">
        {[...Array(6)].map((_, i) => (
          <div 
            key={i} 
            className="h-64 bg-slate-100 dark:bg-slate-800/50 rounded-xl animate-pulse"
          />
        ))}
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
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 px-4 md:px-6 py-6">
      {sortedRisks.map((risk) => {
        const cardData = transformRiskForCard(risk);
        return (
          <RiskCard
            key={cardData.id}
            risk={cardData}
            selected={selectedRowId === risk.id}
            onClick={(cardRisk) => onRowSelect?.(cardRisk._original)}
            onExpedite={(cardRisk) => onExpedite?.(cardRisk._original)}
            onSubstitute={(cardRisk) => onSubstitute?.(cardRisk._original)}
          />
        );
      })}
    </div>
  );
}
