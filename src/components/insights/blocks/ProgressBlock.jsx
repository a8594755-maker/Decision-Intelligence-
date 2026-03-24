const COLORS = {
  teal: { bar: 'bg-teal-500', track: 'bg-teal-100 dark:bg-teal-900/30' },
  blue: { bar: 'bg-blue-500', track: 'bg-blue-100 dark:bg-blue-900/30' },
  amber: { bar: 'bg-amber-500', track: 'bg-amber-100 dark:bg-amber-900/30' },
  red: { bar: 'bg-red-500', track: 'bg-red-100 dark:bg-red-900/30' },
  emerald: { bar: 'bg-emerald-500', track: 'bg-emerald-100 dark:bg-emerald-900/30' },
};

export default function ProgressBlock({ title, items = [], loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
        <div className="h-4 w-32 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
        {[1, 2].map((i) => (
          <div key={i} className="mb-3">
            <div className="h-3 w-20 bg-slate-200 dark:bg-slate-700 rounded mb-1" />
            <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      {title && <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">{title}</h4>}
      <div className="space-y-3">
        {items.map((item, i) => {
          const pct = Math.min(100, Math.max(0, item.percent || 0));
          const palette = COLORS[item.color] || COLORS.teal;
          return (
            <div key={i}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-600 dark:text-slate-400">{item.label}</span>
                <span className="text-slate-500 font-medium">{pct.toFixed(1)}%</span>
              </div>
              <div className={`h-4 rounded-full ${palette.track} overflow-hidden`}>
                <div className={`h-full rounded-full ${palette.bar} transition-all duration-700`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
