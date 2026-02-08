import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Area,
  ComposedChart,
  ReferenceLine
} from 'recharts';
import { TrendingUp, Brain, Calendar, Info } from 'lucide-react';
import { Badge } from '../ui/Badge';

const ConfidenceOverlayChart = ({ 
  forecastData, 
  comparisonData, 
  historicalData = [],
  showHistorical = true,
  showComparison = true,
  height = 400,
  compact = false 
}) => {
  // Process data for chart
  const chartData = useMemo(() => {
    const data = [];
    
    // Add historical data if available
    if (showHistorical && historicalData.length > 0) {
      historicalData.forEach((point, index) => {
        data.push({
          day: index - historicalData.length + 1,
          date: point.date,
          historical: point.value,
          type: 'historical'
        });
      });
    }
    
    // Add forecast data
    if (forecastData?.predictions) {
      forecastData.predictions.forEach((value, index) => {
        const dayIndex = showHistorical ? index + 1 : index;
        const dataPoint = {
          day: dayIndex,
          forecast: value,
          type: 'forecast'
        };
        
        // Add confidence interval if available
        if (forecastData.confidence_interval) {
          const [lower, upper] = forecastData.confidence_interval;
          if (Array.isArray(lower) && Array.isArray(upper)) {
            dataPoint.confidence_lower = lower[index];
            dataPoint.confidence_upper = upper[index];
          } else if (typeof lower === 'number' && typeof upper === 'number') {
            dataPoint.confidence_lower = lower;
            dataPoint.confidence_upper = upper;
          }
        }
        
        data.push(dataPoint);
      });
    }
    
    // Add comparison data if available
    if (showComparison && comparisonData) {
      // This would need to be adjusted based on actual comparison data structure
      const comparisonValues = comparisonData.predictions || 
                              Array(forecastData?.predictions?.length || 0).fill(comparisonData.secondary_mean);
      
      comparisonValues.forEach((value, index) => {
        const dayIndex = showHistorical ? index + 1 : index;
        const existingPoint = data.find(d => d.day === dayIndex);
        
        if (existingPoint) {
          existingPoint.comparison = value;
        } else {
          data.push({
            day: dayIndex,
            comparison: value,
            type: 'comparison'
          });
        }
      });
    }
    
    return data.sort((a, b) => a.day - b.day);
  }, [forecastData, comparisonData, historicalData, showHistorical, showComparison]);

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

  const getModelColor = (modelType) => {
    switch (modelType?.toLowerCase()) {
      case 'lightgbm':
        return '#3B82F6'; // blue
      case 'chronos':
        return '#8B5CF6'; // purple
      case 'prophet':
        return '#10B981'; // green
      default:
        return '#6B7280'; // gray
    }
  };

  const primaryModelColor = getModelColor(forecastData?.model);
  const comparisonModelColor = getModelColor(comparisonData?.secondary_model);

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload || payload.length === 0) return null;

    return (
      <div className="bg-white p-3 border border-gray-200 rounded-lg shadow-lg">
        <p className="text-sm font-medium text-gray-900 mb-2">
          Day {label}
        </p>
        
        {payload.map((entry, index) => {
          const value = entry.value;
          const name = entry.name;
          
          return (
            <div key={index} className="flex items-center justify-between space-x-4 text-xs">
              <div className="flex items-center space-x-1">
                <div 
                  className="w-2 h-2 rounded-full" 
                  style={{ backgroundColor: entry.color }}
                />
                <span className="font-medium capitalize">{name}:</span>
              </div>
              <span className="font-mono">
                {typeof value === 'number' ? value.toFixed(0) : value}
              </span>
            </div>
          );
        })}
        
        {payload.find(p => p.name === 'forecast') && 
         payload.find(p => p.name === 'comparison') && (
          <div className="mt-2 pt-2 border-t border-gray-200">
            <div className="text-xs text-gray-600">
              Deviation: {Math.abs(
                (payload.find(p => p.name === 'forecast')?.value || 0) - 
                (payload.find(p => p.name === 'comparison')?.value || 0)
              ).toFixed(0)} units
            </div>
          </div>
        )}
      </div>
    );
  };

  if (compact) {
    return (
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis 
              dataKey="day" 
              tick={{ fontSize: 10 }}
              stroke="#6B7280"
            />
            <YAxis 
              tick={{ fontSize: 10 }}
              stroke="#6B7280"
            />
            <Tooltip content={<CustomTooltip />} />
            
            {/* Historical line */}
            {showHistorical && (
              <Line
                type="monotone"
                dataKey="historical"
                stroke="#9CA3AF"
                strokeWidth={1}
                dot={false}
                name="historical"
              />
            )}
            
            {/* Primary forecast */}
            <Line
              type="monotone"
              dataKey="forecast"
              stroke={primaryModelColor}
              strokeWidth={2}
              dot={false}
              name="forecast"
            />
            
            {/* Comparison forecast */}
            {showComparison && comparisonData && (
              <Line
                type="monotone"
                dataKey="comparison"
                stroke={comparisonModelColor}
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                name="comparison"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <h3 className="text-lg font-semibold text-gray-900">預測對比圖</h3>
          
          {/* Model badges */}
          <div className="flex items-center space-x-2">
            <div className="flex items-center space-x-1">
              {getModelIcon(forecastData?.model)}
              <Badge variant="default" className="text-xs">
                {forecastData?.model?.toUpperCase()}
              </Badge>
            </div>
            
            {showComparison && comparisonData && (
              <div className="flex items-center space-x-1">
                {getModelIcon(comparisonData.secondary_model)}
                <Badge variant="outline" className="text-xs">
                  {comparisonData.secondary_model?.toUpperCase()}
                </Badge>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex items-center space-x-2 text-xs text-gray-500">
          <span>置信區間: 90%</span>
          <span>&bull;</span>
          <span>預測天數: {forecastData?.predictions?.length || 0}</span>
        </div>
      </div>

      {/* Chart */}
      <div style={{ height: height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis 
              dataKey="day" 
              tick={{ fontSize: 12 }}
              stroke="#6B7280"
              label={{ value: "預測天數", position: "insideBottom", offset: -5 }}
            />
            <YAxis 
              tick={{ fontSize: 12 }}
              stroke="#6B7280"
              label={{ value: "預測需求", angle: -90, position: "insideLeft" }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            
            {/* Historical line */}
            {showHistorical && (
              <Line
                type="monotone"
                dataKey="historical"
                stroke="#9CA3AF"
                strokeWidth={2}
                dot={false}
                name="歷史數據"
                connectNulls={false}
              />
            )}
            
            {/* Confidence interval area */}
            {forecastData?.confidence_interval && (
              <Area
                type="monotone"
                dataKey="confidence_upper"
                stroke="none"
                fill={primaryModelColor}
                fillOpacity={0.1}
                name="置信區間上限"
              />
            )}
            
            {forecastData?.confidence_interval && (
              <Area
                type="monotone"
                dataKey="confidence_lower"
                stroke="none"
                fill="white"
                name="置信區間下限"
              />
            )}
            
            {/* Primary forecast line */}
            <Line
              type="monotone"
              dataKey="forecast"
              stroke={primaryModelColor}
              strokeWidth={3}
              dot={{ r: 4, fill: primaryModelColor }}
              activeDot={{ r: 6 }}
              name={`${forecastData?.model?.toUpperCase()} 預測`}
            />
            
            {/* Comparison forecast line */}
            {showComparison && comparisonData && (
              <Line
                type="monotone"
                dataKey="comparison"
                stroke={comparisonModelColor}
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={{ r: 3, fill: comparisonModelColor }}
                activeDot={{ r: 5 }}
                name={`${comparisonData.secondary_model?.toUpperCase()} 預測`}
              />
            )}
            
            {/* Reference line at today */}
            {showHistorical && (
              <ReferenceLine 
                x={0} 
                stroke="#EF4444" 
                strokeWidth={2}
                strokeDasharray="4 4"
                label="今天"
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-200">
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-900">
            {forecastData?.median?.toFixed(0) || 'N/A'}
          </div>
          <div className="text-xs text-gray-500">主要預測均值</div>
        </div>
        
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-900">
            {comparisonData?.secondary_prediction?.toFixed(0) || 'N/A'}
          </div>
          <div className="text-xs text-gray-500">比較預測均值</div>
        </div>
        
        <div className="text-center">
          <div className="text-2xl font-bold text-blue-600">
            {comparisonData?.deviation_pct?.toFixed(1) || '0'}%
          </div>
          <div className="text-xs text-gray-500">預測偏差</div>
        </div>
        
        <div className="text-center">
          <div className="text-2xl font-bold text-green-600">
            {forecastData?.risk_score?.toFixed(0) || '50'}
          </div>
          <div className="text-xs text-gray-500">風險分數</div>
        </div>
      </div>

      {/* Legend explanation */}
      <div className="bg-gray-50 rounded-lg p-3">
        <div className="flex items-center space-x-4 text-xs text-gray-600">
          <div className="flex items-center space-x-1">
            <div className="w-3 h-0.5 bg-gray-400"></div>
            <span>歷史數據</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="w-3 h-0.5" style={{ backgroundColor: primaryModelColor }}></div>
            <span>主要預測</span>
          </div>
          {showComparison && comparisonData && (
            <div className="flex items-center space-x-1">
              <div className="w-3 h-0.5 border-t-2 border-dashed" style={{ borderColor: comparisonModelColor }}></div>
              <span>比較預測</span>
            </div>
          )}
          <div className="flex items-center space-x-1">
            <div className="w-3 h-3 bg-blue-200 opacity-30 rounded"></div>
            <span>90% 置信區間</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfidenceOverlayChart;
