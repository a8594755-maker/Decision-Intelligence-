import React, { useState, useMemo } from 'react';
import { Table2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card } from '../ui';

const EMPTY_ROWS = [];
const PAGE_SIZE = 50;
const formatQty = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00');

export default function PlanTableCard({ payload }) {
  const [page, setPage] = useState(0);
  const rows = Array.isArray(payload?.rows) ? payload.rows : EMPTY_ROWS;
  const totalPages = Math.ceil(rows.length / PAGE_SIZE) || 1;

  const pageRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [rows, page]);

  if (!payload) return null;

  return (
    <Card className="w-full border border-slate-200 dark:border-slate-700">
      <div className="space-y-3">
        <div>
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <Table2 className="w-4 h-4 text-slate-700 dark:text-slate-200" />
            Plan Table
          </h4>
          <p className="text-xs text-slate-500">Showing {rows.length} of {payload.total_rows || rows.length} lines.</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-slate-200 dark:border-slate-700">
            <thead className="bg-slate-100 dark:bg-slate-700">
              <tr>
                <th className="px-2 py-1 text-left">SKU</th>
                <th className="px-2 py-1 text-left">Plant</th>
                <th className="px-2 py-1 text-left">Order Date</th>
                <th className="px-2 py-1 text-left">Arrival Date</th>
                <th className="px-2 py-1 text-right">Order Qty</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => (
                <tr key={`${row.sku}-${row.plant_id || 'na'}-${row.order_date}-${page * PAGE_SIZE + index}`} className="border-t border-slate-200 dark:border-slate-700">
                  <td className="px-2 py-1 font-medium">{row.sku}</td>
                  <td className="px-2 py-1">{row.plant_id || 'N/A'}</td>
                  <td className="px-2 py-1">{row.order_date}</td>
                  <td className="px-2 py-1">{row.arrival_date}</td>
                  <td className="px-2 py-1 text-right">{formatQty(row.order_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Page {page + 1} of {totalPages} ({rows.length} rows)</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
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
