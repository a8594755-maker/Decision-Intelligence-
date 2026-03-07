/**
 * DataQualityCard
 *
 * Renders data_quality_report artifacts. Shows:
 * - Capability matrix (what's available / partial / unavailable)
 * - Fallback audit (which fields used defaults)
 * - Actionable hints (upload X to unlock Y)
 */

import React from 'react';
import { ShieldCheck, AlertTriangle, Lock, Upload, Info } from 'lucide-react';
import { Card, Badge } from '../ui';

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
  if (!payload) return null;

  const {
    coverage_level = 'minimal',
    available_datasets = [],
    missing_datasets = [],
    fallbacks_used = [],
    dataset_fallbacks = [],
    capabilities,
    row_stats,
  } = payload;

  const config = LEVEL_CONFIG[coverage_level] || LEVEL_CONFIG.minimal;
  const Icon = config.icon;

  return (
    <Card className={`w-full border ${config.border} ${config.bg}`}>
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <Icon className={`w-4 h-4 ${config.color}`} />
              Data Quality Report
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">
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
            <span key={ds} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <Lock className="w-3 h-3" />
              {DATASET_LABELS[ds] || ds}
            </span>
          ))}
        </div>

        {/* Capability matrix */}
        {capabilities && Object.keys(capabilities).length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-slate-700 dark:text-slate-200">Capabilities</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(capabilities).map(([key, level]) => {
                const capColors = {
                  full: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
                  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
                  unavailable: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
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
            <p className="text-[11px] font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-amber-500" />
              Estimated Fields
            </p>
            <div className="text-[10px] text-slate-600 dark:text-slate-400 space-y-0.5">
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
              <div key={i} className="flex items-start gap-2 px-2.5 py-1.5 rounded bg-slate-100/80 dark:bg-slate-800/50 text-[11px]">
                <Info className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-slate-600 dark:text-slate-300">{fb.message}</p>
                  {fb.degradesCapability && (
                    <p className="text-slate-400 mt-0.5 flex items-center gap-1">
                      <Upload className="w-3 h-3" />
                      Upload {DATASET_LABELS[fb.dataset] || fb.dataset} data to unlock {fb.degradesCapability.replace(/_/g, ' ')}.
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Row stats */}
        {row_stats && (
          <div className="flex gap-3 text-[10px] text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200/50 dark:border-slate-700/50">
            <span>Total rows: {row_stats.total}</span>
            <span>Clean: {row_stats.clean}</span>
            {row_stats.with_fallback > 0 && <span>With fallback: {row_stats.with_fallback}</span>}
            {row_stats.dropped > 0 && <span className="text-red-500">Dropped: {row_stats.dropped}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}
