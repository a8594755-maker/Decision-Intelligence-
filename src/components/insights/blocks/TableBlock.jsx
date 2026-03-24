export default function TableBlock({ title, columns = [], rows = [], highlightHeader = true, loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
        <div className="h-4 w-40 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-6 bg-slate-100 dark:bg-slate-800 rounded mb-2" />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex flex-col overflow-hidden">
      {title && <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">{title}</h4>}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          {columns.length > 0 && (
            <thead>
              <tr className={highlightHeader ? 'bg-teal-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}>
                {columns.map((col, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{col}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-slate-50 dark:bg-slate-800/50'}>
                {(Array.isArray(row) ? row : columns.map((_, ci) => row[columns[ci]] ?? '')).map((cell, ci) => (
                  <td key={ci} className="px-3 py-1.5 text-slate-700 dark:text-slate-300 whitespace-nowrap">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
