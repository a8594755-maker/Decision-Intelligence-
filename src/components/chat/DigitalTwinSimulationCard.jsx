import React from 'react';
import { Cpu } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, Badge } from '../ui';
import { useNavigate } from 'react-router-dom';

export default function DigitalTwinSimulationCard({ payload }) {
  const navigate = useNavigate();
  if (!payload) return null;

  const kpis = payload.kpis || {};
  const timeline = payload.timeline_mini || [];

  const fmt = (v) => (v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—');

  return (
    <Card category="analysis" className="w-full border border-purple-200 dark:border-purple-800 bg-purple-50/60 dark:bg-purple-900/10 p-4">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2 text-[var(--text-primary)]">
              <Cpu className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              Digital Twin Simulation
            </h4>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Scenario: <span className="capitalize">{payload.scenario || 'N/A'}</span>
              {payload.elapsed_seconds != null && ` · ${payload.elapsed_seconds.toFixed(1)}s`}
            </p>
          </div>
          <Badge type={kpis.fill_rate_pct >= 95 ? 'success' : 'warning'}>
            Fill Rate: {kpis.fill_rate_pct != null ? kpis.fill_rate_pct + '%' : '—'}
          </Badge>
        </div>

        {/* KPI row */}
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge type="info">Cost: ${fmt(kpis.total_cost)}</Badge>
          <Badge type="info">Avg Inv: {fmt(kpis.avg_inventory)}</Badge>
          <Badge type="info">Turns: {kpis.inventory_turns != null ? Number(kpis.inventory_turns).toFixed(1) : '—'}</Badge>
          <Badge type={kpis.stockout_days > 10 ? 'danger' : 'info'}>
            Stockout: {kpis.stockout_days ?? '—'} days
          </Badge>
        </div>

        {/* Mini timeline */}
        {timeline.length > 0 && (
          <div className="bg-[var(--surface-card)] rounded border border-[var(--border-default)] p-2">
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={timeline}>
                <XAxis dataKey="date" hide />
                <YAxis hide />
                <Tooltip />
                <Line type="monotone" dataKey="inventory" stroke="#2563eb" strokeWidth={1.5} dot={false} name="Inventory" />
                <Line type="monotone" dataKey="demand" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="3 3" name="Demand" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Link to full page */}
        <button
          onClick={() => navigate('/digital-twin')}
          className="text-xs text-purple-600 dark:text-purple-400 hover:underline"
        >
          Open full Digital Twin page →
        </button>
      </div>
    </Card>
  );
}
