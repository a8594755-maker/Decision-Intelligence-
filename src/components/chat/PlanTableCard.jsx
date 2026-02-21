import React from 'react';
import { Table2 } from 'lucide-react';
import { Card } from '../ui';

const formatQty = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00');

export default function PlanTableCard({ payload }) {
  if (!payload) return null;

  const rows = Array.isArray(payload.rows) ? payload.rows : [];

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
              {rows.map((row, index) => (
                <tr key={`${row.sku}-${row.plant_id || 'na'}-${row.order_date}-${index}`} className="border-t border-slate-200 dark:border-slate-700">
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

        {payload.truncated && (
          <p className="text-xs text-amber-700 dark:text-amber-300">Table truncated for chat. Download full plan.csv for all rows.</p>
        )}
      </div>
    </Card>
  );
}
