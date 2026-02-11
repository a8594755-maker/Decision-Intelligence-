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

  const getLevelColor = (level) => {
    switch (level) {
      case 'high':
        return 'red';
      case 'medium':
        return 'yellow';
      default:
        return 'blue';
    }
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

  const levelColor = getLevelColor(level);

  if (compact) {
    return (
      <div className={`bg-${levelColor}-50 border border-${levelColor}-200 rounded-lg p-3`}>
        <div className="flex items-center space-x-2">
          <AlertTriangle className={`w-4 h-4 text-${levelColor}-600`} />
          <span className={`text-sm font-medium text-${levelColor}-800`}>
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
    <div className={`bg-${levelColor}-50 border border-${levelColor}-200 rounded-lg p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-2">
          <AlertTriangle className={`w-5 h-5 text-${levelColor}-600`} />
          <div>
            <h4 className={`font-semibold text-${levelColor}-800`}>
              Model Consensus Warning
            </h4>
            <p className={`text-sm text-${levelColor}-700`}>
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
              className={`text-${levelColor}-400 hover:text-${levelColor}-600 transition-colors`}
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
            <div className={`text-lg font-bold text-${levelColor}-600`}>
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
            <p className={`text-sm font-medium text-${levelColor}-800 mb-1`}>
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
            className={`px-3 py-2 bg-${levelColor}-600 text-white rounded-lg hover:bg-${levelColor}-700 transition-colors text-sm`}
          >
            Switch to {consensusData.secondary_model?.toUpperCase()}
          </button>
        )}
        
        <button
          className={`px-3 py-2 border border-${levelColor}-300 text-${levelColor}-700 rounded-lg hover:bg-${levelColor}-100 transition-colors text-sm`}
        >
          View Detailed Analysis
        </button>
      </div>

      {/* Additional Context */}
      <div className={`text-xs text-${levelColor}-600 border-t border-${levelColor}-200 pt-2`}>
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
