import React, { memo, useState, useEffect, useRef } from 'react';
import { Database, Check, ChevronDown, Loader2 } from 'lucide-react';

/**
 * Compact popover button that lets the user pick which dataset profile
 * the agent should reference for the current conversation.
 *
 * Props:
 *  - datasets        {Array}    — [{ id, label, fingerprint, created_at }]
 *  - selectedId      {string|null}
 *  - onSelect        {(id: string) => void}
 *  - isLoading       {boolean}
 *  - disabled        {boolean}
 */
function DataSourcePicker({ datasets = [], selectedId, onSelect, isLoading = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [open]);

  const selected = datasets.find((d) => String(d.id) === String(selectedId));
  const label = selected?.label || 'All datasets';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
          selected
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
        }`}
        title="Choose dataset for this conversation"
      >
        <Database className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 bottom-full mb-2 z-50 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Data Source
            </span>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto py-1">
              {/* "All" option */}
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  !selectedId
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700/50'
                }`}
                onClick={() => { onSelect(null); setOpen(false); }}
              >
                <span className="flex-1 truncate">All datasets</span>
                {!selectedId && <Check className="h-3.5 w-3.5" />}
              </button>

              {datasets.map((ds) => {
                const isActive = String(ds.id) === String(selectedId);
                return (
                  <button
                    key={ds.id}
                    type="button"
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      isActive
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                        : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700/50'
                    }`}
                    onClick={() => { onSelect(ds.id); setOpen(false); }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{ds.label}</div>
                      {ds.created_at && (
                        <div className="text-[10px] text-slate-400 dark:text-slate-500">
                          {new Date(ds.created_at).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                    {isActive && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })}

              {datasets.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-slate-400 dark:text-slate-500">
                  No datasets uploaded yet
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(DataSourcePicker);
