import React, { useState, useMemo } from 'react';
import { Table2, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { Card } from '../ui';

const EMPTY_ROWS = [];
const PAGE_SIZE = 50;
const formatQty = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00');

function RowQualityBadge({ meta }) {
  if (!meta || !meta.fallback_fields || meta.fallback_fields.length === 0) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Full</span>;
  }
  const fallbackNames = meta.fallback_fields.map(f => f.field).join(', ');
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 cursor-help"
      title={`Estimated: ${fallbackNames}`}
    >
      Est. ({meta.fallback_fields.length})
    </span>
  );
}

function LineageSummaryBanner({ summary }) {
  if (!summary) return null;
  const { rows_with_fallback, rows_with_full_data, datasets_missing } = summary;
  if (!rows_with_fallback && (!datasets_missing || datasets_missing.length === 0)) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px]">
      {rows_with_full_data > 0 && (
        <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
          {rows_with_full_data} rows full data
        </span>
      )}
      {rows_with_fallback > 0 && (
        <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-1">
          <Info className="w-3 h-3" />
          {rows_with_fallback} rows with estimated fields
        </span>
      )}
      {datasets_missing?.length > 0 && (
        <span className="px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
          Missing: {datasets_missing.join(', ')}
        </span>
      )}
    </div>
  );
}

export default function PlanTableCard({ payload }) {
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState(null);
  const rows = Array.isArray(payload?.rows) ? payload.rows : EMPTY_ROWS;
  const totalPages = Math.ceil(rows.length / PAGE_SIZE) || 1;
  const hasLineage = rows.some(r => r._meta);

  const pageRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [rows, page]);

  if (!payload) return null;

  return (
    <Card category="plan" className="w-full border border-[var(--border-default)]">
      <div className="space-y-3">
        <div>
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <Table2 className="w-4 h-4 text-[var(--text-secondary)]" />
            Plan Table
          </h4>
          <p className="text-xs text-[var(--text-muted)]">Showing {rows.length} of {payload.total_rows || rows.length} lines.</p>
          <LineageSummaryBanner summary={payload.lineage_summary} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-[var(--border-default)]">
            <thead className="bg-[var(--surface-subtle)]">
              <tr>
                <th className="px-2 py-1 text-left">SKU</th>
                <th className="px-2 py-1 text-left">Plant</th>
                <th className="px-2 py-1 text-left">Order Date</th>
                <th className="px-2 py-1 text-left">Arrival Date</th>
                <th className="px-2 py-1 text-right">Order Qty</th>
                {hasLineage && <th className="px-2 py-1 text-center">Quality</th>}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => {
                const rowIdx = page * PAGE_SIZE + index;
                const isSelected = selectedRow === rowIdx;
                return (
                  <tr
                    key={`${row.sku}-${row.plant_id || 'na'}-${row.order_date}-${rowIdx}`}
                    className={`border-t border-[var(--border-default)] cursor-pointer transition-colors ${isSelected ? 'bg-[var(--accent-active)]' : 'hover:bg-[var(--accent-hover)]'}`}
                    onClick={() => setSelectedRow(isSelected ? null : rowIdx)}
                  >
                    <td className="px-2 py-1 font-medium">{row.sku}</td>
                    <td className="px-2 py-1">{row.plant_id || 'N/A'}</td>
                    <td className="px-2 py-1">{row.order_date}</td>
                    <td className="px-2 py-1">{row.arrival_date}</td>
                    <td className="px-2 py-1 text-right">{formatQty(row.order_qty)}</td>
                    {hasLineage && (
                      <td className="px-2 py-1 text-center">
                        <RowQualityBadge meta={row._meta} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Row detail drawer (inline) */}
        {selectedRow != null && rows[selectedRow]?._meta && (
          <div className="border border-[var(--brand-500)] rounded-lg p-3 bg-[var(--accent-active)] space-y-2">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-semibold text-[var(--brand-600)]">
                Row Detail: {rows[selectedRow].sku} / {rows[selectedRow].plant_id || 'N/A'}
              </h5>
              <button
                onClick={() => setSelectedRow(null)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="font-medium text-[var(--text-secondary)]">Datasets Used</span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {rows[selectedRow]._meta.datasets_used?.map(d => (
                    <span key={d} className="px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">{d}</span>
                  ))}
                </div>
              </div>
              <div>
                <span className="font-medium text-[var(--text-secondary)]">Confidence</span>
                <div className="mt-0.5">
                  {((rows[selectedRow]._meta.confidence || 0) * 100).toFixed(0)}%
                </div>
              </div>
            </div>
            {rows[selectedRow]._meta.fallback_fields?.length > 0 && (
              <div className="text-[11px]">
                <span className="font-medium text-amber-700 dark:text-amber-400">Estimated Fields</span>
                <div className="mt-0.5 space-y-0.5">
                  {rows[selectedRow]._meta.fallback_fields.map((fb, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-amber-600 dark:text-amber-400">{fb.field}</span>
                      <span className="text-[var(--text-muted)]">= {fb.value} (source: {fb.source})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Page {page + 1} of {totalPages} ({rows.length} rows)</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="p-1 rounded hover:bg-[var(--accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="p-1 rounded hover:bg-[var(--accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {payload.truncated && (
          <p className="text-xs text-amber-700 dark:text-amber-300">Table truncated for chat. Download full plan.csv for all rows.</p>
        )}
      </div>
    </Card>
  );
}
