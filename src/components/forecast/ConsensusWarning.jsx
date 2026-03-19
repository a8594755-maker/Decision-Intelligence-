import React from 'react';
import { AlertTriangle, Info, TrendingUp, Brain, Calendar, Lightbulb } from 'lucide-react';
import { Badge } from '../ui/Badge';

const ConsensusWarning = ({ 
  consensusData, 
  onDismiss,
  onModelSwitch,
  compact = false 
}) => {
  if (!consensusData || !consensusData.warning) {
    return null;
  }

  const { level, message, recommendation, deviation_pct } = consensusData;
  
  const getModelIcon = (modelType) => {
    switch (modelType?.toLowerCase()) {
      case 'lightgbm':
        return <TrendingUp className="w-4 h-4" />;
      case 'chronos':
        return <Brain className="w-4 h-4" />;
      case 'prophet':
        return <Calendar className="w-4 h-4" />;
      default:
        return <Info className="w-4 h-4" />;
    }
  };

  // Static Tailwind class maps — dynamic `bg-${color}-50` gets purged in production
  const LEVEL_STYLES = {
    high: {
      bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-600', heading: 'text-red-800',
      text700: 'text-red-700', text400: 'text-red-400', hoverText: 'hover:text-red-600',
      bgBtn: 'bg-red-600', hoverBgBtn: 'hover:bg-red-700',
      border300: 'border-red-300', bgHover100: 'hover:bg-red-100',
    },
    medium: {
      bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-600', heading: 'text-yellow-800',
      text700: 'text-yellow-700', text400: 'text-yellow-400', hoverText: 'hover:text-yellow-600',
      bgBtn: 'bg-yellow-600', hoverBgBtn: 'hover:bg-yellow-700',
      border300: 'border-yellow-300', bgHover100: 'hover:bg-yellow-100',
    },
    low: {
      bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-600', heading: 'text-blue-800',
      text700: 'text-blue-700', text400: 'text-blue-400', hoverText: 'hover:text-blue-600',
      bgBtn: 'bg-blue-600', hoverBgBtn: 'hover:bg-blue-700',
      border300: 'border-blue-300', bgHover100: 'hover:bg-blue-100',
    },
  };

  const getLevelBadgeVariant = (level) => {
    switch (level) {
      case 'high':
        return 'destructive';
      case 'medium':
        return 'default';
      default:
        return 'secondary';
    }
  };

  const getRecommendationIcon = (rec) => {
    switch (rec) {
      case 'consider_external_factors':
        return <Lightbulb className="w-4 h-4" />;
      case 'monitor_closely':
        return <Info className="w-4 h-4" />;
      default:
        return <AlertTriangle className="w-4 h-4" />;
    }
  };

  const getRecommendationText = (rec) => {
    switch (rec) {
      case 'consider_external_factors':
        return 'Consider checking for unrecorded market activities, promotions, or supply chain changes';
      case 'monitor_closely':
        return 'Recommend closely monitoring actual sales and adjusting forecasts promptly';
      default:
        return 'Recommend further data analysis or consulting business experts';
    }
  };

  const styles = LEVEL_STYLES[level] || LEVEL_STYLES.low;

  if (compact) {
    return (
      <div className={`${styles.bg} border ${styles.border} rounded-lg p-3`}>
        <div className="flex items-center space-x-2">
          <AlertTriangle className={`w-4 h-4 ${styles.text}`} />
          <span className={`text-sm font-medium ${styles.heading}`}>
            Model prediction deviation {deviation_pct?.toFixed(1)}%
          </span>
          <Badge variant={getLevelBadgeVariant(level)} className="text-xs">
            {level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low'} Risk
          </Badge>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.bg} border ${styles.border} rounded-lg p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-2">
          <AlertTriangle className={`w-5 h-5 ${styles.text}`} />
          <div>
            <h4 className={`font-semibold ${styles.heading}`}>
              Model Consensus Warning
            </h4>
            <p className={`text-sm ${styles.text700}`}>
              {message}
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          <Badge variant={getLevelBadgeVariant(level)}>
            {level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low'} Risk
          </Badge>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className={`${styles.text400} ${styles.hoverText} transition-colors`}
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Deviation Details */}
      <div className="bg-white bg-opacity-60 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              {getModelIcon(consensusData.primary_model)}
              <span className="text-sm font-medium text-gray-700">
                {consensusData.primary_model?.toUpperCase()}
              </span>
              <span className="text-sm text-gray-500">
                {consensusData.primary_mean?.toFixed(0)}
              </span>
            </div>
            
            <div className="text-gray-400">vs</div>
            
            <div className="flex items-center space-x-2">
              {getModelIcon(consensusData.secondary_model)}
              <span className="text-sm font-medium text-gray-700">
                {consensusData.secondary_model?.toUpperCase()}
              </span>
              <span className="text-sm text-gray-500">
                {consensusData.secondary_mean?.toFixed(0)}
              </span>
            </div>
          </div>
          
          <div className="text-right">
            <div className={`text-lg font-bold ${styles.text}`}>
              {deviation_pct?.toFixed(1)}%
            </div>
            <div className="text-xs text-gray-500">Deviation</div>
          </div>
        </div>
      </div>

      {/* Recommendation */}
      <div className="bg-white bg-opacity-60 rounded-lg p-3">
        <div className="flex items-start space-x-2">
          {getRecommendationIcon(recommendation)}
          <div>
            <p className={`text-sm font-medium ${styles.heading} mb-1`}>
              Smart Recommendation
            </p>
            <p className="text-sm text-gray-700">
              {getRecommendationText(recommendation)}
            </p>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex space-x-2">
        {onModelSwitch && (
          <button
            onClick={() => onModelSwitch(consensusData.secondary_model?.toLowerCase())}
            className={`px-3 py-2 ${styles.bgBtn} text-white rounded-lg ${styles.hoverBgBtn} transition-colors text-sm`}
          >
            Switch to {consensusData.secondary_model?.toUpperCase()}
          </button>
        )}
        
        <button
          className={`px-3 py-2 border ${styles.border300} ${styles.text700} rounded-lg ${styles.bgHover100} transition-colors text-sm`}
        >
          View Detailed Analysis
        </button>
      </div>

      {/* Additional Context */}
      <div className={`text-xs ${styles.text} border-t ${styles.border} pt-2`}>
        <p>
          When two models show significant prediction differences, it may indicate:
        </p>
        <ul className="mt-1 space-y-1">
          <li>&bull; Market conditions have changed (promotions, competition, seasonal factors)</li>
          <li>&bull; Data quality issues or outliers</li>
          <li>&bull; Model suitability differences (different models excel at different patterns)</li>
        </ul>
      </div>
    </div>
  );
};

export default ConsensusWarning;
