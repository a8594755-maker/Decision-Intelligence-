import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, TrendingDown,
  Calculator, ShieldAlert, Activity, Clock,
  CheckCircle, AlertCircle,
  FileText, BarChart3, RefreshCw, Database, Upload,
  ShieldCheck, AlertTriangle, Lock, X,
} from 'lucide-react';
import { Card, Badge } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { getRecentAuditTrail } from '../services/planAuditService';
import { useSystemHealth } from '../hooks/useSystemHealth';
import { useDecisionOverview } from '../hooks/useDecisionOverview';
import { getApprovalDeadlineStatus } from '../services/approvalWorkflowService';
import { supabase } from '../services/supabaseClient';
import FirstRunGuide from '../components/onboarding/FirstRunGuide';

/* ───── Uniform KPI Card ───── */
function KpiCard({ label, value, trend, icon: Icon, iconColor = 'var(--brand-600)' }) {
  return (
    <Card variant="elevated" className="!p-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        {Icon && <Icon className="w-4 h-4" style={{ color: iconColor }} />}
      </div>
      <div
        className="text-2xl font-bold font-numeric tracking-tight"
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </div>
      {trend && (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {trend}
        </span>
      )}
    </Card>
  );
}

/* ───── KPI extraction helpers ───── */
function extractKpis(events) {
  const planEvents = events.filter(
    e => e.action === 'plan_generated' && e.kpi_snapshot
  );
  return {
    latest: planEvents[0]?.kpi_snapshot || null,
    previous: planEvents[1]?.kpi_snapshot || null,
    latestEvent: planEvents[0] || null,
  };
}

function trendLabel(current, previous, fmt = v => v) {
  if (current == null) return null;
  if (previous == null) return 'First run';
  const diff = current - previous;
  const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2013';
  return `${arrow} ${fmt(Math.abs(diff))} vs previous`;
}

function getPendingApprovalTiming(approval) {
  const deadlineStatus = getApprovalDeadlineStatus({
    deadline: approval?.expires_at,
    status: 'PENDING',
  });

  if (deadlineStatus.is_expired) {
    return { ...deadlineStatus, label: 'Expired' };
  }

  if (deadlineStatus.minutes_remaining == null) {
    return { ...deadlineStatus, label: '' };
  }

  const hours = Math.floor(deadlineStatus.minutes_remaining / 60);
  const minutes = deadlineStatus.minutes_remaining % 60;
  return {
    ...deadlineStatus,
    label: `${hours}h ${minutes}m left`,
  };
}

/* ───── Action map for audit events ───── */
const ACTION_LABELS = {
  plan_generated: 'Plan generated',
  plan_approved: 'Plan approved',
  plan_rejected: 'Plan rejected',
  scenario_run: 'Scenario run',
  risk_triggered: 'Risk trigger',
};

const ACTION_ICONS = {
  plan_generated: FileText,
  plan_approved: CheckCircle,
  plan_rejected: AlertCircle,
  scenario_run: BarChart3,
  risk_triggered: ShieldAlert,
};

/* ───── Main Component ───── */
export default function CommandCenter() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [recentActivity, setRecentActivity] = useState([]);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [overviewDismissed, setOverviewDismissed] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const { health, refresh: refreshHealth } = useSystemHealth();
  const { overview } = useDecisionOverview(user?.id);

  useEffect(() => {
    if (!user?.id) return;
    queueMicrotask(() => setLoadingActivity(true));
    getRecentAuditTrail(user.id, 8)
      .then(setRecentActivity)
      .finally(() => setLoadingActivity(false));

    // Fetch pending approvals from di_approval_requests (best-effort)
    supabase
      .from('di_approval_requests')
      .select('id, type, title, description, urgency, status, expires_at, created_at, payload')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data }) => setPendingApprovals(data || []))
      .catch(() => {});
  }, [user?.id]);

  const { latest: latestKpi, previous: prevKpi, latestEvent } = useMemo(
    () => extractKpis(recentActivity),
    [recentActivity]
  );

  const hasOfflineService = Object.values(health).some(s => s === 'offline');

  const fillRateVal = latestKpi?.service_level != null
    ? `${(latestKpi.service_level * 100).toFixed(1)}%`
    : '--';
  const fillRateSub = latestKpi?.service_level != null
    ? trendLabel(latestKpi.service_level, prevKpi?.service_level, v => `${(v * 100).toFixed(1)}pp`)
    : 'Run a plan to see metrics';

  return (
    <div className="h-full overflow-y-auto scrollbar-thin relative">
      <FirstRunGuide />
      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-6">

        {/* ── Header with inline quick actions ── */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-2">
          <div>
            <p className="text-xs font-semibold tracking-widest uppercase text-indigo-500 mb-1">
              OVERVIEW
            </p>
            <h1
              className="text-3xl font-bold tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              Command Center
            </h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/plan')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors hover:shadow-sm"
              style={{
                borderColor: 'var(--border-default)',
                backgroundColor: 'var(--surface-card)',
                color: 'var(--text-primary)',
              }}
            >
              <Calculator className="w-3.5 h-3.5 text-indigo-600" />
              Plan
            </button>
            <button
              onClick={() => navigate('/risk')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors hover:shadow-sm"
              style={{
                borderColor: 'var(--border-default)',
                backgroundColor: 'var(--surface-card)',
                color: 'var(--text-primary)',
              }}
            >
              <ShieldAlert className="w-3.5 h-3.5 text-red-600" />
              Risk
            </button>
            <button
              onClick={() => navigate('/forecast')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors hover:shadow-sm"
              style={{
                borderColor: 'var(--border-default)',
                backgroundColor: 'var(--surface-card)',
                color: 'var(--text-primary)',
              }}
            >
              <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
              Forecast
            </button>
          </div>
        </div>

        {/* ── Uniform KPI row ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Fill Rate"
            value={fillRateVal}
            trend={fillRateSub}
            icon={Activity}
            iconColor="var(--brand-600)"
          />
          <KpiCard
            label="Stockout Risk"
            value={
              latestKpi?.stockout_units != null
                ? `${Number(latestKpi.stockout_units).toLocaleString()} units`
                : '--'
            }
            trend={trendLabel(
              latestKpi?.stockout_units,
              prevKpi?.stockout_units,
              v => `${v.toLocaleString()} units`
            )}
            icon={ShieldAlert}
            iconColor="var(--risk-critical)"
          />
          <KpiCard
            label="Total Cost"
            value={
              latestKpi?.total_cost != null
                ? `$${Number(latestKpi.total_cost).toLocaleString()}`
                : '--'
            }
            trend={trendLabel(
              latestKpi?.total_cost,
              prevKpi?.total_cost,
              v => `$${v.toLocaleString()}`
            )}
            icon={Calculator}
            iconColor="var(--brand-600)"
          />
          <KpiCard
            label="Last Plan Run"
            value={latestEvent?.created_at ? formatRelativeTime(latestEvent.created_at) : '--'}
            trend={latestEvent?.created_at ? `Run #${latestEvent.run_id || '\u2014'}` : 'No recent runs'}
            icon={Clock}
            iconColor="var(--risk-warning)"
          />
        </div>

        {/* ── Decision Overview alert banner ── */}
        {overview && !overviewDismissed && (
          <div
            className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 rounded-xl text-sm"
            style={{
              borderLeft: `4px solid ${overview.coverage_level === 'full' ? 'var(--risk-safe)' : 'var(--risk-warning)'}`,
              backgroundColor: 'var(--surface-subtle)',
              border: '1px solid var(--border-default)',
              borderLeftWidth: '4px',
              borderLeftColor: overview.coverage_level === 'full' ? 'var(--risk-safe)' : 'var(--risk-warning)',
            }}
          >
            {/* Coverage */}
            <div className="flex items-center gap-1.5">
              {overview.coverage_level === 'full' ? (
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
              ) : overview.coverage_level === 'partial' ? (
                <AlertTriangle className="w-4 h-4 text-amber-500" />
              ) : (
                <Lock className="w-4 h-4 text-red-500" />
              )}
              <span style={{ color: 'var(--text-primary)' }}>
                Coverage: <strong className="capitalize">{overview.coverage_level || 'Unknown'}</strong>
              </span>
            </div>

            {/* Verified ratio */}
            {overview.estimated_ratio && (
              <div className="flex items-center gap-1.5">
                <Database className="w-4 h-4 text-indigo-500" />
                <span style={{ color: 'var(--text-secondary)' }}>
                  {overview.estimated_ratio.verified}/{overview.estimated_ratio.total} verified
                </span>
              </div>
            )}

            {/* Missing datasets */}
            {overview.missing_datasets.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Upload className="w-4 h-4 text-amber-500" />
                <span style={{ color: 'var(--text-secondary)' }}>
                  Missing: {overview.missing_datasets.join(', ')}
                </span>
              </div>
            )}

            {/* Open actions */}
            {overview.open_actions_count > 0 && (
              <div className="flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-red-500" />
                <span className="text-red-600 dark:text-red-400">
                  {overview.open_actions_count} actions pending
                </span>
              </div>
            )}

            {/* Import quality */}
            {overview.import_quality && (
              <div className="flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                {overview.import_quality.totalWarnings > 0 && (
                  <span>{overview.import_quality.totalWarnings} warnings</span>
                )}
                {overview.import_quality.totalQuarantined > 0 && (
                  <span className="text-amber-600">{overview.import_quality.totalQuarantined} quarantined</span>
                )}
                {overview.import_quality.totalRejected > 0 && (
                  <span className="text-red-600">{overview.import_quality.totalRejected} rejected</span>
                )}
              </div>
            )}

            {/* Dismiss */}
            <button
              onClick={() => setOverviewDismissed(true)}
              className="ml-auto p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              style={{ color: 'var(--text-muted)' }}
              aria-label="Dismiss overview"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Pending Approvals ── */}
        {pendingApprovals.length > 0 && (
          <div className="space-y-3">
            <h2
              className="text-sm font-semibold tracking-wide uppercase"
              style={{ color: 'var(--text-muted)' }}
            >
              Pending Approvals ({pendingApprovals.length})
            </h2>
            <div className="grid gap-2">
              {pendingApprovals.map((approval) => {
                const deadlineStatus = getPendingApprovalTiming(approval);
                const isExpired = deadlineStatus.is_expired;
                const isCritical = deadlineStatus.is_critical;
                const isUrgent = deadlineStatus.is_urgent;

                return (
                  <Card key={approval.id} variant="elevated" className="!p-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                        isExpired ? 'bg-slate-400'
                          : isCritical ? 'bg-red-500 animate-pulse'
                            : isUrgent ? 'bg-amber-500'
                              : approval.urgency === 'critical' ? 'bg-red-500'
                                : approval.urgency === 'high' ? 'bg-amber-500'
                                  : 'bg-blue-500'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {approval.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] uppercase font-medium text-slate-500">
                            {approval.type?.replace(/_/g, ' ')}
                          </span>
                          {approval.expires_at && (
                            <span className={`text-[10px] font-medium ${
                              isExpired ? 'text-slate-400' : isCritical ? 'text-red-600' : isUrgent ? 'text-amber-600' : 'text-slate-500'
                            }`}>
                              {deadlineStatus.label}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => navigate('/chat')}
                        className="text-xs px-2.5 py-1 rounded-md font-medium transition-colors"
                        style={{
                          backgroundColor: 'var(--brand-600)',
                          color: 'white',
                        }}
                      >
                        Review
                      </button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Recent Activity (full width) ── */}
        <div className="space-y-3">
          <h2
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ color: 'var(--text-muted)' }}
          >
            Recent Activity
          </h2>
          <Card>
            {loadingActivity ? (
              <div className="flex items-center justify-center py-10">
                <div className="w-5 h-5 rounded-md bg-indigo-600 animate-pulse" />
              </div>
            ) : recentActivity.length === 0 ? (
              <div className="text-center py-10">
                <Activity className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No recent activity.</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Run a plan or risk analysis to see activity here.
                </p>
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--border-default)' }}>
                {recentActivity.map((event) => {
                  const EventIcon = ACTION_ICONS[event.action] || Activity;
                  return (
                    <div key={event.id || event.created_at} className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                      <div
                        className="p-1.5 rounded-lg mt-0.5"
                        style={{ backgroundColor: 'var(--surface-subtle)' }}
                      >
                        <EventIcon className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {ACTION_LABELS[event.action] || event.action}
                          {event.run_id && (
                            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>#{event.run_id}</span>
                          )}
                        </div>
                        {event.narrative_summary && (
                          <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                            {event.narrative_summary}
                          </p>
                        )}
                        {event.kpi_snapshot && event.kpi_snapshot.service_level != null && (
                          <div className="flex gap-2 mt-1.5">
                            <Badge type="info">SL {(event.kpi_snapshot.service_level * 100).toFixed(1)}%</Badge>
                            {event.kpi_snapshot.total_cost != null && (
                              <Badge type="info">${Number(event.kpi_snapshot.total_cost).toLocaleString()}</Badge>
                            )}
                          </div>
                        )}
                      </div>
                      <span className="text-xs whitespace-nowrap mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {formatRelativeTime(event.created_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ── System Health footer (only when offline) ── */}
      {hasOfflineService && (
        <div
          className="sticky bottom-0 z-30 flex items-center justify-between gap-3 px-4 py-2.5 text-sm border-t"
          style={{
            backgroundColor: 'var(--surface-card)',
            borderColor: 'var(--border-default)',
          }}
        >
          <div className="flex items-center gap-4">
            {['supabase', 'aiProxy', 'mlApi'].map(key => {
              const status = health[key];
              if (status === 'online') return null;
              const label = key === 'mlApi' ? 'ML API' : key === 'aiProxy' ? 'AI Proxy' : 'Supabase';
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${
                    status === 'offline' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'
                  }`} />
                  <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {status === 'offline' ? 'Offline' : 'Checking...'}
                  </span>
                </div>
              );
            })}
          </div>
          <button
            onClick={refreshHealth}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors"
            style={{
              backgroundColor: 'var(--surface-subtle)',
              color: 'var(--text-secondary)',
            }}
            title="Refresh health checks"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

/* ───── Utilities ───── */

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
