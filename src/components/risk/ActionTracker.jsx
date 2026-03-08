/**
 * ActionTracker
 *
 * Prioritized list of recommended actions from risk analysis.
 * Supports status tracking, owner assignment, and filtering.
 */

import React, { useState, useMemo } from 'react';
import {
  Truck, ArrowRightLeft, UserCheck, ShieldPlus, BarChart3, Upload,
  ChevronDown, CheckCircle, Clock, XCircle, AlertTriangle
} from 'lucide-react';
import { Card, Badge } from '../ui';
import { ACTION_TYPES, ACTION_STATUS, URGENCY_LEVELS } from '../../domains/risk/actionRecommender';

const ACTION_ICONS = {
  [ACTION_TYPES.EXPEDITE]: Truck,
  [ACTION_TYPES.TRANSFER_STOCK]: ArrowRightLeft,
  [ACTION_TYPES.CHANGE_SUPPLIER]: UserCheck,
  [ACTION_TYPES.INCREASE_SAFETY]: ShieldPlus,
  [ACTION_TYPES.REVIEW_DEMAND]: BarChart3,
  [ACTION_TYPES.UPLOAD_DATA]: Upload,
};

const URGENCY_STYLES = {
  [URGENCY_LEVELS.CRITICAL]: { badge: 'error', dot: 'bg-red-500' },
  [URGENCY_LEVELS.HIGH]: { badge: 'warning', dot: 'bg-amber-500' },
  [URGENCY_LEVELS.MEDIUM]: { badge: 'info', dot: 'bg-blue-500' },
  [URGENCY_LEVELS.LOW]: { badge: 'info', dot: 'bg-slate-400' },
};

const STATUS_ICONS = {
  [ACTION_STATUS.OPEN]: Clock,
  [ACTION_STATUS.IN_PROGRESS]: AlertTriangle,
  [ACTION_STATUS.DONE]: CheckCircle,
  [ACTION_STATUS.DISMISSED]: XCircle,
};

export default function ActionTracker({ actions = [], onStatusChange, onDismiss }) {
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterUrgency, setFilterUrgency] = useState('all');

  const filtered = useMemo(() => {
    let result = [...actions];
    if (filterStatus !== 'all') result = result.filter(a => a.status === filterStatus);
    if (filterUrgency !== 'all') result = result.filter(a => a.urgency === filterUrgency);
    result.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return result;
  }, [actions, filterStatus, filterUrgency]);

  const summary = useMemo(() => {
    const byUrgency = { critical: 0, high: 0, medium: 0, low: 0 };
    actions.forEach(a => { byUrgency[a.urgency] = (byUrgency[a.urgency] || 0) + 1; });
    return byUrgency;
  }, [actions]);

  if (actions.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-slate-500">
        No actions generated. Run a risk analysis to see recommendations.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary badges */}
      <div className="flex flex-wrap gap-2">
        <Badge type="error">{summary.critical} critical</Badge>
        <Badge type="warning">{summary.high} high</Badge>
        <Badge type="info">{summary.medium + summary.low} other</Badge>
        <span className="text-xs text-slate-500 self-center">{actions.length} total actions</span>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        >
          <option value="all">All Status</option>
          <option value={ACTION_STATUS.OPEN}>Open</option>
          <option value={ACTION_STATUS.IN_PROGRESS}>In Progress</option>
          <option value={ACTION_STATUS.DONE}>Done</option>
          <option value={ACTION_STATUS.DISMISSED}>Dismissed</option>
        </select>
        <select
          value={filterUrgency}
          onChange={e => setFilterUrgency(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        >
          <option value="all">All Urgency</option>
          <option value={URGENCY_LEVELS.CRITICAL}>Critical</option>
          <option value={URGENCY_LEVELS.HIGH}>High</option>
          <option value={URGENCY_LEVELS.MEDIUM}>Medium</option>
          <option value={URGENCY_LEVELS.LOW}>Low</option>
        </select>
      </div>

      {/* Action list */}
      <div className="space-y-2">
        {filtered.map((action, i) => {
          const Icon = ACTION_ICONS[action.type] || AlertTriangle;
          const urgStyle = URGENCY_STYLES[action.urgency] || URGENCY_STYLES.low;
          const StatusIcon = STATUS_ICONS[action.status] || Clock;

          return (
            <Card key={action.id || i} className="!p-3">
              <div className="flex items-start gap-3">
                {/* Icon */}
                <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 flex-shrink-0">
                  <Icon className="w-4 h-4 text-slate-600 dark:text-slate-400" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {action.title}
                    </span>
                    <span className={`w-2 h-2 rounded-full ${urgStyle.dot} flex-shrink-0`} title={action.urgency} />
                    <Badge type={urgStyle.badge} className="text-[9px]">{action.urgency}</Badge>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                    {action.description}
                  </p>

                  <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-400">
                    {action.sku && <span>SKU: {action.sku}</span>}
                    {action.plant_id && <span>Plant: {action.plant_id}</span>}
                    {action.expected_impact_usd > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        Impact: ${action.expected_impact_usd.toLocaleString()}
                      </span>
                    )}
                    {action.reason_code && (
                      <span className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-700">
                        {action.reason_code}
                      </span>
                    )}
                  </div>
                </div>

                {/* Status controls */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <select
                    value={action.status || ACTION_STATUS.OPEN}
                    onChange={e => onStatusChange?.(action.id, e.target.value)}
                    className="text-[10px] px-1.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                  >
                    <option value={ACTION_STATUS.OPEN}>Open</option>
                    <option value={ACTION_STATUS.IN_PROGRESS}>In Progress</option>
                    <option value={ACTION_STATUS.DONE}>Done</option>
                  </select>
                  <button
                    onClick={() => onDismiss?.(action.id)}
                    className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600"
                    title="Dismiss"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-xs text-slate-400 py-4">
          No actions match the current filters.
        </p>
      )}
    </div>
  );
}
