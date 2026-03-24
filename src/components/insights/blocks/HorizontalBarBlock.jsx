const COLORS = ['#0891b2', '#2563eb', '#059669', '#d97706', '#dc2626'];

export default function HorizontalBarBlock({ title, items = [], maxValue: customMax, loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
        <div className="h-4 w-40 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="mb-3">
            <div className="h-3 w-24 bg-slate-200 dark:bg-slate-700 rounded mb-1" />
            <div className="h-5 bg-slate-100 dark:bg-slate-800 rounded" style={{ width: `${80 - i * 15}%` }} />
          </div>
        ))}
      </div>
    );
  }

  const maxVal = customMax || Math.max(...items.map((d) => d.value || 0), 1);

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      {title && <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">{title}</h4>}
      <div className="space-y-2.5">
        {items.map((item, i) => {
          const pct = maxVal > 0 ? ((item.value || 0) / maxVal) * 100 : 0;
          return (
            <div key={i}>
              <div className="flex justify-between text-xs mb-0.5">
                <span className="text-slate-600 dark:text-slate-400 truncate mr-2">{item.label}</span>
                <span className="text-slate-500 dark:text-slate-500 shrink-0">{item.value}</span>
              </div>
              <div className="h-5 bg-slate-100 dark:bg-slate-800 rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm transition-all duration-500"
                  style={{ width: `${pct}%`, backgroundColor: COLORS[i % COLORS.length] }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
