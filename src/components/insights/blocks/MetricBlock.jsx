import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const DIR_ICON = { up: TrendingUp, down: TrendingDown, stable: Minus };
const DIR_COLOR = { up: 'text-emerald-500', down: 'text-red-500', stable: 'text-slate-400' };
const DIR_BG = { up: 'bg-emerald-50 dark:bg-emerald-950/30', down: 'bg-red-50 dark:bg-red-950/30', stable: 'bg-slate-50 dark:bg-slate-800' };

export default function MetricBlock({ label, value, delta, deltaDirection = 'stable', subtitle, loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 animate-pulse">
        <div className="h-3 w-20 bg-slate-200 dark:bg-slate-700 rounded mb-3" />
        <div className="h-8 w-28 bg-slate-200 dark:bg-slate-700 rounded mb-2" />
        <div className="h-3 w-16 bg-slate-200 dark:bg-slate-700 rounded" />
      </div>
    );
  }

  const Icon = DIR_ICON[deltaDirection] || Minus;
  const color = DIR_COLOR[deltaDirection] || DIR_COLOR.stable;

  return (
    <div className={`h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 flex flex-col justify-center ${DIR_BG[deltaDirection] || ''}`}>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-3xl font-bold text-slate-900 dark:text-white leading-tight">{value ?? '—'}</p>
      {(delta != null) && (
        <div className={`flex items-center gap-1 mt-2 text-sm font-medium ${color}`}>
          <Icon className="w-4 h-4" />
          <span>{delta}</span>
        </div>
      )}
      {subtitle && <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{subtitle}</p>}
    </div>
  );
}
