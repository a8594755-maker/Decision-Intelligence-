import React from 'react';

/**
 * Simple Bar Chart Component
 * Simple bar chart component
 */
export const SimpleBarChart = ({
  data,
  labels,
  colorClass = "bg-blue-500"
}) => {
  const max = Math.max(...data);

  return (
    <div className="h-48 md:h-64 flex items-end justify-between gap-2">
      {data.map((val, i) => (
        <div
          key={i}
          className="flex-1 flex flex-col items-center group h-full justify-end"
        >
          <div className="relative w-full flex items-end justify-center h-full bg-slate-100 dark:bg-slate-700/50 rounded-t-sm overflow-hidden">
            <div
              style={{ height: `${(val / max) * 100}%` }}
              className={`w-full ${colorClass} transition-all duration-500 group-hover:opacity-80 relative`}
            >
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                {val}%
              </div>
            </div>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 mt-2 truncate w-full text-center hidden sm:block">
            {labels[i]}
          </span>
          {/* Mobile only simplified label */}
          <span className="text-xs text-slate-500 dark:text-slate-400 mt-1 sm:hidden">
            {labels[i].substring(0, 1)}
          </span>
        </div>
      ))}
    </div>
  );
};

export default SimpleBarChart;
