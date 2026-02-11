import { AlertTriangle, AlertCircle, CheckCircle2, Zap, GitBranch, Calendar } from 'lucide-react';
import Button from '../ui/Button';

/**
 * RiskCard Component
 * 4-quadrant card design for displaying supply coverage risk
 * 
 * @param {Object} props
 * @param {Object} props.risk - Risk item data
 * @param {Function} props.onClick - Callback when card is clicked (for details)
 * @param {Function} props.onExpedite - Callback for expedite action
 * @param {Function} props.onSubstitute - Callback for substitute action
 * @param {boolean} props.selected - Whether this card is selected
 */
export default function RiskCard({ risk, onClick, onExpedite, onSubstitute, selected }) {
  // Status configuration
  const statusConfig = {
    critical: {
      label: 'Critical',
      icon: AlertTriangle,
      bgColor: 'bg-red-100 dark:bg-red-900/30',
      textColor: 'text-red-700 dark:text-red-400',
      borderColor: 'border-l-red-500',
      shadow: 'shadow-lg hover:shadow-xl',
      scale: 'hover:scale-[1.02]',
      profitColor: 'text-red-600 dark:text-red-400',
    },
    warning: {
      label: 'Warning',
      icon: AlertCircle,
      bgColor: 'bg-orange-100 dark:bg-orange-900/30',
      textColor: 'text-orange-700 dark:text-orange-400',
      borderColor: 'border-l-orange-400',
      shadow: 'shadow-md hover:shadow-lg',
      scale: '',
      profitColor: 'text-orange-600 dark:text-orange-400',
    },
    ok: {
      label: 'OK',
      icon: CheckCircle2,
      bgColor: 'bg-green-100 dark:bg-green-900/30',
      textColor: 'text-green-700 dark:text-green-400',
      borderColor: 'border-l-green-400',
      shadow: 'shadow-sm hover:shadow-md',
      scale: '',
      profitColor: 'text-green-600 dark:text-green-400',
    },
  };

  const config = statusConfig[risk.status?.toLowerCase()] || statusConfig.ok;
  const StatusIcon = config.icon;

  // Days to stockout display logic
  const renderDaysToStockout = () => {
    if (risk.daysToStockout === null || risk.daysToStockout === undefined) {
      return (
        <div className="text-gray-400 dark:text-gray-500 text-sm">—</div>
      );
    }

    if (risk.daysToStockout <= 0) {
      return (
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-red-600 text-white">
            Stockout
          </span>
        </div>
      );
    }

    let colorClass = 'text-green-600 dark:text-green-400';
    let icon = null;

    if (risk.daysToStockout < 3) {
      colorClass = 'text-red-600 dark:text-red-400 font-bold animate-pulse';
      icon = <AlertTriangle className="w-4 h-4 text-red-500" />;
    } else if (risk.daysToStockout < 7) {
      colorClass = 'text-orange-600 dark:text-orange-400 font-semibold';
    }

    return (
      <div className={`flex items-center gap-1.5 ${colorClass}`}>
        {icon}
        <span className="text-lg font-bold">{risk.daysToStockout}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">days</span>
      </div>
    );
  };

  // Format currency
  const formatCurrency = (value) => {
    if (value === null || value === undefined || value === 0) return '—';
    return `$${value.toLocaleString()}`;
  };

  // Handle card click (prevent when clicking buttons)
  const handleCardClick = (e) => {
    if (e.target.closest('button')) return;
    onClick?.(risk);
  };

  return (
    <div
      onClick={handleCardClick}
      className={`
        relative bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 
        border-l-4 ${config.borderColor}
        ${config.shadow} ${config.scale}
        transition-all duration-300 cursor-pointer
        h-64 flex flex-col overflow-hidden
        ${selected ? 'ring-2 ring-blue-500 dark:ring-blue-400' : ''}
      `}
    >
      {/* Status Badge - Absolute positioned */}
      <div className={`absolute top-3 left-3 z-10`}>
        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold ${config.bgColor} ${config.textColor}`}>
          <StatusIcon className="w-4 h-4" />
          {config.label}
        </span>
      </div>

      {/* Main Content Grid - 4 Quadrants */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 p-4 pt-12">
        
        {/* Top-Left: Identification (30% height) */}
        <div className="flex flex-col justify-start">
          <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate" title={risk.materialCode}>
            {risk.materialCode}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {risk.plant}
          </p>
          {risk.description && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 line-clamp-1">
              {risk.description}
            </p>
          )}
        </div>

        {/* Top-Right: Financial Impact (30% height) */}
        <div className="flex flex-col items-end justify-start">
          <div className="text-right">
            <div className={`text-2xl font-bold ${config.profitColor}`}>
              {formatCurrency(risk.profitAtRisk)}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Profit at Risk
            </div>
          </div>
          
          {risk.marginAtRisk > 0 && (
            <div className="text-right mt-2">
              <div className="text-sm font-medium text-rose-600 dark:text-rose-400">
                {formatCurrency(risk.marginAtRisk)}
              </div>
              <div className="text-xs text-slate-400 dark:text-slate-500">
                Margin
              </div>
            </div>
          )}
        </div>

        {/* Bottom-Left: Time Urgency (20% height) */}
        <div className="flex flex-col justify-end">
          <div className="text-xs text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            Days to Stockout
          </div>
          {renderDaysToStockout()}
          {risk.stockoutDate && (
            <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              {risk.stockoutDate}
            </div>
          )}
        </div>

        {/* Bottom-Right: Actions (20% height) */}
        <div className="flex flex-col justify-end items-end gap-2">
          <div className="flex items-center gap-2">
            {risk.actions?.canExpedite !== false && (
              <Button
                onClick={() => onExpedite?.(risk)}
                variant="primary"
                size="sm"
                icon={Zap}
                className="text-xs px-2 py-1"
              >
                Simulate Expedite
              </Button>
            )}
            {risk.actions?.canSubstitute !== false && (
              <Button
                onClick={() => onSubstitute?.(risk)}
                variant="outline"
                size="sm"
                icon={GitBranch}
                className="text-xs px-2 py-1"
              >
                Substitutes
              </Button>
            )}
          </div>
          
          {/* Additional metrics row */}
          <div className="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
            <span title="Net Available">
              Avail: {risk.netAvailable?.toLocaleString() || '—'}
            </span>
            {risk.gapQty > 0 && (
              <span className="text-red-500 dark:text-red-400" title="Gap Quantity">
                Gap: {risk.gapQty.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
