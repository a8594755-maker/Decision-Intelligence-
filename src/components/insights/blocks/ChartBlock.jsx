import ChartRenderer from '../../chat/ChartRenderer';

export default function ChartBlock({ chart, title, height = 260, loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
        <div className="h-4 w-40 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
        <div className="h-48 bg-slate-100 dark:bg-slate-800 rounded" />
      </div>
    );
  }

  if (!chart) return null;

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex flex-col">
      {title && <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">{title}</h4>}
      <div className="flex-1 min-h-0">
        <ChartRenderer chart={chart} height={height} showSwitcher={false} />
      </div>
    </div>
  );
}
