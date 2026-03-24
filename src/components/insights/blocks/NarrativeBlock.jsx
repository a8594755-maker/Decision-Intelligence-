export default function NarrativeBlock({ title, text, loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 animate-pulse">
        <div className="h-5 w-48 bg-slate-200 dark:bg-slate-700 rounded mb-3" />
        <div className="space-y-2">
          <div className="h-3 w-full bg-slate-100 dark:bg-slate-800 rounded" />
          <div className="h-3 w-5/6 bg-slate-100 dark:bg-slate-800 rounded" />
          <div className="h-3 w-4/6 bg-slate-100 dark:bg-slate-800 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
      {title && <h4 className="text-base font-bold text-slate-800 dark:text-slate-200 mb-2">{title}</h4>}
      {text && (
        <div className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
