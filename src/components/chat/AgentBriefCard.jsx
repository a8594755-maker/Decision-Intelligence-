import React, { useState } from 'react';
import Markdown from 'react-markdown';
import { BarChart3, ChevronDown, ChevronRight, Info, Lightbulb, Search, TriangleAlert, TrendingUp, TrendingDown, CheckSquare } from 'lucide-react';
import { Card, Button } from '../ui';
import ChartRenderer from './ChartRenderer.jsx';
import { EnhanceableChart } from './AnalysisResultCard.jsx';

// ── Section color themes ────────────────────────────────────────────────────

const SECTION_THEMES = {
  findings:     { border: 'border-l-[var(--status-success)]', icon: Lightbulb,      iconColor: 'text-[var(--status-success)]' },
  implications: { border: 'border-l-[var(--cat-plan)]',       icon: Info,           iconColor: 'text-[var(--cat-plan)]' },
  caveats:      { border: 'border-l-[var(--status-warning)]', icon: TriangleAlert,  iconColor: 'text-[var(--status-warning)]' },
  next_steps:   { border: 'border-l-[var(--cat-analysis)]',   icon: CheckSquare,    iconColor: 'text-[var(--cat-analysis)]' },
};

function Section({ sectionKey, title, items, children }) {
  const hasItems = Array.isArray(items) && items.length > 0;
  if (!hasItems && !children) return null;

  const theme = SECTION_THEMES[sectionKey] || SECTION_THEMES.findings;
  const Icon = theme.icon;

  return (
    <div className={`border-l-[3px] ${theme.border} pl-4 space-y-2`}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
        <Icon size={14} className={theme.iconColor} />
        <span>{title}</span>
      </div>
      {hasItems ? (
        <ul className="space-y-1.5">
          {items.map((item, idx) => (
            <li key={`${sectionKey}-${idx}`} className="flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
              <ChevronRight size={14} className="mt-1 shrink-0 text-[var(--text-muted)]" />
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
    <div className="rounded-xl border border-[var(--border-default)] overflow-hidden bg-[var(--surface-card)] max-w-full">
      {table.title ? (
        <div className="border-b border-[var(--border-default)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)] truncate">
          {table.title}
        </div>
      ) : null}
      <div className="overflow-x-auto max-w-full">
        <table className="min-w-full text-sm">
          <thead className="bg-[var(--surface-subtle)]">
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(table.rows || []).map((row, rowIdx) => (
              <tr key={`${table.title || 'table'}-${rowIdx}`} className="border-t border-[var(--border-default)]">
                {row.map((value, cellIdx) => (
                  <td key={`${rowIdx}-${cellIdx}`} className="px-4 py-2.5 text-[var(--text-primary)]">
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
  const color = isNegative ? 'text-[var(--status-danger)]' : 'text-[var(--status-success)]';
  return <Icon size={14} className={`${color} shrink-0`} />;
}

// ── Markdown components (slim, no extra margins) ────────────────────────────

const mdComponents = {
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
  ul: ({ children }) => <ul className="list-disc pl-4 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-sm leading-6">{children}</li>,
  code: ({ children }) => <code className="px-1 py-0.5 rounded bg-[var(--surface-subtle)] text-xs font-mono">{children}</code>,
};

// ── Core metric pill (max 4 in core layer) ──────────────────────────────────

function MetricPill({ item }) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-subtle)] px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
        {item.label}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-xl font-bold tabular-nums text-[var(--text-primary)]">
          {item.value}
        </span>
        <TrendIndicator value={item.value} />
      </div>
      {item.source ? (
        <div className="mt-1 text-[10px] text-[var(--text-muted)] truncate" title={item.source}>
          {item.source}
        </div>
      ) : null}
    </div>
  );
}

// ── Max pills visible in core layer ──────────────────────────────────────────

const CORE_PILL_LIMIT = 4;

export default function AgentBriefCard({ brief, attribution = null, dataSource = null, onDeepDive = null }) {
  const [detailOpen, setDetailOpen] = useState(false);

  if (!brief) return null;

  const metricPills = Array.isArray(brief.metric_pills) ? brief.metric_pills.filter((item) => item?.label && item?.value != null) : [];
  const tables = Array.isArray(brief.tables) ? brief.tables.filter(Boolean) : [];
  const charts = Array.isArray(brief.charts) ? brief.charts.filter((c) => c?.type && Array.isArray(c?.data) && c.data.length > 0) : [];
  // Support V2 narrative shape: brief.narrative.headline + brief.narrative.body
  const headline = brief.narrative?.headline || brief.headline || 'Analysis complete.';
  const summary = brief.narrative?.body || brief.summary || '';
  const execSummary = brief.narrative ? null : brief.executive_summary; // V2 removes exec_summary

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
    <Card category="analysis" className="w-full border-[var(--border-default)] bg-[var(--surface-card)] p-0">
      {/* ── Header with accent bar ─────────────────────────────────── */}
      <div className="border-b border-[var(--border-default)] px-5 py-5 bg-gradient-to-r from-[var(--status-info-bg)] to-transparent">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-[var(--status-info-bg)] p-2 text-[var(--status-info)]">
            <BarChart3 size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
                {brief._analysisType || 'Analysis'}
              </p>
              {dataSource && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--status-success-bg)] text-[var(--status-success-text)]">
                  {dataSource}
                </span>
              )}
              {attribution && (attribution.provider || attribution.model) && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                  {[attribution.provider, attribution.model].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
            <h3 className="mt-1 text-xl font-bold leading-7 text-[var(--text-primary)]">
              {headline}
            </h3>
            {execSummary ? (
              <p className="mt-1.5 text-sm font-medium text-[var(--status-info-text)]">
                {execSummary}
              </p>
            ) : null}
            {summary ? (
              <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)] prose-sm">
                <Markdown components={mdComponents}>{summary}</Markdown>
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
          <div className="rounded-xl border border-[var(--border-default)] overflow-hidden bg-[var(--surface-card)]">
            {primaryChart.title ? (
              <div className="border-b border-[var(--border-default)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                {primaryChart.title}
              </div>
            ) : null}
            <div className="px-2 py-3">
              <EnhanceableChart chart={primaryChart} height={240} context={{ title: headline, summary }} />
            </div>
          </div>
        ) : null}

        {/* ── Detailed Analysis (collapsible) ────────────────────── */}
        {hasDetailContent ? (
          <div>
            <button
              type="button"
              onClick={() => setDetailOpen((prev) => !prev)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
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
                      <div key={`brief-chart-extra-${i}`} className="rounded-xl border border-[var(--border-default)] overflow-hidden bg-[var(--surface-card)]">
                        {chart.title ? (
                          <div className="border-b border-[var(--border-default)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                            {chart.title}
                          </div>
                        ) : null}
                        <div className="px-2 py-3">
                          <EnhanceableChart chart={chart} height={240} context={{ title: chart.title, summary }} />
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
                  <hr className="border-[var(--border-default)]" />
                ) : null}

                <Section sectionKey="implications" title="Implications" items={brief.implications} />
                <Section sectionKey="caveats" title="Caveats" items={brief.caveats} />
                <Section sectionKey="next_steps" title="Next Steps" items={brief.next_steps} />

                {/* Methodology note */}
                {brief.methodology_note ? (
                  <div className="text-xs text-[var(--text-muted)] italic border-t border-[var(--border-default)] pt-3">
                    {brief.methodology_note}
                  </div>
                ) : null}

                {/* Deep-dive buttons (from unified AnalysisInsight) */}
                {Array.isArray(brief._deepDives) && brief._deepDives.length > 0 && onDeepDive ? (
                  <div className="flex flex-wrap gap-2 border-t border-[var(--border-default)] pt-3">
                    {brief._deepDives.map((dd) => (
                      <button
                        key={dd.id || dd.label}
                        onClick={() => onDeepDive(dd)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--accent-active)] hover:text-[var(--brand-600)] transition-colors"
                      >
                        <Search size={12} />
                        {dd.label}
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* Attribution (debug-only, hidden in collapsible) */}
                {attribution ? (
                  <div className="text-[10px] tracking-wide text-[var(--text-muted)] border-t border-[var(--border-default)] pt-2 mt-2">
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
