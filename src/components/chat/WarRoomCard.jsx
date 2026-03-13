/**
 * WarRoomCard.jsx
 *
 * Renders the multi-agent War Room summary in chat.
 * Shows activated agents, findings by severity, and recommendations.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  🎯 War Room — Plan #42                         │
 *   │  Status: CRITICAL │ 3 agents │ 5 findings       │
 *   │  ─────────────────────────────────────────────  │
 *   │  Agents: [Planner ✓] [Risk ✓] [Approval ✓]     │
 *   │  ─────────────────────────────────────────────  │
 *   │  Critical Findings (red)                        │
 *   │  Warning Findings (amber)                       │
 *   │  ─────────────────────────────────────────────  │
 *   │  Recommendations [action buttons]               │
 *   └─────────────────────────────────────────────────┘
 */

import React, { useState } from 'react';
import {
  Target,
  ShieldCheck,
  AlertTriangle,
  AlertOctagon,
  Info,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  Users,
} from 'lucide-react';
import { Card, Badge } from '../ui';

const AGENT_ICONS = {
  planner: '📋',
  risk_analyst: '🛡️',
  negotiator: '🤝',
  approval_officer: '✅',
  coordinator: '🎯',
};

const STATUS_STYLES = {
  critical: { label: 'Critical', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300' },
  needs_attention: { label: 'Needs Attention', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300' },
  healthy: { label: 'Healthy', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
};

const SEVERITY_STYLES = {
  critical: { Icon: AlertOctagon, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/15' },
  warning: { Icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/15' },
  info: { Icon: Info, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/15' },
};

function FindingItem({ finding }) {
  const style = SEVERITY_STYLES[finding.severity] || SEVERITY_STYLES.info;
  const SevIcon = style.Icon;

  return (
    <div className={`flex items-start gap-2 rounded-md ${style.bg} px-2.5 py-1.5 text-xs`}>
      <SevIcon className={`w-3.5 h-3.5 ${style.color} shrink-0 mt-0.5`} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-700 dark:text-slate-200">{finding.title}</div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{finding.detail}</div>
      </div>
      <span className="text-[10px] font-mono text-slate-400 shrink-0 capitalize">{finding.agent}</span>
    </div>
  );
}

/**
 * @param {Object} props
 * @param {Object} props.payload - War room summary card payload
 * @param {Function} [props.onActionClick] - (action_type) => void
 */
export default function WarRoomCard({ payload, onActionClick }) {
  const [showAllFindings, setShowAllFindings] = useState(false);

  if (!payload) return null;

  const {
    session_id,
    trigger,
    plan_run_id,
    agents_activated = [],
    findings_summary = {},
    findings = [],
    recommendations = [],
    overall_status = 'healthy',
  } = payload;

  const statusStyle = STATUS_STYLES[overall_status] || STATUS_STYLES.healthy;

  const criticalFindings = findings.filter(f => f.severity === 'critical');
  const warningFindings = findings.filter(f => f.severity === 'warning');
  const infoFindings = findings.filter(f => f.severity === 'info');
  const visibleFindings = showAllFindings ? findings : [...criticalFindings, ...warningFindings.slice(0, 2)];

  return (
    <Card className="border border-slate-300 dark:border-slate-600 bg-gradient-to-br from-white to-slate-50/50 dark:from-slate-900 dark:to-slate-800/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-slate-100 dark:bg-slate-800">
            <Users className="w-4 h-4 text-slate-600 dark:text-slate-300" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 uppercase tracking-wider">
              War Room
            </span>
            <span className="ml-2 text-[11px] text-slate-500">
              Plan #{plan_run_id} · {trigger}
            </span>
          </div>
        </div>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusStyle.bg} ${statusStyle.text}`}>
          {statusStyle.label}
        </span>
      </div>

      {/* Agents activated */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {agents_activated.map(agent => (
          <span
            key={agent}
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
          >
            <span>{AGENT_ICONS[agent] || '🤖'}</span>
            <span className="capitalize">{agent.replace(/_/g, ' ')}</span>
            <ShieldCheck className="w-2.5 h-2.5 text-emerald-500" />
          </span>
        ))}
      </div>

      {/* Findings summary bar */}
      <div className="flex items-center gap-3 mb-3 text-[10px]">
        {findings_summary.critical > 0 && (
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
            <AlertOctagon className="w-3 h-3" />
            {findings_summary.critical} critical
          </span>
        )}
        {findings_summary.warning > 0 && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
            <AlertTriangle className="w-3 h-3" />
            {findings_summary.warning} warning
          </span>
        )}
        {findings_summary.info > 0 && (
          <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
            <Info className="w-3 h-3" />
            {findings_summary.info} info
          </span>
        )}
      </div>

      {/* Findings list */}
      {visibleFindings.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {visibleFindings.map((f, i) => (
            <FindingItem key={f.id || i} finding={f} />
          ))}
          {findings.length > visibleFindings.length && !showAllFindings && (
            <button
              type="button"
              onClick={() => setShowAllFindings(true)}
              className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-0.5"
            >
              <ChevronDown className="w-3 h-3" />
              Show {findings.length - visibleFindings.length} more
            </button>
          )}
          {showAllFindings && findings.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAllFindings(false)}
              className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-0.5"
            >
              <ChevronUp className="w-3 h-3" />
              Show less
            </button>
          )}
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-700 pt-2.5 mt-1">
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
            Recommendations
          </div>
          <div className="space-y-1.5">
            {recommendations.map((rec, i) => (
              <div
                key={rec.id || i}
                className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5"
              >
                <span className="text-[10px] font-mono text-slate-400 capitalize shrink-0">
                  {rec.agent?.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-slate-700 dark:text-slate-200 flex-1">{rec.label}</span>
                {rec.requires_approval && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                    Needs Approval
                  </span>
                )}
                {onActionClick && rec.action_type && (
                  <button
                    type="button"
                    onClick={() => onActionClick(rec.action_type)}
                    className="shrink-0 p-1 rounded hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400"
                  >
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
