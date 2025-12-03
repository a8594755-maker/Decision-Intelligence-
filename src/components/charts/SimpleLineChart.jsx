import React from 'react';

/**
 * Simple Line Chart Component
 * 簡單的折線圖組件
 */
export const SimpleLineChart = ({ data, color = "#3b82f6" }) => {
  const max = Math.max(...data) * 1.2;
  const points = data
    .map((val, i) => `${(i / (data.length - 1)) * 100},${100 - (val / max) * 100}`)
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
        {data.map((val, i) => (
          <circle
            key={i}
            cx={(i / (data.length - 1)) * 100}
            cy={100 - (val / max) * 100}
            r="3"
            fill={color}
            className="hover:r-5 transition-all cursor-pointer opacity-0 hover:opacity-100"
          >
            <title>{val}</title>
          </circle>
        ))}
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
