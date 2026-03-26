import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Card, Badge } from '../ui';
const EMPTY_ITEMS = [];

const formatEntity = (item = {}) => {
  if (item.entity_type === 'supplier') return item.supplier || item.entity_id;
  if (item.entity_type === 'material') return item.material_code || item.entity_id;
  const supplier = item.supplier || 'unknown_supplier';
  const material = item.material_code || 'unknown_material';
  const plant = item.plant_id ? ` @ ${item.plant_id}` : '';
  return `${supplier} / ${material}${plant}`;
};

const fmt = (value, digits = 2) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'N/A';
  return num.toFixed(digits);
};

export default function RiskDrilldownCard({ payload }) {
  const items = Array.isArray(payload?.items) ? payload.items : EMPTY_ITEMS;
  const [entityId, setEntityId] = useState('');

  const selected = useMemo(() => {
    if (!items.length) return null;
    if (entityId) {
      const match = items.find((item) => item.entity_id === entityId);
      if (match) return match;
    }
    return items[0];
  }, [items, entityId]);

  if (!payload) return null;

  return (
    <Card category="risk" className="w-full border border-cyan-200 dark:border-cyan-800 bg-cyan-50/50 dark:bg-cyan-900/10">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <Search className="w-4 h-4 text-cyan-600" />
              Risk Drilldown
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              Run #{payload.run_id || 'N/A'} | {items.length} entities
            </p>
          </div>
          <Badge type="info">Evidence drivers</Badge>
        </div>

        {items.length > 0 && (
          <select
            value={selected?.entity_id || ''}
            onChange={(event) => setEntityId(event.target.value)}
            className="text-xs px-2 py-1 rounded border border-[var(--border-default)] bg-[var(--surface-card)]"
          >
            {items.map((item) => (
              <option key={`${item.entity_type}-${item.entity_id}`} value={item.entity_id}>
                {formatEntity(item)} ({fmt(item.risk_score, 1)})
              </option>
            ))}
          </select>
        )}

        {!selected ? (
          <p className="text-xs text-[var(--text-muted)]">No drilldown rows available.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge type="warning">score {fmt(selected.risk_score, 1)}</Badge>
              <Badge type="info">on-time {fmt((selected.metrics?.on_time_rate || 0) * 100, 1)}%</Badge>
              <Badge type="info">avg delay {fmt(selected.metrics?.avg_delay_days, 1)}d</Badge>
              <Badge type="info">overdue {fmt(selected.metrics?.overdue_open_qty, 0)}</Badge>
            </div>

            {(selected.drivers || []).length > 0 && (
              <div>
                <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Driver breakdown</p>
                <ul className="list-disc list-inside text-xs text-[var(--text-secondary)] space-y-1">
                  {(selected.drivers || []).map((driver, index) => (
                    <li key={`${driver.name}-${index}`}>
                      <strong>{driver.name}</strong>: normalized {fmt(driver.normalized_value, 3)}, contribution {fmt(driver.contribution, 3)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(selected.evidence_refs || []).length > 0 && (
              <div>
                <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Evidence refs</p>
                <p className="text-xs text-[var(--text-secondary)] break-all">
                  {(selected.evidence_refs || []).join(', ')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
