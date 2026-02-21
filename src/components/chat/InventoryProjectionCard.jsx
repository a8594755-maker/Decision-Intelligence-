import React, { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { LineChart as LineChartIcon } from 'lucide-react';
import { Card } from '../ui';

export default function InventoryProjectionCard({ payload }) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const [groupKey, setGroupKey] = useState('');
  const selectedKey = useMemo(() => {
    if (!groups.length) return '';
    if (groupKey && groups.some((group) => group.key === groupKey)) {
      return groupKey;
    }
    return groups[0].key;
  }, [groups, groupKey]);

  const selected = useMemo(
    () => groups.find((group) => group.key === selectedKey) || groups[0] || null,
    [groups, selectedKey]
  );

  const chartData = useMemo(() => {
    if (!selected?.points) return [];
    return selected.points.map((point) => ({
      date: point.date,
      with_plan: point.with_plan,
      without_plan: point.without_plan,
      demand: point.demand
    }));
  }, [selected]);

  if (!payload) return null;

  return (
    <Card className="w-full border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10">
      <div className="space-y-3">
        <div>
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <LineChartIcon className="w-4 h-4 text-blue-600" />
            Inventory Projection
          </h4>
          <p className="text-xs text-slate-500">Run #{payload.run_id || 'N/A'} | {payload.total_rows || 0} projection rows</p>
        </div>

        {groups.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-600 dark:text-slate-300">Series</span>
            <select
              value={selectedKey}
              onChange={(event) => setGroupKey(event.target.value)}
              className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
            >
              {groups.map((group) => (
                <option key={group.key} value={group.key}>
                  {group.sku} | {group.plant_id || 'N/A'}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="w-full h-64 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 p-2">
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tickFormatter={(value) => String(value || '').slice(-10)} fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="with_plan" name="With Plan" stroke="#2563eb" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="without_plan" name="Without Plan" stroke="#94a3b8" strokeDasharray="4 4" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="demand" name="Demand" stroke="#ef4444" strokeDasharray="2 4" strokeWidth={1} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {payload.truncated && (
          <p className="text-xs text-amber-700 dark:text-amber-300">Projection artifact truncated. Download full projection JSON.</p>
        )}
      </div>
    </Card>
  );
}
