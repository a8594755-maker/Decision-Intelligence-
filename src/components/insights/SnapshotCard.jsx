// SnapshotCard.jsx — Single analysis snapshot card for the Decision Asset Center
// Displays headline, metrics, findings, chart thumbnail, tags, and action buttons.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Pin, PinOff, Archive, ExternalLink, RefreshCw, Clock,
} from 'lucide-react';
import { Card } from '../ui/Card';
import ChartRenderer from '../chat/ChartRenderer';

/** Safely extract display text from a value that may be a JSON string or object. */
function safeText(val) {
  if (!val) return '';
  if (typeof val === 'object') return val.body || val.summary || val.text || val.headline || '';
  if (typeof val === 'string' && val.startsWith('{')) {
    try {
      const p = JSON.parse(val);
      return p.body || p.summary || p.executive_summary || p.text || p.headline || val;
    } catch { return val; }
  }
  return val;
}

const TAG_COLORS = {
  revenue: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  cost: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  customer: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  churn: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  inventory: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  forecast: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  trend: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  comparison: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  anomaly: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  supplier: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
};

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export default function SnapshotCard({
  snapshot,
  compact = false,
  onTogglePin,
  onArchive,
  onRefresh,
  refreshing = false,
  versionCount,
  onCompare,
}) {
  const navigate = useNavigate();
  const [hovering, setHovering] = useState(false);

  const {
    id, headline, summary, metric_pills, chart_specs, key_findings,
    tags, created_at, pinned, query_text, conversation_id, message_index,
    tool_calls_summary,
  } = snapshot;

  const pills = (metric_pills || []).slice(0, 4);
  const findings = (key_findings || []).slice(0, 2);
  const firstChart = (chart_specs || [])[0];

  const handleViewOriginal = () => {
    if (conversation_id) {
      navigate(`/workspace?conversation=${conversation_id}&msg=${message_index ?? 0}`);
    }
  };

  return (
    <Card
      variant={pinned ? 'elevated' : 'default'}
      compact={compact}
      hoverEffect
      className={`transition-all duration-200 ${pinned ? 'ring-1 ring-[var(--brand-500)]/30' : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
            {safeText(headline) || 'Untitled Analysis'}
          </h3>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-[var(--text-tertiary)] flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatRelativeTime(created_at)}
            </span>
            {tool_calls_summary && (
              <span className="text-xs text-[var(--text-tertiary)]">
                {tool_calls_summary}
              </span>
            )}
            {versionCount > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); onCompare?.(snapshot); }}
                className="text-xs text-[var(--brand-600)] hover:underline"
              >
                v{versionCount}
              </button>
            )}
          </div>
        </div>

        {/* Actions — visible on hover */}
        <div className={`flex items-center gap-1 transition-opacity ${hovering ? 'opacity-100' : 'opacity-0'}`}>
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin?.(id, !pinned); }}
            className="p-1 rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
            title={pinned ? 'Unpin' : 'Pin'}
          >
            {pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onArchive?.(id); }}
            className="p-1 rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
            title="Archive"
          >
            <Archive className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleViewOriginal(); }}
            className="p-1 rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
            title="View original conversation"
            disabled={!conversation_id}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          {query_text && (
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh?.(snapshot); }}
              className="p-1 rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
              title="Refresh with latest data"
              disabled={refreshing}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* Summary */}
      {summary && !compact && (
        <p className="text-xs text-[var(--text-secondary)] line-clamp-2 mb-2">
          {safeText(summary)}
        </p>
      )}

      {/* Metric pills */}
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {pills.map((pill, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--surface-subtle)] text-xs"
            >
              <span className="text-[var(--text-tertiary)]">{pill.label}</span>
              <span className="font-medium text-[var(--text-primary)]">{pill.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Chart thumbnail */}
      {firstChart && !compact && (
        <div className="h-28 mb-2 rounded-lg overflow-hidden bg-[var(--surface-subtle)]">
          <ChartRenderer chart={firstChart} mini height={112} />
        </div>
      )}

      {/* Key findings */}
      {findings.length > 0 && !compact && (
        <ul className="space-y-0.5 mb-2">
          {findings.map((f, i) => (
            <li key={i} className="text-xs text-[var(--text-secondary)] flex items-start gap-1.5">
              <span className="text-[var(--brand-500)] mt-0.5">•</span>
              <span className="line-clamp-1">{typeof f === 'string' ? f : f?.text || f?.finding || String(f)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Tags */}
      {tags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${TAG_COLORS[tag] || 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Query text (provenance) */}
      {query_text && !compact && (
        <div className="mt-2 pt-2 border-t border-[var(--border-default)]">
          <p className="text-[10px] text-[var(--text-tertiary)] truncate" title={query_text}>
            Query: {query_text}
          </p>
        </div>
      )}
    </Card>
  );
}
