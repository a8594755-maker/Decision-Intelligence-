import React, { useState } from 'react';
import Markdown from 'react-markdown';
import { BarChart3, ChevronDown, ChevronRight, Info, Lightbulb, TriangleAlert, TrendingUp, TrendingDown, CheckSquare } from 'lucide-react';
import { Card } from '../ui';
import ChartRenderer from './ChartRenderer.jsx';
import { EnhanceableChart } from './AnalysisResultCard.jsx';

// ── Section color themes ────────────────────────────────────────────────────

const SECTION_THEMES = {
  findings:     { border: 'border-l-emerald-500', icon: Lightbulb,      iconColor: 'text-emerald-500' },
  implications: { border: 'border-l-blue-500',    icon: Info,           iconColor: 'text-blue-500' },
  caveats:      { border: 'border-l-amber-500',   icon: TriangleAlert,  iconColor: 'text-amber-500' },
  next_steps:   { border: 'border-l-violet-500',  icon: CheckSquare,    iconColor: 'text-violet-500' },
};

function Section({ sectionKey, title, items, children }) {
  const hasItems = Array.isArray(items) && items.length > 0;
  if (!hasItems && !children) return null;

  const theme = SECTION_THEMES[sectionKey] || SECTION_THEMES.findings;
  const Icon = theme.icon;

  return (
    <div className={`border-l-[3px] ${theme.border} pl-4 space-y-2`}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
        <Icon size={14} className={theme.iconColor} />
        <span>{title}</span>
      </div>
      {hasItems ? (
        <ul className="space-y-1.5">
          {items.map((item, idx) => (
            <li key={`${sectionKey}-${idx}`} className="flex items-start gap-2 text-sm leading-6 text-slate-700 dark:text-slate-200">
              <ChevronRight size={14} className="mt-1 shrink-0 text-slate-400 dark:text-slate-500" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  );
}

function EvidenceTable({ table }) {
  if (!table || !Array.isArray(table.columns) || table.columns.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/40 max-w-full">
      {table.title ? (
        <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400 truncate">
          {table.title}
        </div>
      ) : null}
      <div className="overflow-x-auto max-w-full">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/70">
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-300"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(table.rows || []).map((row, rowIdx) => (
              <tr key={`${table.title || 'table'}-${rowIdx}`} className="border-t border-slate-100 dark:border-slate-800">
                {row.map((value, cellIdx) => (
                  <td key={`${rowIdx}-${cellIdx}`} className="px-4 py-2.5 text-slate-700 dark:text-slate-200">
                    {String(value ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Trend indicator for metric pills ────────────────────────────────────────

function TrendIndicator({ value }) {
  if (value == null) return null;
  const str = String(value);
  const isPositive = /[+↑]/.test(str) || (/^\d/.test(str) && /%$/.test(str));
  const isNegative = /[-↓]/.test(str) && !/^[-]?\d+[.,]?\d*$/.test(str);
  if (!isPositive && !isNegative) return null;
  const Icon = isNegative ? TrendingDown : TrendingUp;
  const color = isNegative ? 'text-red-500' : 'text-emerald-500';
  return <Icon size={14} className={`${color} shrink-0`} />;
}

// ── Markdown components (slim, no extra margins) ────────────────────────────

const mdComponents = {
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-slate-800 dark:text-slate-100">{children}</strong>,
  ul: ({ children }) => <ul className="list-disc pl-4 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-sm leading-6">{children}</li>,
  code: ({ children }) => <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-mono">{children}</code>,
};

// ── Core metric pill (max 4 in core layer) ──────────────────────────────────

function MetricPill({ item }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/50 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
        {item.label}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
          {item.value}
        </span>
        <TrendIndicator value={item.value} />
      </div>
      {item.source ? (
        <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 truncate" title={item.source}>
          {item.source}
        </div>
      ) : null}
    </div>
  );
}

// ── Max pills visible in core layer ──────────────────────────────────────────

const CORE_PILL_LIMIT = 4;

export default function AgentBriefCard({ brief, attribution = null, dataSource = null }) {
  const [detailOpen, setDetailOpen] = useState(false);

  if (!brief) return null;

  const metricPills = Array.isArray(brief.metric_pills) ? brief.metric_pills.filter((item) => item?.label && item?.value != null) : [];
  const tables = Array.isArray(brief.tables) ? brief.tables.filter(Boolean) : [];
  const charts = Array.isArray(brief.charts) ? brief.charts.filter((c) => c?.type && Array.isArray(c?.data) && c.data.length > 0) : [];
  const execSummary = brief.executive_summary;

  const corePills = metricPills.slice(0, CORE_PILL_LIMIT);
  const overflowPills = metricPills.slice(CORE_PILL_LIMIT);
  const primaryChart = charts[0] || null;
  const additionalCharts = charts.slice(1);

  const hasDetailContent = overflowPills.length > 0
    || additionalCharts.length > 0
    || tables.length > 0
    || brief.key_findings?.length > 0
    || brief.implications?.length > 0
    || brief.caveats?.length > 0
    || brief.next_steps?.length > 0
    || brief.methodology_note;

  return (
    <Card className="w-full border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-0">
      {/* ── Header with accent bar ─────────────────────────────────── */}
      <div className="border-b border-slate-200 dark:border-slate-800 px-5 py-5 bg-gradient-to-r from-blue-50/60 to-transparent dark:from-blue-950/20 dark:to-transparent">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-blue-100 p-2 text-blue-600 dark:bg-blue-900/60 dark:text-blue-300">
            <BarChart3 size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                Analysis
              </p>
              {dataSource && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  {dataSource}
                </span>
              )}
              {attribution && (attribution.provider || attribution.model) && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {[attribution.provider, attribution.model].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
            <h3 className="mt-1 text-xl font-bold leading-7 text-slate-900 dark:text-slate-100">
              {brief.headline || 'Analysis complete.'}
            </h3>
            {execSummary ? (
              <p className="mt-1.5 text-sm font-medium text-blue-700 dark:text-blue-300">
                {execSummary}
              </p>
            ) : null}
            {brief.summary ? (
              <div className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300 prose-sm">
                <Markdown components={mdComponents}>{brief.summary}</Markdown>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        {/* ── Core Metric Pills (max 4) ──────────────────────────── */}
        {corePills.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {corePills.map((item) => (
              <MetricPill key={`${item.label}-${item.value}`} item={item} />
            ))}
          </div>
        ) : null}

        {/* ── Primary Chart ──────────────────────────────────────── */}
        {primaryChart ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/40">
            {primaryChart.title ? (
              <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                {primaryChart.title}
              </div>
            ) : null}
            <div className="px-2 py-3">
              <EnhanceableChart chart={primaryChart} height={240} context={{ title: brief.headline, summary: brief.summary }} />
            </div>
          </div>
        ) : null}

        {/* ── Detailed Analysis (collapsible) ────────────────────── */}
        {hasDetailContent ? (
          <div>
            <button
              type="button"
              onClick={() => setDetailOpen((prev) => !prev)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              <ChevronDown size={14} className={`transform transition-transform ${detailOpen ? '' : '-rotate-90'}`} />
              <span>Detailed Analysis</span>
            </button>

            {detailOpen ? (
              <div className="mt-4 space-y-5">
                {/* Overflow pills */}
                {overflowPills.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {overflowPills.map((item) => (
                      <MetricPill key={`${item.label}-${item.value}`} item={item} />
                    ))}
                  </div>
                ) : null}

                {/* Additional charts */}
                {additionalCharts.length > 0 ? (
                  <div className="space-y-4">
                    {additionalCharts.map((chart, i) => (
                      <div key={`brief-chart-extra-${i}`} className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/40">
                        {chart.title ? (
                          <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                            {chart.title}
                          </div>
                        ) : null}
                        <div className="px-2 py-3">
                          <EnhanceableChart chart={chart} height={240} context={{ title: chart.title, summary: brief.summary }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Evidence tables */}
                {tables.length > 0 ? (
                  <Section sectionKey="findings" title="Evidence">
                    <div className="space-y-3">
                      {tables.map((table, index) => (
                        <EvidenceTable key={`${table?.title || 'evidence'}-${index}`} table={table} />
                      ))}
                    </div>
                  </Section>
                ) : null}

                {/* Differentiated sections */}
                <Section sectionKey="findings" title="Key Findings" items={brief.key_findings} />

                {brief.key_findings?.length > 0 && (brief.implications?.length > 0 || brief.caveats?.length > 0 || brief.next_steps?.length > 0) ? (
                  <hr className="border-slate-100 dark:border-slate-800" />
                ) : null}

                <Section sectionKey="implications" title="Implications" items={brief.implications} />
                <Section sectionKey="caveats" title="Caveats" items={brief.caveats} />
                <Section sectionKey="next_steps" title="Next Steps" items={brief.next_steps} />

                {/* Methodology note */}
                {brief.methodology_note ? (
                  <div className="text-xs text-slate-400 dark:text-slate-500 italic border-t border-slate-100 dark:border-slate-800 pt-3">
                    {brief.methodology_note}
                  </div>
                ) : null}

                {/* Attribution (debug-only, hidden in collapsible) */}
                {attribution ? (
                  <div className="text-[10px] tracking-wide text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-slate-800 pt-2 mt-2">
                    {[attribution.provider, attribution.model].filter(Boolean).join(' · ')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
