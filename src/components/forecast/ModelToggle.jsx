import React, { useState, useEffect } from 'react';
import { Brain, TrendingUp, Calendar, AlertTriangle, Info, CheckCircle } from 'lucide-react';
import { Badge } from '../ui/Badge';

const ModelToggle = ({ 
  selectedModel, 
  onModelChange, 
  recommendedModel, 
  modelStatus, 
  isLoading = false,
  disabled = false,
  showRecommendation = true,
  compact = false
}) => {
  const [showInfo, setShowInfo] = useState(false);

  const models = [
    {
      id: 'lightgbm',
      name: '穩定模式',
      icon: TrendingUp,
      description: '基於梯度提升決策樹，適合數據充足且有明確業務邏輯的產品',
      features: ['結構化特徵', '價格敏感', '歷史數據 > 3個月'],
      color: 'blue',
      status: modelStatus?.lightgbm?.available
    },
    {
      id: 'chronos',
      name: 'AI 模式',
      icon: Brain,
      description: 'Amazon Chronos 零樣本學習，適合新產品或異常數據模式',
      features: ['零樣本推論', '異常檢測', '原始序列'],
      color: 'purple',
      status: modelStatus?.chronos?.available
    },
    {
      id: 'prophet',
      name: '季節模式',
      icon: Calendar,
      description: '時間序列專家模型，適合有明顯季節性模式的產品',
      features: ['季節性檢測', '節假日效應', '趨勢分析'],
      color: 'green',
      status: modelStatus?.prophet?.available
    }
  ];

  const selectedModelData = models.find(m => m.id === selectedModel);
  const recommendedModelData = models.find(m => m.id === recommendedModel);

  const getModelColor = (modelId) => {
    const model = models.find(m => m.id === modelId);
    return model?.color || 'gray';
  };

  const getModelBadgeVariant = (modelId) => {
    const model = models.find(m => m.id === modelId);
    if (!model?.status) return 'destructive';
    if (modelId === recommendedModel) return 'default';
    return 'secondary';
  };

  if (compact) {
    return (
      <div className="flex items-center space-x-2">
        <span className="text-sm font-medium text-gray-700">模型:</span>
        <div className="flex space-x-1">
          {models.map((model) => {
            const Icon = model.icon;
            return (
              <button
                key={model.id}
                onClick={() => !disabled && onModelChange(model.id)}
                disabled={disabled || !model.status || isLoading}
                className={`
                  p-2 rounded-lg border transition-all duration-200
                  ${selectedModel === model.id 
                    ? `border-${getModelColor(model.id)}-500 bg-${getModelColor(model.id)}-50` 
                    : 'border-gray-200 hover:border-gray-300'
                  }
                  ${disabled || !model.status || isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
                title={model.description}
              >
                <Icon className={`w-4 h-4 text-${getModelColor(model.id)}-600`} />
              </button>
            );
          })}
        </div>
        {recommendedModel && recommendedModel !== selectedModel && (
          <Badge variant="outline" className="text-xs">
            推薦: {recommendedModelData?.name}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <h3 className="text-lg font-semibold text-gray-900">預測模型選擇</h3>
          {isLoading && (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
          )}
        </div>
        <button
          onClick={() => setShowInfo(!showInfo)}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>

      {/* Model Selection */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {models.map((model) => {
          const Icon = model.icon;
          const isSelected = selectedModel === model.id;
          const isRecommended = recommendedModel === model.id;
          
          return (
            <button
              key={model.id}
              onClick={() => !disabled && model.status && onModelChange(model.id)}
              disabled={disabled || !model.status || isLoading}
              className={`
                relative p-4 rounded-lg border-2 transition-all duration-200 text-left
                ${isSelected 
                  ? `border-${getModelColor(model.id)}-500 bg-${getModelColor(model.id)}-50` 
                  : 'border-gray-200 hover:border-gray-300'
                }
                ${disabled || !model.status || isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:shadow-sm'}
              `}
            >
              {/* Recommendation Badge */}
              {isRecommended && showRecommendation && (
                <div className="absolute -top-2 -right-2">
                  <Badge variant="default" className="text-xs">
                    推薦
                  </Badge>
                </div>
              )}

              {/* Status Indicator */}
              <div className="absolute top-2 right-2">
                {model.status ? (
                  <CheckCircle className="w-4 h-4 text-green-500" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                )}
              </div>

              {/* Model Content */}
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Icon className={`w-5 h-5 text-${getModelColor(model.id)}-600`} />
                  <h4 className="font-semibold text-gray-900">{model.name}</h4>
                </div>
                
                <p className="text-sm text-gray-600">{model.description}</p>
                
                <div className="flex flex-wrap gap-1">
                  {model.features.map((feature, idx) => (
                    <Badge 
                      key={idx} 
                      variant={getModelBadgeVariant(model.id)}
                      className="text-xs"
                    >
                      {feature}
                    </Badge>
                  ))}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Information Panel */}
      {showInfo && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-start space-x-2">
            <Info className="w-4 h-4 text-blue-600 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">雙模型架構說明：</p>
              <ul className="space-y-1 text-xs">
                  <li>&bull; <strong>穩定模式 (LightGBM)</strong>：適合有充足歷史數據和明確業務邏輯的產品</li>
                  <li>&bull; <strong>AI 模式 (Chronos)</strong>：適合新產品、冷啟動或異常數據模式</li>
                  <li>&bull; <strong>季節模式 (Prophet)</strong>：適合有明顯季節性模式的產品</li>
                  <li>&bull; 系統會根據數據特徵自動推薦最適合的模型</li>
                  <li>&bull; 當模型預測差異 &gt; 15% 時會顯示共識警告</li>
                </ul>
            </div>
          </div>
        </div>
      )}

      {/* Current Selection Summary */}
      {selectedModelData && (
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <selectedModelData.icon className={`w-4 h-4 text-${getModelColor(selectedModel)}-600`} />
              <span className="text-sm font-medium text-gray-700">
                當前選擇: {selectedModelData.name}
              </span>
            </div>
            {recommendedModel && recommendedModel !== selectedModel && (
              <div className="text-xs text-gray-500">
                系統推薦: {recommendedModelData?.name}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelToggle;
