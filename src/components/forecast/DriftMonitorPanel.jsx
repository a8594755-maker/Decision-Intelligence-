/**
 * Task 4: MLOps Data Drift Detection Panel
 * 
 * Detects whether current data deviates from training baseline (μ±3σ) via /drift-check API.
 * Visualizes drift status with Gaussian distribution + Z-score metrics.
 */

import React, { useState } from 'react';
import { Activity, AlertTriangle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

const ML_API_BASE = 'http://localhost:8000';

const DRIFT_COLORS = {
  none: { bg: 'bg-green-50 dark:bg-green-900/20', border: 'border-green-200 dark:border-green-800', icon: CheckCircle, iconColor: 'text-green-500' },
  notice: { bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-200 dark:border-blue-800', icon: Activity, iconColor: 'text-blue-500' },
  warning: { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', icon: AlertTriangle, iconColor: 'text-amber-500' },
  critical: { bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-800', icon: XCircle, iconColor: 'text-red-500' },
};

const DriftMonitorPanel = ({ history }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const checkDrift = async () => {
    if (!history || history.length < 10) {
      setError('At least 10 historical data points are required for drift detection');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${ML_API_BASE}/drift-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history, window: 30 })
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const level = data?.drift_level || 'none';
  const style = DRIFT_COLORS[level] || DRIFT_COLORS.none;
  const Icon = style.icon;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-cyan-500" />
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            Data Drift Monitor
          </h3>
          <span className="text-xs bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 px-2 py-0.5 rounded-full">
            MLOps
          </span>
        </div>
        <button
          onClick={checkDrift}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-100 dark:hover:bg-cyan-900/50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Detecting...' : 'Run Drift Detection'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-5 py-3 bg-red-50 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* No data yet */}
      {!data && !error && (
        <div className="px-5 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
          Click "Run Drift Detection" to compare current data with training baseline
        </div>
      )}

      {/* Results */}
      {data && (
        <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
          {/* Status Banner */}
          <div className={`px-5 py-3 ${style.bg} ${style.border} border-l-4`}>
            <div className="flex items-center gap-2">
              <Icon className={`w-5 h-5 ${style.iconColor}`} />
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                {data.message}
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 ml-7">
              {data.recommendation}
            </p>
          </div>

          {/* Metrics Grid */}
          <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard
              label="Training Baseline μ"
              value={data.details.training_baseline.mean}
              unit=""
            />
            <MetricCard
              label="Current Mean"
              value={data.details.current_window.mean}
              unit=""
              highlight={data.drift_detected}
            />
            <MetricCard
              label="Z-Score"
              value={data.details.z_score}
              unit="σ"
              highlight={data.details.z_score > 3}
            />
            <MetricCard
              label="Volatility Ratio"
              value={data.details.std_ratio}
              unit="×"
              highlight={data.details.std_ratio > 2 || data.details.std_ratio < 0.3}
            />
          </div>

          {/* Visual Gauge */}
          <div className="px-5 py-4">
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              μ ± 3σ Range: [{data.details.training_baseline.lower_3sigma} ~ {data.details.training_baseline.upper_3sigma}]
            </div>
            <div className="relative h-3 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
              {/* Safe zone */}
              <div
                className="absolute inset-y-0 bg-green-200 dark:bg-green-800/50 rounded-full"
                style={{
                  left: '15%',
                  width: '70%',
                }}
              />
              {/* Current position marker */}
              <div
                className={`absolute top-0 bottom-0 w-1.5 rounded-full ${data.drift_detected ? 'bg-red-500' : 'bg-blue-500'}`}
                style={{
                  left: `${Math.min(95, Math.max(5, 50 + (data.details.z_score * (data.details.current_window.mean > data.details.training_baseline.mean ? 1 : -1)) * 8))}%`,
                }}
                title={`Z=${data.details.z_score}`}
              />
            </div>
            <div className="flex justify-between text-xs text-slate-400 mt-1">
              <span>-3σ</span>
              <span>μ</span>
              <span>+3σ</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const MetricCard = ({ label, value, unit, highlight }) => (
  <div className={`text-center p-2 rounded-lg ${highlight ? 'bg-red-50 dark:bg-red-900/20' : 'bg-slate-50 dark:bg-slate-900/30'}`}>
    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">{label}</div>
    <div className={`text-lg font-bold ${highlight ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
      {typeof value === 'number' ? value.toFixed(1) : value}{unit}
    </div>
  </div>
);

export default DriftMonitorPanel;
