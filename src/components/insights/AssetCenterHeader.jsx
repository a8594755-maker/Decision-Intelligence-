// AssetCenterHeader.jsx — Summary header for the Decision Asset Center
// Shows period summary, KPI pills, pinned hero cards, trends, blind spots, and suggested questions.

import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, AlertTriangle, HelpCircle, ArrowRight, Pin,
} from 'lucide-react';
import { Card } from '../ui/Card';
import SnapshotCard from './SnapshotCard';

function KpiPill({ label, value }) {
  return (
    <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-[var(--surface-subtle)] min-w-[100px]">
      <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wide">{label}</span>
      <span className="text-sm font-semibold text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function TrendBadge({ trend }) {
  const Icon = trend.direction === 'up' ? TrendingUp : TrendingDown;
  const color = trend.direction === 'up'
    ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20'
    : 'text-red-600 bg-red-50 dark:bg-red-900/20';

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs ${color}`}>
      <Icon className="w-3 h-3" />
      <span className="font-medium">{trend.title}</span>
      <span className="text-[var(--text-tertiary)]">{trend.description}</span>
    </div>
  );
}

export default function AssetCenterHeader({
  summary,
  pinnedSnapshots,
  onTogglePin,
  onArchive,
  onRefresh,
}) {
  const navigate = useNavigate();

  if (!summary) return null;

  const {
    period_summary, trends, blind_spots, suggested_questions,
    latest_kpis, top_findings,
  } = summary;

  const hasPinned = pinnedSnapshots?.length > 0;
  const hasKpis = latest_kpis?.length > 0;
  const hasTrends = trends?.length > 0;
  const hasBlindSpots = blind_spots?.length > 0;
  const hasSuggestions = suggested_questions?.length > 0;
  const hasFindings = top_findings?.length > 0;

  const handleExplore = (question) => {
    navigate('/workspace', { state: { insightQuery: question } });
  };

  return (
    <div className="space-y-4">
      {/* Period summary */}
      {period_summary && (
        <Card variant="elevated" compact>
          <p className="text-sm text-[var(--text-primary)]">{period_summary}</p>
        </Card>
      )}

      {/* KPI pills */}
      {hasKpis && (
        <div className="flex flex-wrap gap-2 overflow-x-auto pb-1">
          {latest_kpis.slice(0, 8).map((kpi, i) => (
            <KpiPill key={i} label={kpi.label} value={kpi.value} />
          ))}
        </div>
      )}

      {/* Pinned hero cards */}
      {hasPinned && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Pin className="w-3.5 h-3.5 text-[var(--brand-600)]" />
            <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">Pinned</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {pinnedSnapshots.slice(0, 3).map((s) => (
              <SnapshotCard
                key={s.id}
                snapshot={s}
                compact
                onTogglePin={onTogglePin}
                onArchive={onArchive}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        </div>
      )}

      {/* Trends */}
      {hasTrends && (
        <div className="flex flex-wrap gap-2">
          {trends.map((t, i) => <TrendBadge key={i} trend={t} />)}
        </div>
      )}

      {/* Findings + Blind spots + Suggestions — compact 3-column grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Top findings */}
        {hasFindings && (
          <Card compact>
            <h4 className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2">
              Key Findings
            </h4>
            <ul className="space-y-1">
              {top_findings.slice(0, 4).map((f, i) => (
                <li key={i} className="text-xs text-[var(--text-primary)] flex items-start gap-1.5">
                  <span className="text-[var(--brand-500)] mt-0.5 shrink-0">•</span>
                  <span className="line-clamp-2">{typeof f === 'string' ? f : f.text || f.finding}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Blind spots */}
        {hasBlindSpots && (
          <Card compact>
            <h4 className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Blind Spots
            </h4>
            <ul className="space-y-1">
              {blind_spots.slice(0, 3).map((bs, i) => (
                <li key={i} className="text-xs text-[var(--text-secondary)]">{bs}</li>
              ))}
            </ul>
          </Card>
        )}

        {/* Suggested questions */}
        {hasSuggestions && (
          <Card compact>
            <h4 className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2 flex items-center gap-1">
              <HelpCircle className="w-3 h-3" />
              Explore Next
            </h4>
            <ul className="space-y-1.5">
              {suggested_questions.slice(0, 3).map((q, i) => (
                <li key={i}>
                  <button
                    onClick={() => handleExplore(q)}
                    className="text-xs text-[var(--brand-600)] hover:text-[var(--brand-700)] hover:underline flex items-center gap-1 text-left"
                  >
                    <ArrowRight className="w-3 h-3 shrink-0" />
                    <span>{q}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
