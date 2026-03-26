import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, Badge } from '../ui';

const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;

function renderTableRows(rows = []) {
  if (!rows.length) {
    return (
      <tr>
        <td className="px-2 py-1 text-[var(--text-muted)]" colSpan={5}>No rows</td>
      </tr>
    );
  }

  return rows.map((row) => (
    <tr key={`${row.entity_type}-${row.entity_id}`} className="border-t border-[var(--border-default)]">
      <td className="px-2 py-1">
        {row.entity_type === 'supplier'
          ? (row.supplier || row.entity_id)
          : (row.material_code || row.entity_id)}
      </td>
      <td className="px-2 py-1">{Number(row.risk_score || 0).toFixed(1)}</td>
      <td className="px-2 py-1">{pct(row.metrics?.on_time_rate)}</td>
      <td className="px-2 py-1">{Number(row.metrics?.avg_delay_days || 0).toFixed(1)}</td>
      <td className="px-2 py-1">{Number(row.metrics?.overdue_open_qty || 0).toFixed(0)}</td>
    </tr>
  ));
}

export default function RiskSummaryCard({ payload }) {
  if (!payload) return null;

  const totals = payload.totals || {};
  const topSuppliers = Array.isArray(payload.top_supplier_risks) ? payload.top_supplier_risks : [];
  const topMaterials = Array.isArray(payload.top_material_risks) ? payload.top_material_risks : [];

  return (
    <Card category="risk" className="w-full border border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600" />
              Risk Summary
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              Run #{payload.run_id || 'N/A'} | {payload.workflow || 'workflow_B_risk_exceptions'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge type="warning">Entities: {totals.entities || 0}</Badge>
            <Badge type="warning">High: {totals.high_risk || 0}</Badge>
            <Badge type="info">Medium: {totals.medium_risk || 0}</Badge>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="overflow-x-auto">
            <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Top Supplier Risks</p>
            <table className="w-full text-xs border border-[var(--border-default)]">
              <thead className="bg-[var(--surface-subtle)]">
                <tr>
                  <th className="px-2 py-1 text-left">Supplier</th>
                  <th className="px-2 py-1 text-left">Score</th>
                  <th className="px-2 py-1 text-left">On-time</th>
                  <th className="px-2 py-1 text-left">Avg delay</th>
                  <th className="px-2 py-1 text-left">Overdue qty</th>
                </tr>
              </thead>
              <tbody>{renderTableRows(topSuppliers)}</tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Top Material Risks</p>
            <table className="w-full text-xs border border-[var(--border-default)]">
              <thead className="bg-[var(--surface-subtle)]">
                <tr>
                  <th className="px-2 py-1 text-left">Material</th>
                  <th className="px-2 py-1 text-left">Score</th>
                  <th className="px-2 py-1 text-left">On-time</th>
                  <th className="px-2 py-1 text-left">Avg delay</th>
                  <th className="px-2 py-1 text-left">Overdue qty</th>
                </tr>
              </thead>
              <tbody>{renderTableRows(topMaterials)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  );
}
