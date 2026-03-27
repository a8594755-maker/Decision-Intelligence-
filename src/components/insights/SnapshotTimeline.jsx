// SnapshotTimeline.jsx — Filterable timeline of analysis snapshots

import { useState, useCallback } from 'react';
import SnapshotCard from './SnapshotCard';
import FilterBar from './FilterBar';

function normalizeQuery(q) {
  return (q || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Build version counts: how many snapshots share the same normalized query_text.
 */
function buildVersionMap(snapshots) {
  const map = {};
  for (const s of snapshots) {
    const key = normalizeQuery(s.query_text);
    if (!key) continue;
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

export default function SnapshotTimeline({
  snapshots,
  totalCount,
  filters,
  onFiltersChange,
  onTogglePin,
  onArchive,
  onRefresh,
  refreshingId,
  onLoadMore,
  loading,
  onCompare,
}) {
  const versionMap = buildVersionMap(snapshots);
  const hasMore = snapshots.length < totalCount;

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} onChange={onFiltersChange} />

      {/* Count */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-tertiary)]">
          {totalCount === 0 ? 'No analyses yet' : `${totalCount} analysis asset${totalCount !== 1 ? 's' : ''}`}
          {(filters.tags?.length || filters.search || filters.pinnedOnly) ? ' (filtered)' : ''}
        </p>
      </div>

      {/* Snapshot list */}
      {snapshots.length === 0 && !loading && (
        <div className="text-center py-12">
          <p className="text-sm text-[var(--text-secondary)]">
            {filters.search || filters.tags?.length
              ? 'No analyses match your filters.'
              : 'No analysis assets yet. Run analyses in the Workspace to start building insights.'}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {snapshots.map((s) => (
          <SnapshotCard
            key={s.id}
            snapshot={s}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
            onRefresh={onRefresh}
            refreshing={refreshingId === s.id}
            versionCount={versionMap[normalizeQuery(s.query_text)] || 1}
            onCompare={onCompare}
          />
        ))}
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="text-center pt-2">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="text-sm text-[var(--brand-600)] hover:text-[var(--brand-700)] disabled:opacity-50"
          >
            {loading ? 'Loading...' : `Load more (${totalCount - snapshots.length} remaining)`}
          </button>
        </div>
      )}
    </div>
  );
}
