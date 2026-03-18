/**
 * PlanTableWidget — Pure canvas widget for rendering plan artifacts.
 * Receives all data via props (no internal fetching).
 *
 * Supports: plan_table, plan_csv, inventory_projection, solver_meta
 */

import React, { useMemo, useState, useCallback } from 'react';
import { ClipboardList, Download, ArrowUpDown, Edit3, Check } from 'lucide-react';

function KPIPill({ label, value, unit = '' }) {
  return (
    <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}{unit && <span className="text-xs ml-1">{unit}</span>}
      </span>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.data - Plan artifact payload
 * @param {Array}  [props.data.rows] - plan rows [{ material_code, period, order_qty, ... }]
 * @param {object} [props.data.solver_meta] - solver metadata
 * @param {object} [props.data.inventory_projection] - inventory projection data
 * @param {Function} [props.onApprove] - callback when user approves the plan
 * @param {Function} [props.onEdit] - callback with edited rows
 */
export default function PlanTableWidget({ data = {}, onApprove, onEdit }) {
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [editingRow, setEditingRow] = useState(null);
  const [editValue, setEditValue] = useState('');

  const rows = data.rows || data.plan_table || data.plan_rows || [];
  const solverMeta = data.solver_meta || {};
  const isEditable = typeof onEdit === 'function';

  const totalQty = useMemo(() => rows.reduce((s, r) => s + (r.order_qty || r.quantity || 0), 0), [rows]);
  const uniqueMaterials = useMemo(() => new Set(rows.map(r => r.material_code || r.sku)).size, [rows]);

  const sorted = useMemo(() => {
    if (!sortField) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortField], bv = b[sortField];
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
      return sortDir === 'asc' ? String(av || '').localeCompare(String(bv || '')) : String(bv || '').localeCompare(String(av || ''));
    });
  }, [rows, sortField, sortDir]);

  const toggleSort = useCallback((field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }, [sortField]);

  const handleEditSave = useCallback((rowIdx) => {
    if (onEdit) {
      const updated = [...rows];
      updated[rowIdx] = { ...updated[rowIdx], order_qty: Number(editValue) || updated[rowIdx].order_qty };
      onEdit(updated);
    }
    setEditingRow(null);
    setEditValue('');
  }, [rows, editValue, onEdit]);

  // Detect columns from first row
  const columns = useMemo(() => {
    if (!rows.length) return [];
    const preferred = ['material_code', 'sku', 'plant_id', 'period', 'order_qty', 'quantity', 'supplier', 'lead_time', 'unit_cost'];
    const keys = Object.keys(rows[0]);
    const ordered = preferred.filter(k => keys.includes(k));
    keys.forEach(k => { if (!ordered.includes(k)) ordered.push(k); });
    return ordered.slice(0, 8); // cap visible columns
  }, [rows]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <ClipboardList size={18} className="text-blue-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Replenishment Plan
            {solverMeta.solver && <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({solverMeta.solver})</span>}
          </h3>
        </div>
        {onApprove && (
          <button
            onClick={onApprove}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
          >
            <Check size={14} /> Approve Plan
          </button>
        )}
      </div>

      {/* KPI Strip */}
      <div className="flex gap-3 px-4 py-3 overflow-x-auto">
        <KPIPill label="Order Lines" value={rows.length} />
        <KPIPill label="Materials" value={uniqueMaterials} />
        <KPIPill label="Total Qty" value={Math.round(totalQty)} />
        {solverMeta.objective_value != null && <KPIPill label="Objective" value={solverMeta.objective_value.toLocaleString()} />}
        {solverMeta.solve_time_ms != null && <KPIPill label="Solve Time" value={`${solverMeta.solve_time_ms}ms`} />}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {sorted.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                {columns.map(col => (
                  <th
                    key={col}
                    className="pb-2 font-medium cursor-pointer hover:text-indigo-600 select-none"
                    onClick={() => toggleSort(col)}
                  >
                    <span className="flex items-center gap-1">
                      {col.replace(/_/g, ' ')}
                      {sortField === col && <ArrowUpDown size={12} />}
                    </span>
                  </th>
                ))}
                {isEditable && <th className="pb-2 font-medium w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  {columns.map(col => (
                    <td key={col} className="py-1.5">
                      {editingRow === i && col === 'order_qty' ? (
                        <input
                          type="number"
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleEditSave(i)}
                          onBlur={() => handleEditSave(i)}
                          className="w-20 px-1 py-0.5 border rounded text-sm"
                          autoFocus
                        />
                      ) : (
                        typeof row[col] === 'number' ? row[col].toLocaleString() : (row[col] ?? '-')
                      )}
                    </td>
                  ))}
                  {isEditable && (
                    <td className="py-1.5 text-center">
                      <button
                        onClick={() => { setEditingRow(i); setEditValue(String(row.order_qty || '')); }}
                        className="p-1 rounded hover:bg-gray-100"
                        title="Edit quantity"
                      >
                        <Edit3 size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No plan data available
          </div>
        )}
      </div>
    </div>
  );
}
