/**
 * SqlResultChartCard.jsx
 *
 * Composite card for SQL query results: chart (with type switcher) + SQL block + data table.
 * Used by MessageCardRenderer for 'sql_query_result' messages.
 *
 * Props:
 * - sql: string — the executed SQL query
 * - result: { success, rows, rowCount, truncated }
 * - summary: string — markdown summary of results
 * - charts: Array<{ type, data, xKey, yKey, compatibleTypes, title }> — optional chart specs
 * - meta: query planning/probe metadata
 */

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, Table2 } from 'lucide-react';
import SqlQueryBlock from './SqlQueryBlock.jsx';
import ChartRenderer from './ChartRenderer.jsx';

export default function SqlResultChartCard({ sql, result, summary, charts = [], meta = null }) {
  const [showTable, setShowTable] = useState(false);
  const chart = charts?.[0] || null;
  const hasRows = Array.isArray(result?.rows) && result.rows.length > 0;
  const checkedTables = Array.isArray(meta?.tablesChecked)
    ? meta.tablesChecked.map((table) => table.table_name).filter(Boolean)
    : [];

  return (
    <div className="space-y-2">
      {/* Chart — prominent, on top */}
      {chart && chart.data?.length > 0 && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-gradient-to-br from-blue-50/80 to-white dark:from-blue-950/30 dark:to-gray-900 shadow-sm p-3">
          <ChartRenderer
            chart={chart}
            height={280}
            compatibleTypes={chart.compatibleTypes}
            showSwitcher={true}
          />
        </div>
      )}

      {/* SQL Query Block — collapsible */}
      <SqlQueryBlock sql={sql} result={result} toolName="Data Query" />

      {!hasRows && summary && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <p>{summary}</p>
          {(meta?.datasetLabel || checkedTables.length > 0) && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {[meta?.datasetLabel, checkedTables.length > 0 ? `Checked tables: ${checkedTables.join(', ')}` : null]
                .filter(Boolean)
                .join(' | ')}
            </p>
          )}
        </div>
      )}

      {/* Data Table — collapsible */}
      {summary && hasRows && (
        <div>
          <button
            onClick={() => setShowTable(!showTable)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 transition-colors"
          >
            <Table2 className="w-3.5 h-3.5" />
            {showTable ? 'Hide' : 'Show'} Data Table
            {showTable ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {showTable && (
            <div className="mt-2 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap overflow-x-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
