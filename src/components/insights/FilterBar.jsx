// FilterBar.jsx — Search, tag, date, and pin filters for snapshot timeline

import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, Pin, X } from 'lucide-react';

const ALL_TAGS = [
  'revenue', 'cost', 'customer', 'churn', 'inventory',
  'forecast', 'trend', 'comparison', 'anomaly', 'supplier',
];

export default function FilterBar({ filters, onChange }) {
  const [searchInput, setSearchInput] = useState(filters.search || '');
  const debounceRef = useRef(null);

  // Debounced search
  const handleSearchChange = useCallback((e) => {
    const val = e.target.value;
    setSearchInput(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange({ ...filters, search: val || undefined });
    }, 300);
  }, [filters, onChange]);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const toggleTag = useCallback((tag) => {
    const current = filters.tags || [];
    const next = current.includes(tag)
      ? current.filter(t => t !== tag)
      : [...current, tag];
    onChange({ ...filters, tags: next.length ? next : undefined });
  }, [filters, onChange]);

  const togglePinned = useCallback(() => {
    onChange({ ...filters, pinnedOnly: !filters.pinnedOnly });
  }, [filters, onChange]);

  const clearAll = useCallback(() => {
    setSearchInput('');
    onChange({ search: undefined, tags: undefined, since: undefined, until: undefined, pinnedOnly: false });
  }, [onChange]);

  const hasActiveFilters = filters.search || filters.tags?.length || filters.since || filters.until || filters.pinnedOnly;

  return (
    <div className="space-y-3">
      {/* Search + pinned toggle */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={searchInput}
            onChange={handleSearchChange}
            placeholder="Search analyses..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-500)]"
          />
        </div>
        <button
          onClick={togglePinned}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors ${
            filters.pinnedOnly
              ? 'bg-[var(--brand-600)] text-white border-[var(--brand-600)]'
              : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--brand-500)]'
          }`}
        >
          <Pin className="w-3.5 h-3.5" />
          Pinned
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearAll}
            className="p-2 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"
            title="Clear all filters"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Tag pills */}
      <div className="flex flex-wrap gap-1.5">
        {ALL_TAGS.map((tag) => {
          const active = (filters.tags || []).includes(tag);
          return (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                active
                  ? 'bg-[var(--brand-600)] text-white'
                  : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>

      {/* Date range */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--text-tertiary)]">From</label>
        <input
          type="date"
          value={filters.since || ''}
          onChange={(e) => onChange({ ...filters, since: e.target.value || undefined })}
          className="text-xs px-2 py-1 rounded bg-[var(--surface-subtle)] border border-[var(--border-default)] text-[var(--text-primary)]"
        />
        <label className="text-xs text-[var(--text-tertiary)]">To</label>
        <input
          type="date"
          value={filters.until || ''}
          onChange={(e) => onChange({ ...filters, until: e.target.value || undefined })}
          className="text-xs px-2 py-1 rounded bg-[var(--surface-subtle)] border border-[var(--border-default)] text-[var(--text-primary)]"
        />
      </div>
    </div>
  );
}
