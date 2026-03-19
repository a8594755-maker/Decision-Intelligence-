/**
 * InventoryWidget — Pure canvas widget for inventory projection artifacts.
 * Receives all data via props (no internal fetching).
 *
 * Supports: inventory_projection, risk_inventory_projection
 */

import React, { useMemo, useState } from 'react';
import { Package, AlertTriangle, TrendingDown, BarChart3, Table2 } from 'lucide-react';

function Sparkline({ values = [], width = 200, height = 40, color = '#6366f1', dangerThreshold }) {
  if (!values.length) return null;
  const max = Math.max(...values, dangerThreshold || 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const denominator = values.length > 1 ? values.length - 1 : 1;
  const points = values.map((v, i) =>
    `${(i / denominator) * width},${height - ((v - min) / range) * height}`
  ).join(' ');
  const thresholdY = dangerThreshold != null
    ? height - ((dangerThreshold - min) / range) * height
    : null;
  return (
    <svg width={width} height={height} className="inline-block">
      {thresholdY != null && (
        <line x1={0} y1={thresholdY} x2={width} y2={thresholdY} stroke="#ef4444" strokeWidth="1" strokeDasharray="4,4" />
      )}
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
    </svg>
  );
}

/**
 * @param {object} props
 * @param {object} props.data
 * @param {Array}  [props.data.projections] - [{ material_code, period, on_hand, safety_stock, ... }]
 * @param {Array}  [props.data.stockout_alerts] - materials at risk of stockout
 */
export default function InventoryWidget({ data = {} }) {
  const [viewMode, setViewMode] = useState('chart');

  const projections = useMemo(() => data.projections || data.rows || [], [data.projections, data.rows]);
  const alerts = data.stockout_alerts || [];

  // Group by material for chart view
  const byMaterial = useMemo(() => {
    const map = {};
    projections.forEach(p => {
      const key = p.material_code || p.sku || 'unknown';
      if (!map[key]) map[key] = [];
      map[key].push(p);
    });
    return map;
  }, [projections]);

  const materialKeys = Object.keys(byMaterial);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <Package size={18} className="text-teal-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Inventory Projection</h3>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setViewMode('chart')} className={`p-1.5 rounded ${viewMode === 'chart' ? 'bg-teal-100 text-teal-600' : ''}`}>
            <BarChart3 size={14} />
          </button>
          <button onClick={() => setViewMode('table')} className={`p-1.5 rounded ${viewMode === 'table' ? 'bg-teal-100 text-teal-600' : ''}`}>
            <Table2 size={14} />
          </button>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap gap-2">
          {alerts.map((a, i) => (
            <span key={i} className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-red-50 text-red-700 border border-red-200">
              <AlertTriangle size={12} /> {a.material_code || a}: Stockout Risk
            </span>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {viewMode === 'chart' ? (
          <div className="space-y-4">
            {materialKeys.length > 0 ? materialKeys.slice(0, 10).map(mat => {
              const rows = byMaterial[mat];
              const values = rows.map(r => r.on_hand ?? r.ending_inventory ?? 0);
              const ss = rows[0]?.safety_stock;
              return (
                <div key={mat} className="p-3 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
                  <span className="text-xs font-semibold block mb-1">{mat}</span>
                  <Sparkline values={values} width={400} height={60} color="#14b8a6" dangerThreshold={ss} />
                  {ss != null && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Safety stock: {ss}</span>}
                </div>
              );
            }) : (
              <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
                No inventory data available
              </div>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium">Material</th>
                <th className="pb-2 font-medium">Period</th>
                <th className="pb-2 font-medium text-right">On Hand</th>
                <th className="pb-2 font-medium text-right">Safety Stock</th>
                <th className="pb-2 font-medium text-right">Inbound</th>
                <th className="pb-2 font-medium text-right">Demand</th>
              </tr>
            </thead>
            <tbody>
              {projections.slice(0, 200).map((row, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-1.5 font-medium">{row.material_code || row.sku || '-'}</td>
                  <td className="py-1.5">{row.period || row.date || '-'}</td>
                  <td className="py-1.5 text-right font-mono">{row.on_hand?.toLocaleString() ?? row.ending_inventory?.toLocaleString() ?? '-'}</td>
                  <td className="py-1.5 text-right">{row.safety_stock?.toLocaleString() ?? '-'}</td>
                  <td className="py-1.5 text-right">{row.inbound?.toLocaleString() ?? row.receipts?.toLocaleString() ?? '-'}</td>
                  <td className="py-1.5 text-right">{row.demand?.toLocaleString() ?? row.consumption?.toLocaleString() ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
