export default function KpiRowBlock({ kpis = [], loading, count = 4 }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}>
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="animate-pulse text-center py-2">
              <div className="h-3 w-20 mx-auto bg-slate-200 dark:bg-slate-700 rounded mb-2" />
              <div className="h-7 w-16 mx-auto bg-slate-200 dark:bg-slate-700 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${kpis.length || 1}, 1fr)` }}>
        {kpis.map((kpi, i) => (
          <div key={i} className="text-center py-2 border-r border-slate-100 dark:border-slate-800 last:border-r-0">
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">{kpi.label}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white">{kpi.value}</p>
            {kpi.subtitle && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{kpi.subtitle}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
