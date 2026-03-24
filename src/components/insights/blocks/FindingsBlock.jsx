import { Lightbulb } from 'lucide-react';

export default function FindingsBlock({ title = 'Key Findings', findings = [], loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 animate-pulse">
        <div className="h-4 w-32 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 mb-3">
            <div className="h-6 w-6 rounded-full bg-slate-200 dark:bg-slate-700 shrink-0" />
            <div className="h-4 flex-1 bg-slate-100 dark:bg-slate-800 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!findings.length) return null;

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb className="w-4 h-4 text-amber-500" />
        <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{title}</h4>
      </div>
      <ol className="space-y-2">
        {findings.map((f, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="shrink-0 w-6 h-6 rounded-full bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 flex items-center justify-center text-xs font-bold">
              {i + 1}
            </span>
            <span className="text-slate-600 dark:text-slate-400 leading-snug">{typeof f === 'string' ? f : f.text || f.finding}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
