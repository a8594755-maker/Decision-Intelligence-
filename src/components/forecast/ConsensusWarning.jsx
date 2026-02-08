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
        return '建議檢查是否有未登錄的市場活動、促銷或供應鏈變化';
      case 'monitor_closely':
        return '建議密切監控實際銷售情況，及時調整預測';
      default:
        return '建議進一步分析數據或諮詢業務專家';
    }
  };

  const levelColor = getLevelColor(level);

  if (compact) {
    return (
      <div className={`bg-${levelColor}-50 border border-${levelColor}-200 rounded-lg p-3`}>
        <div className="flex items-center space-x-2">
          <AlertTriangle className={`w-4 h-4 text-${levelColor}-600`} />
          <span className={`text-sm font-medium text-${levelColor}-800`}>
            模型預測差異 {deviation_pct?.toFixed(1)}%
          </span>
          <Badge variant={getLevelBadgeVariant(level)} className="text-xs">
            {level === 'high' ? '高' : level === 'medium' ? '中' : '低'}風險
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
              模型共識警告
            </h4>
            <p className={`text-sm text-${levelColor}-700`}>
              {message}
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          <Badge variant={getLevelBadgeVariant(level)}>
            {level === 'high' ? '高' : level === 'medium' ? '中' : '低'}風險
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
            <div className="text-xs text-gray-500">偏差</div>
          </div>
        </div>
      </div>

      {/* Recommendation */}
      <div className="bg-white bg-opacity-60 rounded-lg p-3">
        <div className="flex items-start space-x-2">
          {getRecommendationIcon(recommendation)}
          <div>
            <p className={`text-sm font-medium text-${levelColor}-800 mb-1`}>
              智能建議
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
            切換到 {consensusData.secondary_model?.toUpperCase()}
          </button>
        )}
        
        <button
          className={`px-3 py-2 border border-${levelColor}-300 text-${levelColor}-700 rounded-lg hover:bg-${levelColor}-100 transition-colors text-sm`}
        >
          查看詳細分析
        </button>
      </div>

      {/* Additional Context */}
      <div className={`text-xs text-${levelColor}-600 border-t border-${levelColor}-200 pt-2`}>
        <p>
          當兩個模型的預測結果差異較大時，可能表示：
        </p>
        <ul className="mt-1 space-y-1">
          <li>&bull; 市場環境發生變化（促銷、競爭、季節性因素）</li>
          <li>&bull; 數據質量問題或異常值</li>
          <li>&bull; 模型適用性差異（不同模型擅長不同模式）</li>
        </ul>
      </div>
    </div>
  );
};

export default ConsensusWarning;
