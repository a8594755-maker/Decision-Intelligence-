import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';

export default function BomBottlenecksCard({ payload }) {
  if (!payload) return null;

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const hasRows = rows.length > 0;

  return (
    <Card className="w-full border border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            BOM Bottlenecks
          </h4>
          <Badge type={hasRows ? 'warning' : 'success'}>{hasRows ? `${rows.length} items` : 'None'}</Badge>
        </div>

        {!hasRows ? (
          <p className="text-xs text-slate-600 dark:text-slate-300">No component bottlenecks were detected in this run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden">
              <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                <tr>
                  <th className="px-2 py-1.5 text-left">Component</th>
                  <th className="px-2 py-1.5 text-left">Plant</th>
                  <th className="px-2 py-1.5 text-right">Missing Qty</th>
                  <th className="px-2 py-1.5 text-left">Affected FG</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((row, idx) => (
                  <tr key={`${row.component_sku}-${row.plant_id || 'NA'}-${idx}`} className="border-t border-slate-200 dark:border-slate-700">
                    <td className="px-2 py-1.5 font-mono">{row.component_sku || 'N/A'}</td>
                    <td className="px-2 py-1.5">{row.plant_id || '-'}</td>
                    <td className="px-2 py-1.5 text-right">{Number(row.missing_qty || 0).toFixed(2)}</td>
                    <td className="px-2 py-1.5">{Array.isArray(row.affected_fg_skus) ? row.affected_fg_skus.slice(0, 3).join(', ') : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
