import React, { useMemo, useState } from 'react';
import { Download, TrendingUp } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { Card, Button, Badge } from '../ui';
import { loadArtifact } from '../../utils/artifactStore';

const formatMetric = (value, suffix = '') => (Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : 'N/A');
const EMPTY_GROUPS = [];

const downloadBlob = (content, fileName, contentType) => {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const isEmptyObject = (value) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === 0
);

const resolveArtifactContent = async ({ content, ref, mimeType }) => {
  let resolved = content;
  if ((resolved === undefined || resolved === null || resolved === '' || isEmptyObject(resolved)) && ref) {
    resolved = await loadArtifact(ref);
  }

  if (
    typeof mimeType === 'string'
    && mimeType.startsWith('text/csv')
    && resolved
    && typeof resolved === 'object'
    && typeof resolved.content === 'string'
  ) {
    resolved = resolved.content;
  }

  return resolved;
};

const downloadJson = async (payload, fileName, ref = null) => {
  const resolved = await resolveArtifactContent({
    content: payload,
    ref,
    mimeType: 'application/json;charset=utf-8'
  });
  downloadBlob(JSON.stringify(resolved ?? {}, null, 2), fileName, 'application/json;charset=utf-8');
};

const downloadCsv = async (content, fileName, ref = null) => {
  const resolved = await resolveArtifactContent({
    content,
    ref,
    mimeType: 'text/csv;charset=utf-8'
  });
  if (resolved === undefined || resolved === null || resolved === '') return;
  downloadBlob(String(resolved), fileName, 'text/csv;charset=utf-8');
};

const chartTick = (value) => String(value || '').slice(-10);

export default function ForecastCard({ payload, onRunPlan, isPlanRunning = false }) {
  const groups = Array.isArray(payload?.series_groups) ? payload.series_groups : EMPTY_GROUPS;
  const [groupKey, setGroupKey] = useState('');
  const selectedGroupKey = useMemo(() => {
    if (!groups.length) return '';
    if (groupKey && groups.some((group) => group.key === groupKey)) {
      return groupKey;
    }
    return groups[0].key;
  }, [groups, groupKey]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.key === selectedGroupKey) || groups[0] || null,
    [groups, selectedGroupKey]
  );

  const chartData = useMemo(() => {
    if (!selectedGroup?.points) return [];
    return selectedGroup.points.map((point) => ({
      time_bucket: point.time_bucket,
      actual: point.actual,
      forecast: point.forecast,
      lower: point.lower,
      upper: point.upper
    }));
  }, [selectedGroup]);

  if (!payload) return null;

  const metrics = payload.metrics || {};
  const timeRange = payload.time_range_guess || {};

  return (
    <Card className="w-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-600" />
              Forecast Results
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Run #{payload.run_id || 'N/A'} | {payload.workflow || 'workflow_unknown'}
            </p>
            <p className="text-xs text-slate-500">
              Source time range: {timeRange?.start || 'unknown'} to {timeRange?.end || 'unknown'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge type="success">{payload.status || 'succeeded'}</Badge>
            <Badge type="info">{metrics.selected_model_global || 'naive_last'}</Badge>
            <Button
              variant="secondary"
              className="text-xs px-3 py-1"
              disabled={isPlanRunning}
              onClick={() => onRunPlan?.(payload)}
            >
              {isPlanRunning ? 'Running Plan...' : 'Run Plan'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <Badge type="info">MAPE: {formatMetric(metrics.mape, '%')}</Badge>
          <Badge type="info">MAE: {formatMetric(metrics.mae)}</Badge>
          <Badge type="info">Groups: {metrics.groups_processed ?? payload.total_groups ?? 0}</Badge>
          <Badge type="info">Horizon: {metrics.horizon_periods ?? 0}</Badge>
        </div>

        {groups.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-600 dark:text-slate-300">Series</span>
            <select
              value={selectedGroupKey}
              onChange={(e) => setGroupKey(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
            >
              {groups.map((group) => (
                <option key={group.key} value={group.key}>
                  {group.material_code} | {group.plant_id}
                </option>
              ))}
            </select>
          </div>
        )}

        {selectedGroup && (
          <div className="text-xs text-slate-600 dark:text-slate-300">
            Showing: <strong>{selectedGroup.material_code}</strong> @ <strong>{selectedGroup.plant_id}</strong>
          </div>
        )}

        <div className="w-full h-64 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 p-2">
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time_bucket" tickFormatter={chartTick} fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="actual" name="Actual" stroke="#10b981" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="forecast" name="Forecast" stroke="#2563eb" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="lower" name="Lower" stroke="#2563eb" strokeDasharray="4 4" dot={false} />
              <Line type="monotone" dataKey="upper" name="Upper" stroke="#2563eb" strokeDasharray="4 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {payload.truncated_groups && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Artifact truncated: showing top {groups.length} series by demand volume.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => downloadJson(
              payload.forecast_series_json,
              `forecast_series_run_${payload.run_id || 'latest'}.json`,
              payload.forecast_series_ref
            )}
          >
            <Download className="w-3 h-3 mr-1" />
            forecast_series.json
          </Button>
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => downloadJson(
              payload.metrics_json,
              `forecast_metrics_run_${payload.run_id || 'latest'}.json`,
              payload.metrics_ref
            )}
          >
            <Download className="w-3 h-3 mr-1" />
            metrics.json
          </Button>
          {(payload.forecast_csv || payload.forecast_csv_ref) && (
            <Button
              variant="secondary"
              className="text-xs"
              onClick={() => downloadCsv(
                payload.forecast_csv,
                `forecast_run_${payload.run_id || 'latest'}.csv`,
                payload.forecast_csv_ref
              )}
            >
              <Download className="w-3 h-3 mr-1" />
              forecast.csv
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
