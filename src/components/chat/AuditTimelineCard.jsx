// ============================================
// AuditTimelineCard.jsx — Unified audit timeline for task history
// Shows chronological event timeline: step starts, completions,
// failures, retries, reviews, state transitions
// ============================================

import React, { useState, useMemo } from 'react';
import {
  Clock, CheckCircle2, XCircle, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, FileText, Eye, Shield,
} from 'lucide-react';

// ── Icon & color maps ────────────────────────────────────────

const EVENT_ICON = {
  step_started:      Clock,
  step_succeeded:    CheckCircle2,
  step_failed:       XCircle,
  step_retrying:     RefreshCw,
  step_blocked:      AlertTriangle,
  ai_review_passed:  CheckCircle2,
  ai_review_failed:  Eye,
  task_created:      FileText,
  task_approved:     Shield,
  task_completed:    CheckCircle2,
  task_failed:       XCircle,
};

const EVENT_COLOR = {
  step_started:      'text-blue-500',
  step_succeeded:    'text-emerald-500',
  step_failed:       'text-red-500',
  step_retrying:     'text-amber-500',
  step_blocked:      'text-red-400',
  ai_review_passed:  'text-emerald-600',
  ai_review_failed:  'text-amber-600',
  task_created:      'text-slate-500',
  task_approved:     'text-indigo-500',
  task_completed:    'text-emerald-600',
  task_failed:       'text-red-600',
};

const LINE_COLOR = {
  step_succeeded:   'border-emerald-400',
  step_failed:      'border-red-400',
  step_retrying:    'border-amber-400',
  task_completed:   'border-emerald-400',
  task_failed:      'border-red-400',
};

const MAJOR_TYPES = new Set([
  'task_created', 'task_approved', 'task_completed', 'task_failed',
  'step_succeeded', 'step_failed',
]);

// ── Helpers ──────────────────────────────────────────────────

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  // Older than 24h → absolute
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function computeStepDurations(events) {
  const starts = {};
  const durations = {};
  for (const evt of events) {
    const key = evt.step_name;
    if (!key) continue;
    if (evt.type === 'step_started') {
      starts[key] = new Date(evt.timestamp).getTime();
    } else if (
      (evt.type === 'step_succeeded' || evt.type === 'step_failed') &&
      starts[key]
    ) {
      const end = new Date(evt.timestamp).getTime();
      const ms = end - starts[key];
      if (ms >= 0) {
        durations[key] = ms;
        delete starts[key];
      }
    }
  }
  return durations;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Group consecutive retry events for the same step into a single
 * collapsed entry so the timeline stays readable.
 */
function groupRetries(events) {
  const result = [];
  let retryGroup = null;

  for (const evt of events) {
    if (evt.type === 'step_retrying') {
      if (retryGroup && retryGroup.step_name === evt.step_name) {
        retryGroup.count += 1;
        retryGroup.last = evt;
      } else {
        if (retryGroup) result.push(retryGroup);
        retryGroup = {
          _isRetryGroup: true,
          type: 'step_retrying',
          step_name: evt.step_name,
          count: 1,
          first: evt,
          last: evt,
          timestamp: evt.timestamp,
        };
      }
    } else {
      if (retryGroup) {
        result.push(retryGroup);
        retryGroup = null;
      }
      result.push(evt);
    }
  }
  if (retryGroup) result.push(retryGroup);
  return result;
}

function eventLabel(evt) {
  if (evt._isRetryGroup) {
    return `Retried "${evt.step_name}" ${evt.count} time${evt.count > 1 ? 's' : ''}`;
  }
  const name = evt.step_name ? `"${evt.step_name}"` : '';
  switch (evt.type) {
    case 'step_started':      return `Step ${name} started`;
    case 'step_succeeded':    return `Step ${name} succeeded`;
    case 'step_failed':       return `Step ${name} failed`;
    case 'step_retrying':     return `Retrying step ${name}`;
    case 'step_blocked':      return `Step ${name} blocked`;
    case 'ai_review_passed':  return `AI review passed ${name}`;
    case 'ai_review_failed':  return `AI review flagged issues ${name}`;
    case 'task_created':      return 'Task created';
    case 'task_approved':     return 'Task approved';
    case 'task_completed':    return 'Task completed';
    case 'task_failed':       return 'Task failed';
    default:                  return evt.type?.replace(/_/g, ' ') || 'Event';
  }
}

// ── Sub-components ───────────────────────────────────────────

function EventDetails({ evt }) {
  const hasDetails = evt.details || evt.message || (evt.artifacts && evt.artifacts.length > 0);
  if (!hasDetails) return null;

  return (
    <div
      className="mt-2 ml-1 text-xs space-y-1 rounded-md px-3 py-2"
      style={{
        background: 'var(--surface-card, rgba(100,116,139,0.06))',
        color: 'var(--text-secondary, #64748b)',
      }}
    >
      {evt.message && <p>{evt.message}</p>}
      {evt.details && typeof evt.details === 'string' && <p>{evt.details}</p>}
      {evt.details && typeof evt.details === 'object' && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {JSON.stringify(evt.details, null, 2)}
        </pre>
      )}
      {evt.artifacts && evt.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {evt.artifacts.map((art, i) => (
            <span
              key={i}
              className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                background: 'var(--surface-card, rgba(100,116,139,0.10))',
                color: 'var(--text-primary, #334155)',
              }}
            >
              {typeof art === 'string' ? art : art.type || art.id || `artifact-${i}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineEvent({ evt, isLast, stepDurations }) {
  const [expanded, setExpanded] = useState(false);
  const IconComp = EVENT_ICON[evt.type] || Clock;
  const colorClass = EVENT_COLOR[evt.type] || 'text-slate-400';
  const lineClass = LINE_COLOR[evt.type] || 'border-slate-300 dark:border-slate-600';

  const hasExpandable = evt.message || evt.details || (evt.artifacts && evt.artifacts.length > 0)
    || (evt._isRetryGroup && evt.last?.message);

  const duration = evt.step_name && (evt.type === 'step_succeeded' || evt.type === 'step_failed')
    ? stepDurations[evt.step_name]
    : null;

  return (
    <div className="flex gap-3 group">
      {/* Time column */}
      <div
        className="w-16 flex-shrink-0 text-right pt-0.5 text-[11px] font-mono"
        style={{ color: 'var(--text-secondary, #94a3b8)' }}
        title={evt.timestamp}
      >
        {formatRelativeTime(evt.timestamp)}
      </div>

      {/* Icon + connector line */}
      <div className="flex flex-col items-center">
        <div className={`mt-0.5 ${colorClass}`}>
          <IconComp size={16} />
        </div>
        {!isLast && (
          <div className={`flex-1 border-l-2 ${lineClass} mt-1 min-h-[20px]`} />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        <div className="flex items-start gap-1.5">
          <button
            className="flex items-center gap-1 text-left text-sm font-medium leading-tight hover:underline"
            style={{ color: 'var(--text-primary, #1e293b)' }}
            onClick={() => hasExpandable && setExpanded(!expanded)}
            disabled={!hasExpandable}
          >
            {hasExpandable && (
              expanded
                ? <ChevronDown size={12} className="flex-shrink-0 mt-0.5" />
                : <ChevronRight size={12} className="flex-shrink-0 mt-0.5" />
            )}
            <span>{eventLabel(evt)}</span>
          </button>
          {duration != null && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
              style={{
                background: 'var(--surface-card, rgba(100,116,139,0.08))',
                color: 'var(--text-secondary, #64748b)',
              }}
            >
              {formatDuration(duration)}
            </span>
          )}
        </div>

        {expanded && (
          evt._isRetryGroup
            ? <EventDetails evt={{ ...evt.last, message: evt.last?.message || `Retried ${evt.count} times` }} />
            : <EventDetails evt={evt} />
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────

export default function AuditTimelineCard({
  events = [],
  taskTitle,
  taskId,
  compact = false,
}) {
  const sorted = useMemo(
    () => [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
    [events],
  );

  const filtered = useMemo(
    () => (compact ? sorted.filter((e) => MAJOR_TYPES.has(e.type)) : sorted),
    [sorted, compact],
  );

  const grouped = useMemo(() => groupRetries(filtered), [filtered]);

  const stepDurations = useMemo(() => computeStepDurations(sorted), [sorted]);

  if (!events || events.length === 0) {
    return (
      <div
        className="rounded-xl border px-4 py-3 text-sm"
        style={{
          background: 'var(--surface-card, #fff)',
          borderColor: 'var(--border-primary, #e2e8f0)',
          color: 'var(--text-secondary, #64748b)',
        }}
      >
        No audit events recorded for this task.
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border px-4 py-4"
      style={{
        background: 'var(--surface-card, #fff)',
        borderColor: 'var(--border-primary, #e2e8f0)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3
            className="text-sm font-semibold leading-tight"
            style={{ color: 'var(--text-primary, #1e293b)' }}
          >
            {taskTitle || 'Task Audit Timeline'}
          </h3>
          {taskId && (
            <p
              className="text-[11px] font-mono mt-0.5"
              style={{ color: 'var(--text-secondary, #94a3b8)' }}
            >
              {taskId}
            </p>
          )}
        </div>
        <span
          className="text-[11px] px-2 py-0.5 rounded-full font-medium"
          style={{
            background: 'var(--surface-card, rgba(100,116,139,0.08))',
            color: 'var(--text-secondary, #64748b)',
          }}
        >
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Timeline */}
      <div className="relative">
        {grouped.map((evt, i) => (
          <TimelineEvent
            key={evt.timestamp + '-' + i}
            evt={evt}
            isLast={i === grouped.length - 1}
            stepDurations={stepDurations}
          />
        ))}
      </div>
    </div>
  );
}
