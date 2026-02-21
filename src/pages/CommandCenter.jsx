import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, TrendingDown, Minus,
  Calculator, ShieldAlert, Activity, Clock,
  ArrowRight, CheckCircle, AlertCircle, Loader2,
  FileText, Play, BarChart3,
} from 'lucide-react';
import { Card, Button, Badge } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { getRecentAuditTrail } from '../services/planAuditService';

/* ───── KPI Card ───── */
function KpiCard({ label, value, trend, trendLabel, icon: Icon, color }) {
  const trendIcon =
    trend === 'up' ? <TrendingUp className="w-3.5 h-3.5" /> :
    trend === 'down' ? <TrendingDown className="w-3.5 h-3.5" /> :
    <Minus className="w-3.5 h-3.5" />;

  const trendColor =
    trend === 'up' ? 'text-emerald-600' :
    trend === 'down' ? 'text-red-500' :
    'text-slate-400';

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
        <div className={`p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700/50 ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {trendLabel && (
        <div className={`flex items-center gap-1 text-xs font-medium ${trendColor}`}>
          {trendIcon}
          {trendLabel}
        </div>
      )}
    </Card>
  );
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

  useEffect(() => {
    if (!user?.id) return;
    setLoadingActivity(true);
    getRecentAuditTrail(user.id, 8)
      .then(setRecentActivity)
      .finally(() => setLoadingActivity(false));
  }, [user?.id]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <LayoutDashboard className="w-6 h-6 text-blue-600" />
            Command Center
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>

        {/* KPI Ribbon */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Fill Rate"
            value="--"
            trend="flat"
            trendLabel="Run a plan to see metrics"
            icon={CheckCircle}
            color="text-emerald-500"
          />
          <KpiCard
            label="Stockout Risk"
            value="--"
            trend="flat"
            trendLabel="Run risk analysis"
            icon={AlertCircle}
            color="text-red-500"
          />
          <KpiCard
            label="Total Cost"
            value="--"
            trend="flat"
            trendLabel="Pending plan run"
            icon={BarChart3}
            color="text-blue-500"
          />
          <KpiCard
            label="Planning Cycle"
            value="--"
            trend="flat"
            trendLabel="No recent runs"
            icon={Clock}
            color="text-amber-500"
          />
        </div>

        {/* Two-column: Quick Actions + Recent Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quick Actions */}
          <div className="lg:col-span-1 space-y-4">
            <h2 className="text-lg font-semibold">Quick Actions</h2>
            <div className="space-y-3">
              <button
                onClick={() => navigate('/plan')}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600">
                  <Calculator className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">New Plan Run</div>
                  <div className="text-xs text-slate-500 truncate">Upload data and run replenishment plan</div>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                onClick={() => navigate('/risk')}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50/50 dark:hover:bg-red-900/10 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-600">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">Risk Analysis</div>
                  <div className="text-xs text-slate-500 truncate">View supply coverage risk dashboard</div>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                onClick={() => navigate('/forecast')}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">View Forecasts</div>
                  <div className="text-xs text-slate-500 truncate">BOM explosion and component demand forecasts</div>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* System Health */}
            <div className="mt-6">
              <h2 className="text-lg font-semibold mb-3">System Health</h2>
              <Card>
                <div className="space-y-3">
                  <HealthRow label="Supabase" status="online" />
                  <HealthRow label="AI Proxy" status="online" />
                  <HealthRow label="ML API" status="unknown" hint="Start with: python run_ml_api.py" />
                </div>
              </Card>
            </div>
          </div>

          {/* Recent Activity */}
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-lg font-semibold">Recent Activity</h2>
            <Card>
              {loadingActivity ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                </div>
              ) : recentActivity.length === 0 ? (
                <div className="text-center py-8">
                  <Activity className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="text-sm text-slate-500">No recent activity.</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Run a plan or risk analysis to see activity here.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {recentActivity.map((event) => {
                    const EventIcon = ACTION_ICONS[event.action] || Activity;
                    return (
                      <div key={event.id || event.created_at} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700/50 mt-0.5">
                          <EventIcon className="w-4 h-4 text-slate-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">
                            {ACTION_LABELS[event.action] || event.action}
                            {event.run_id && (
                              <span className="text-slate-400 ml-1">#{event.run_id}</span>
                            )}
                          </div>
                          {event.narrative_summary && (
                            <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                              {event.narrative_summary}
                            </p>
                          )}
                          {event.kpi_snapshot && event.kpi_snapshot.fill_rate != null && (
                            <div className="flex gap-3 mt-1">
                              <Badge type="info">SL {(event.kpi_snapshot.fill_rate * 100).toFixed(1)}%</Badge>
                              {event.kpi_snapshot.total_cost != null && (
                                <Badge type="info">${Number(event.kpi_snapshot.total_cost).toLocaleString()}</Badge>
                              )}
                            </div>
                          )}
                        </div>
                        <span className="text-xs text-slate-400 whitespace-nowrap mt-0.5">
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

/* ───── Helpers ───── */
function HealthRow({ label, status, hint }) {
  const dot = status === 'online'
    ? 'bg-emerald-500'
    : status === 'offline'
      ? 'bg-red-500'
      : 'bg-slate-400';
  const text = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Unknown';

  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs text-slate-500">{text}</span>
        {hint && <span className="text-xs text-slate-400 hidden sm:inline">({hint})</span>}
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
