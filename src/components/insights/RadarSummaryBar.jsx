// RadarSummaryBar.jsx — Severity count pills with filter toggle for Signal Radar

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

const SEVERITY_COLORS = {
  critical: { active: 'bg-red-600 text-white', inactive: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  high:     { active: 'bg-orange-500 text-white', inactive: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  medium:   { active: 'bg-amber-500 text-white', inactive: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  low:      { active: 'bg-slate-500 text-white', inactive: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
};

export default function RadarSummaryBar({ signals, severityFilter, onSeverityFilterChange }) {
  // Count by severity
  const counts = {};
  for (const s of (signals || [])) {
    counts[s.severity] = (counts[s.severity] || 0) + 1;
  }
  const total = signals?.length || 0;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {SEVERITY_ORDER.map((sev) => {
        const count = counts[sev] || 0;
        if (count === 0) return null;
        const isActive = severityFilter === sev;
        const colors = SEVERITY_COLORS[sev] || SEVERITY_COLORS.low;

        return (
          <button
            key={sev}
            onClick={() => onSeverityFilterChange(isActive ? null : sev)}
            className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
              isActive ? colors.active : colors.inactive
            }`}
          >
            {count} {sev}
          </button>
        );
      })}
      <span className="text-xs text-[var(--text-tertiary)] ml-1">
        {total} signal{total !== 1 ? 's' : ''} detected
      </span>
    </div>
  );
}
