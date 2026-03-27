/**
 * DataQualityCard
 *
 * Renders data_quality_report artifacts. Shows:
 * - Capability matrix (what's available / partial / unavailable)
 * - Fallback audit (which fields used defaults)
 * - Actionable hints (upload X to unlock Y)
 */

import React, { useMemo } from 'react';
import { ShieldCheck, AlertTriangle, Lock, Upload, Info, Sparkles } from 'lucide-react';
import { Card, Badge } from '../ui';
import { rankCapabilityUnlocks } from '../../utils/capabilityUnlockRanker';

const LEVEL_CONFIG = {
  full: {
    icon: ShieldCheck,
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    border: 'border-emerald-200 dark:border-emerald-800',
    label: 'Full Coverage',
    badgeType: 'success',
  },
  partial: {
    icon: AlertTriangle,
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    border: 'border-amber-200 dark:border-amber-800',
    label: 'Partial Coverage',
    badgeType: 'warning',
  },
  minimal: {
    icon: AlertTriangle,
    color: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-50 dark:bg-red-900/20',
    border: 'border-red-200 dark:border-red-800',
    label: 'Minimal Coverage',
    badgeType: 'danger',
  },
};

const DATASET_LABELS = {
  demand_fg: 'Demand Forecast',
  inventory_snapshots: 'Inventory Snapshots',
  po_open_lines: 'Open PO Lines',
  fg_financials: 'FG Financials',
  bom_edge: 'BOM Edges',
  goods_receipt: 'Goods Receipt',
  supplier_master: 'Supplier Master',
  price_history: 'Price History',
};

export default function DataQualityCard({ payload }) {
  const payloadCapabilities = payload?.capabilities;
  const unlockRanking = useMemo(() => {
    if (!payloadCapabilities) return [];
    return rankCapabilityUnlocks(payloadCapabilities);
  }, [payloadCapabilities]);

  if (!payload) return null;

  const {
    coverage_level = 'minimal',
    available_datasets = [],
    missing_datasets = [],
    fallbacks_used = [],
    dataset_fallbacks = [],
    capabilities = payloadCapabilities,
    row_stats,
    import_quality,
  } = payload;

  const config = LEVEL_CONFIG[coverage_level] || LEVEL_CONFIG.minimal;
  const Icon = config.icon;

  return (
    <Card category="data" className={`w-full border ${config.border} ${config.bg}`}>
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <Icon className={`w-4 h-4 ${config.color}`} />
              Data Quality Report
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              {available_datasets.length} dataset{available_datasets.length !== 1 ? 's' : ''} available
              {missing_datasets.length > 0 && `, ${missing_datasets.length} missing`}
            </p>
          </div>
          <Badge type={config.badgeType}>{config.label}</Badge>
        </div>

        {/* Dataset availability */}
        <div className="flex flex-wrap gap-1.5">
          {available_datasets.map(ds => (
            <span key={ds} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
              <ShieldCheck className="w-3 h-3" />
              {DATASET_LABELS[ds] || ds}
            </span>
          ))}
          {missing_datasets.map(ds => (
            <span key={ds} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-muted)]">
              <Lock className="w-3 h-3" />
              {DATASET_LABELS[ds] || ds}
            </span>
          ))}
        </div>

        {/* Capability matrix */}
        {capabilities && Object.keys(capabilities).length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-[var(--text-secondary)]">Capabilities</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(capabilities).map(([key, cap]) => {
                // Support both old shape (string) and new shape ({ available, level })
                const level = typeof cap === 'string' ? cap : (cap?.level || 'unavailable');
                const capColors = {
                  full: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
                  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
                  unavailable: 'bg-[var(--surface-subtle)] text-[var(--text-muted)]',
                };
                return (
                  <span key={key} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${capColors[level] || capColors.unavailable}`}>
                    {key.replace(/_/g, ' ')}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Fallback audit */}
        {fallbacks_used.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-amber-500" />
              Estimated Fields
            </p>
            <div className="text-[10px] text-[var(--text-secondary)] space-y-0.5">
              {fallbacks_used.map((fb, i) => (
                <p key={i}>
                  <strong>{fb.field}</strong>: {fb.description} (value: {String(fb.value)}, {fb.count || 1} row{(fb.count || 1) !== 1 ? 's' : ''})
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Dataset degradation messages */}
        {dataset_fallbacks.length > 0 && (
          <div className="space-y-1.5">
            {dataset_fallbacks.map((fb, i) => (
              <div key={i} className="flex items-start gap-2 px-2.5 py-1.5 rounded bg-[var(--surface-subtle)] text-[11px]">
                <Info className="w-3.5 h-3.5 text-[var(--text-muted)] mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-[var(--text-secondary)]">{fb.message}</p>
                  {fb.degradesCapability && (
                    <p className="text-[var(--text-muted)] mt-0.5 flex items-center gap-1">
                      <Upload className="w-3 h-3" />
                      Upload {DATASET_LABELS[fb.dataset] || fb.dataset} data to unlock {fb.degradesCapability.replace(/_/g, ' ')}.
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Import quality (per-dataset stats from import pipeline) */}
        {import_quality && typeof import_quality === 'object' && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-[var(--text-secondary)]">Import Quality</p>
            <div className="flex flex-wrap gap-2 text-[10px] text-[var(--text-secondary)]">
              {import_quality.totalWarnings > 0 && (
                <span>{import_quality.totalWarnings} warnings</span>
              )}
              {import_quality.totalQuarantined > 0 && (
                <span className="text-amber-600 dark:text-amber-400">{import_quality.totalQuarantined} quarantined</span>
              )}
              {import_quality.totalRejected > 0 && (
                <span className="text-red-600 dark:text-red-400">{import_quality.totalRejected} rejected</span>
              )}
            </div>
          </div>
        )}

        {/* Ranked capability unlock recommendations */}
        {unlockRanking.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-[var(--brand-500)]" />
              Recommended Uploads
            </p>
            {unlockRanking.slice(0, 3).map((rec, i) => (
              <div key={rec.dataset} className="flex items-start gap-2 px-2.5 py-1.5 rounded bg-[var(--accent-active)] text-[11px]">
                <span className="font-bold text-[var(--brand-600)] mt-0.5 flex-shrink-0">
                  #{i + 1}
                </span>
                <div>
                  <p className="font-medium text-[var(--text-secondary)]">{rec.label}</p>
                  <p className="text-[var(--text-muted)]">{rec.hint}</p>
                  {rec.unlocks.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {rec.unlocks.map(u => (
                        <span key={u} className="text-[9px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                          Unlocks: {u}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Row stats */}
        {row_stats && (
          <div className="flex gap-3 text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-default)]">
            <span>Total rows: {row_stats.total}</span>
            <span>Clean: {row_stats.clean}</span>
            {row_stats.with_fallback > 0 && <span>With fallback: {row_stats.with_fallback}</span>}
            {(row_stats.quarantined > 0 || row_stats.dropped > 0) && (
              <span className="text-red-500">Excluded: {(row_stats.quarantined || 0) + (row_stats.dropped || 0)}</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
