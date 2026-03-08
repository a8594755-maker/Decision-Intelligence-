import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, Minus,
  Calculator, ShieldAlert, Activity, Clock,
  ArrowRight, CheckCircle, AlertCircle, Loader2,
  FileText, BarChart3, RefreshCw, Database, Upload,
  ShieldCheck, AlertTriangle, Lock,
} from 'lucide-react';
import { Card, Badge } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { getRecentAuditTrail } from '../services/planAuditService';
import { useSystemHealth } from '../hooks/useSystemHealth';
import { useDecisionOverview } from '../hooks/useDecisionOverview';
import FirstRunGuide from '../components/onboarding/FirstRunGuide';

/* ───── Hero KPI (primary) ───── */
function HeroKpi({ label, value, sub, gradient }) {
  return (
    <div
      className="col-span-1 lg:col-span-2 p-6 rounded-2xl text-white relative overflow-hidden"
      style={{ background: gradient, boxShadow: '0 8px 24px rgba(79,70,229,0.25)' }}
    >
      <span className="text-white/70 text-sm font-medium">{label}</span>
      <div className="text-5xl font-bold mt-2 font-numeric tracking-tight">{value}</div>
      {sub && <div className="text-white/60 text-sm mt-1.5">{sub}</div>}
    </div>
  );
}

/* ───── Secondary KPI ───── */
function MetricStrip({ label, value, sub, accentColor = '#d97706' }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="w-1 self-stretch rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
      <div>
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
        <div className="text-2xl font-bold font-numeric mt-0.5" style={{ color: 'var(--text-primary)' }}>
          {value}
        </div>
        {sub && <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{sub}</div>}
      </div>
    </div>
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
  const { health, refresh: refreshHealth } = useSystemHealth();
  const { overview } = useDecisionOverview(user?.id);

  useEffect(() => {
    if (!user?.id) return;
    queueMicrotask(() => setLoadingActivity(true));
    getRecentAuditTrail(user.id, 8)
      .then(setRecentActivity)
      .finally(() => setLoadingActivity(false));
  }, [user?.id]);

  const { latest: latestKpi, previous: prevKpi, latestEvent } = useMemo(
    () => extractKpis(recentActivity),
    [recentActivity]
  );

  const fillRateVal = latestKpi?.service_level != null
    ? `${(latestKpi.service_level * 100).toFixed(1)}%`
    : '--';
  const fillRateSub = latestKpi?.service_level != null
    ? trendLabel(latestKpi.service_level, prevKpi?.service_level, v => `${(v * 100).toFixed(1)}pp`)
    : 'Run a plan to see metrics';

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <FirstRunGuide />
      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* ── Page header ── */}
        <div className="mb-2">
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

        {/* ── KPI Grid: 1 hero + 3 strips ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 items-start">
          <HeroKpi
            label="Fill Rate"
            value={fillRateVal}
            sub={fillRateSub}
            gradient="linear-gradient(135deg, #4f46e5, #7c3aed)"
          />
          <Card variant="elevated" className="col-span-1 space-y-1 !p-5">
            <MetricStrip
              label="Stockout Risk"
              value={latestKpi?.stockout_units != null
                ? `${Number(latestKpi.stockout_units).toLocaleString()} units`
                : '--'}
              sub={trendLabel(latestKpi?.stockout_units, prevKpi?.stockout_units, v => `${v.toLocaleString()} units`)}
              accentColor="var(--risk-critical)"
            />
          </Card>
          <Card variant="elevated" className="col-span-1 space-y-1 !p-5">
            <MetricStrip
              label="Total Cost"
              value={latestKpi?.total_cost != null
                ? `$${Number(latestKpi.total_cost).toLocaleString()}`
                : '--'}
              sub={trendLabel(latestKpi?.total_cost, prevKpi?.total_cost, v => `$${v.toLocaleString()}`)}
              accentColor="var(--brand-600)"
            />
            <MetricStrip
              label="Last Plan Run"
              value={latestEvent?.created_at ? formatRelativeTime(latestEvent.created_at) : '--'}
              sub={latestEvent?.created_at ? `Run #${latestEvent.run_id || '\u2014'}` : 'No recent runs'}
              accentColor="var(--risk-warning)"
            />
          </Card>
        </div>

        {/* ── Decision Overview ── */}
        {overview && (
          <Card variant="elevated" className="!p-5 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Today&apos;s Decision Overview
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* Coverage */}
              <div className="flex items-center gap-2">
                {overview.coverage_level === 'full' ? (
                  <ShieldCheck className="w-5 h-5 text-emerald-500" />
                ) : overview.coverage_level === 'partial' ? (
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                ) : (
                  <Lock className="w-5 h-5 text-red-500" />
                )}
                <div>
                  <p className="text-[10px] text-slate-500">Data Coverage</p>
                  <p className="text-sm font-semibold capitalize" style={{ color: 'var(--text-primary)' }}>
                    {overview.coverage_level || 'Unknown'}
                  </p>
                </div>
              </div>

              {/* Estimated vs Verified */}
              {overview.estimated_ratio && (
                <div className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-indigo-500" />
                  <div>
                    <p className="text-[10px] text-slate-500">Verified vs Estimated</p>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {overview.estimated_ratio.verified} / {overview.estimated_ratio.total}
                    </p>
                  </div>
                </div>
              )}

              {/* Missing Datasets */}
              {overview.missing_datasets.length > 0 && (
                <div className="flex items-center gap-2">
                  <Upload className="w-5 h-5 text-amber-500" />
                  <div>
                    <p className="text-[10px] text-slate-500">Missing Datasets</p>
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {overview.missing_datasets.join(', ')}
                    </p>
                  </div>
                </div>
              )}

              {/* Open Actions */}
              {overview.open_actions_count > 0 && (
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <div>
                    <p className="text-[10px] text-slate-500">Actions Pending</p>
                    <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                      {overview.open_actions_count}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Import quality line */}
            {overview.import_quality && (
              <div className="flex gap-3 text-[10px] text-slate-500 pt-1 border-t border-slate-200/50 dark:border-slate-700/50">
                {overview.import_quality.totalWarnings > 0 && <span>{overview.import_quality.totalWarnings} import warnings</span>}
                {overview.import_quality.totalQuarantined > 0 && <span className="text-amber-600">{overview.import_quality.totalQuarantined} quarantined</span>}
                {overview.import_quality.totalRejected > 0 && <span className="text-red-600">{overview.import_quality.totalRejected} rejected</span>}
              </div>
            )}
          </Card>
        )}

        {/* ── Two-column: Quick Actions + Recent Activity ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quick Actions */}
          <div className="lg:col-span-1 space-y-5">
            <h2 className="text-sm font-semibold tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
              Quick Actions
            </h2>
            <div className="space-y-2">
              <ActionCard
                onClick={() => navigate('/plan')}
                icon={Calculator}
                accent="#4f46e5"
                title="New Plan Run"
                desc="Upload data & run replenishment plan"
              />
              <ActionCard
                onClick={() => navigate('/risk')}
                icon={ShieldAlert}
                accent="#dc2626"
                title="Risk Analysis"
                desc="Supply coverage risk dashboard"
              />
              <ActionCard
                onClick={() => navigate('/forecast')}
                icon={TrendingUp}
                accent="#059669"
                title="View Forecasts"
                desc="BOM & component demand forecasts"
              />
            </div>

            {/* System Health */}
            <div className="pt-2">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                  System Health
                </h2>
                <button
                  onClick={refreshHealth}
                  className="p-1.5 rounded-lg transition-colors hover:bg-[var(--surface-subtle)]"
                  style={{ color: 'var(--text-muted)' }}
                  title="Refresh health checks"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
              <Card>
                <div className="space-y-3">
                  <HealthRow label="Supabase" status={health.supabase} />
                  <HealthRow label="AI Proxy" status={health.aiProxy} />
                  <HealthRow
                    label="ML API"
                    status={health.mlApi}
                    hint={health.mlApi === 'offline' ? 'Start with: python run_ml_api.py' : undefined}
                  />
                </div>
              </Card>
            </div>
          </div>

          {/* Recent Activity */}
          <div className="lg:col-span-2 space-y-5">
            <h2 className="text-sm font-semibold tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
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
      </div>
    </div>
  );
}

/* ───── Sub-components ───── */

// eslint-disable-next-line no-unused-vars -- Icon is used in JSX below; ESLint false positive on destructured rename
function ActionCard({ onClick, icon: Icon, accent, title, desc }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-4 rounded-xl border transition-all text-left group hover:shadow-[var(--shadow-card)]"
      style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
    >
      <div
        className="p-2 rounded-lg flex-shrink-0"
        style={{ backgroundColor: `${accent}12`, color: accent }}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{title}</div>
        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{desc}</div>
      </div>
      <ArrowRight
        className="w-4 h-4 transition-transform group-hover:translate-x-0.5"
        style={{ color: 'var(--text-muted)' }}
      />
    </button>
  );
}

function HealthRow({ label, status, hint }) {
  const dot = status === 'online'
    ? 'bg-emerald-500'
    : status === 'offline'
      ? 'bg-red-500'
      : status === 'checking'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-stone-400';
  const text = status === 'online' ? 'Online'
    : status === 'offline' ? 'Offline'
      : status === 'checking' ? 'Checking...'
        : 'Unknown';

  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{text}</span>
        {hint && <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-muted)' }}>({hint})</span>}
      </div>
    </div>
  );
}

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
