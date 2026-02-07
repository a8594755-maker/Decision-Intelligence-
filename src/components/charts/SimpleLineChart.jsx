import React from 'react';

/**
 * Simple Line Chart Component
 * 簡單的折線圖組件
 */
export const SimpleLineChart = ({ data = [], color = "#3b82f6", yAxisRange = null }) => {
  // Guard against invalid data
  const validData = Array.isArray(data) ? data.filter(v => typeof v === 'number' && !isNaN(v)) : [];
  if (validData.length === 0) {
    return (
      <div className="h-48 md:h-64 w-full flex items-center justify-center text-slate-400 text-sm">
        No data available
      </div>
    );
  }
  
  // 使用提供的 y 軸範圍，或默認自動計算
  const dataMax = Math.max(...validData);
  const dataMin = Math.min(...validData);
  const min = yAxisRange?.min ?? Math.min(0, dataMin);
  const max = yAxisRange?.max ?? (dataMax === 0 ? 1 : dataMax * 1.2);
  
  const range = max - min;
  const safeRange = range === 0 ? 1 : range; // Prevent division by zero
  
  const points = validData
    .map((val, i) => {
      const x = validData.length === 1 ? 50 : (i / (validData.length - 1)) * 100;
      const y = 100 - ((val - min) / safeRange) * 100;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="h-48 md:h-64 w-full relative">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
      >
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="2"
          points={points}
          vectorEffect="non-scaling-stroke"
        />
        {validData.map((val, i) => {
          const x = validData.length === 1 ? 50 : (i / (validData.length - 1)) * 100;
          const y = 100 - ((val - min) / safeRange) * 100;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r="3"
              fill={color}
              className="hover:r-5 transition-all cursor-pointer opacity-0 hover:opacity-100"
            >
              <title>{val.toFixed(2)}</title>
            </circle>
          );
        })}
      </svg>
      {/* Grid Lines */}
      <div className="absolute inset-0 flex flex-col justify-between pointer-events-none opacity-10">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="w-full h-px bg-slate-500" />
        ))}
      </div>
    </div>
  );
};

export default SimpleLineChart;
