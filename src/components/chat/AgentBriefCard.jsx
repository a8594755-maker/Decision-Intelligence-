import React from 'react';
import { BarChart3, ChevronRight, Info, Lightbulb, TriangleAlert } from 'lucide-react';
import { Card } from '../ui';
import ChartRenderer from './ChartRenderer.jsx';

function Section({ icon: Icon, title, items, children }) {
  const hasItems = Array.isArray(items) && items.length > 0;
  if (!hasItems && !children) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
        {Icon ? <Icon size={14} className="text-slate-400 dark:text-slate-500" /> : null}
        <span>{title}</span>
      </div>
      {hasItems ? (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm leading-6 text-slate-700 dark:text-slate-200">
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
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/40">
      {table.title ? (
        <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
          {table.title}
        </div>
      ) : null}
      <div className="overflow-x-auto">
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

export default function AgentBriefCard({ brief, attribution = null }) {
  if (!brief) return null;

  const metricPills = Array.isArray(brief.metric_pills) ? brief.metric_pills.filter((item) => item?.label && item?.value != null) : [];
  const tables = Array.isArray(brief.tables) ? brief.tables.filter(Boolean) : [];
  const charts = Array.isArray(brief.charts) ? brief.charts.filter((c) => c?.type && Array.isArray(c?.data) && c.data.length > 0) : [];
  const attributionText = [attribution?.provider, attribution?.model].filter(Boolean).join(' · ');

  return (
    <Card className="w-full border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-0">
      <div className="border-b border-slate-200 dark:border-slate-800 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <BarChart3 size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                Agent Brief
              </p>
              {attributionText ? (
                <span className="text-[10px] tracking-wide text-slate-400 dark:text-slate-500">
                  {attributionText}
                </span>
              ) : null}
            </div>
            <h3 className="mt-1 text-lg font-semibold leading-7 text-slate-900 dark:text-slate-100">
              {brief.headline || 'Analysis complete.'}
            </h3>
            {brief.summary ? (
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {brief.summary}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-5 px-5 py-4">
        {metricPills.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {metricPills.map((item) => (
              <div
                key={`${item.label}-${item.value}`}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/50 px-4 py-3"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                  {item.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {charts.length > 0 ? (
          <div className="space-y-4">
            {charts.map((chart, i) => (
              <div key={`brief-chart-${i}`} className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/40">
                {chart.title ? (
                  <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                    {chart.title}
                  </div>
                ) : null}
                <div className="px-2 py-3">
                  <ChartRenderer chart={chart} height={240} showSwitcher={false} />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {tables.length > 0 ? (
          <Section icon={Info} title="Evidence">
            <div className="space-y-3">
              {tables.map((table, index) => (
                <EvidenceTable key={`${table?.title || 'evidence'}-${index}`} table={table} />
              ))}
            </div>
          </Section>
        ) : null}

        <Section icon={Lightbulb} title="Key Findings" items={brief.key_findings} />
        <Section icon={Info} title="Implications" items={brief.implications} />
        <Section icon={TriangleAlert} title="Caveats" items={brief.caveats} />
        <Section icon={ChevronRight} title="Next Steps" items={brief.next_steps} />
      </div>
    </Card>
  );
}
