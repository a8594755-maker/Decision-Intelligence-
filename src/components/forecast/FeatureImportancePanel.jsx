/**
 * Task 3: 模型可解釋性 — Feature Importance Panel
 * 
 * 從 /feature-importance API 取得 LightGBM 特徵貢獻度，
 * 以水平條形圖 + 自然語言解釋呈現在 Dashboard 上。
 */

import React, { useState, useEffect } from 'react';
import { Brain, RefreshCw, AlertTriangle, TrendingUp, ChevronDown, ChevronUp } from 'lucide-react';

const ML_API_BASE = 'http://localhost:8000';

const FeatureImportancePanel = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [driftData, setDriftData] = useState(null);

  const fetchImportance = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${ML_API_BASE}/feature-importance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
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

  useEffect(() => {
    fetchImportance();
  }, []);

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">載入模型解釋...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-sm">{error}</span>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const topFeatures = expanded ? data.features : data.features.slice(0, 5);
  const maxPct = data.features[0]?.importance_pct || 1;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-purple-500" />
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            AI 模型可解釋性
          </h3>
          <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-full">
            LightGBM
          </span>
        </div>
        <div className="flex items-center gap-2">
          {data.model_mape && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              MAPE: <span className="font-semibold text-green-600 dark:text-green-400">{data.model_mape}%</span>
            </span>
          )}
          <button
            onClick={fetchImportance}
            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            title="重新載入"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="px-5 py-3 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-900/10 dark:to-blue-900/10 border-b border-slate-100 dark:border-slate-700/50">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          <TrendingUp className="w-4 h-4 inline mr-1 text-purple-500" />
          {data.summary}
        </p>
        {data.optuna && !data.optuna.skipped && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Optuna 自動調參: {data.optuna.n_trials} 次試驗, 最佳 MAPE {data.optuna.best_mape}%
          </p>
        )}
      </div>

      {/* Bar Chart */}
      <div className="px-5 py-4 space-y-2.5">
        {topFeatures.map((feat, idx) => (
          <div key={feat.feature} className="group">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-slate-600 dark:text-slate-400">
                {feat.feature}
              </span>
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                {feat.importance_pct}%
              </span>
            </div>
            <div className="relative h-5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                style={{
                  width: `${(feat.importance_pct / maxPct) * 100}%`,
                  background: idx === 0
                    ? 'linear-gradient(90deg, #8b5cf6, #6366f1)'
                    : idx < 3
                      ? 'linear-gradient(90deg, #60a5fa, #818cf8)'
                      : 'linear-gradient(90deg, #94a3b8, #cbd5e1)',
                }}
              />
            </div>
            {/* Explanation tooltip on hover */}
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              {feat.explanation}
            </p>
          </div>
        ))}
      </div>

      {/* Expand / Collapse */}
      {data.features.length > 5 && (
        <div className="px-5 py-2 border-t border-slate-100 dark:border-slate-700/50">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? '收起' : `展開全部 ${data.total_features} 個特徵`}
          </button>
        </div>
      )}

      {/* Footer: Optuna params */}
      {data.params_used && (
        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-900/30 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-medium">超參數:</span>{' '}
          lr={data.params_used.learning_rate}, leaves={data.params_used.num_leaves}, ff={data.params_used.feature_fraction}
          {data.trained_at && (
            <span className="ml-2">· 訓練於 {new Date(data.trained_at).toLocaleString('zh-TW')}</span>
          )}
        </div>
      )}
    </div>
  );
};

export default FeatureImportancePanel;
