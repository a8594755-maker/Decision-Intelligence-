/**
 * EvalLabView — Tier 1 Tool Evaluation Dashboard
 *
 * Loads golden test data → runs all 15 tools → shows pass/fail + key output tables.
 * One-click download: all tool outputs in one Excel (each tool = separate sheet).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, FileSpreadsheet, Loader2, CheckCircle, XCircle,
  AlertTriangle, RotateCcw, Play, Download, Zap, ChevronDown, ChevronRight,
} from 'lucide-react';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';

const TOOL_META = {
  run_mbr_cleaning:       { icon: '🧹', color: '#6366f1' },
  run_eda:                { icon: '📊', color: '#0ea5e9' },
  run_data_cleaning:      { icon: '✨', color: '#8b5cf6' },
  run_mbr_kpi:            { icon: '📈', color: '#10b981' },
  run_mbr_variance:       { icon: '🎯', color: '#f59e0b' },
  run_mbr_anomaly:        { icon: '🔍', color: '#ef4444' },
  run_forecast:           { icon: '🔮', color: '#06b6d4' },
  run_ml_forecast:        { icon: '🤖', color: '#0284c7' },
  run_bom_explosion:      { icon: '💥', color: '#d946ef' },
  run_lp_solver:          { icon: '⚙️', color: '#64748b' },
  run_inventory_projection: { icon: '📦', color: '#14b8a6' },
  run_risk_score:         { icon: '⚠️', color: '#f97316' },
  run_plan:               { icon: '📋', color: '#3b82f6' },
  run_cost_forecast:      { icon: '💰', color: '#22c55e' },
  run_revenue_forecast:   { icon: '💵', color: '#16a34a' },
};

function buildLogText(data) {
  const lines = [];
  const mode = data.mode || 'unit';
  lines.push(`## Eval Results (${mode}) — ${data.passed}/${data.total_tools || data.total_assertions} passed (${data.pass_rate}%)`);
  lines.push(`Duration: ${(data.total_duration_ms / 1000).toFixed(1)}s`);
  lines.push('');

  // Pipeline step log (detailed execution trace)
  if (data.step_log && data.step_log.length > 0) {
    lines.push('### Execution Log');
    for (const entry of data.step_log) {
      lines.push(`[${entry.time}s] [${entry.step}] ${entry.msg}`);
    }
    lines.push('');
  }

  // LLM calls summary
  if (data.llm_calls && data.llm_calls.length > 0) {
    lines.push(`### LLM Calls (${data.llm_calls.length})`);
    for (const call of data.llm_calls) {
      if (call.error) {
        lines.push(`  ❌ FAILED: ${call.error}`);
      } else {
        lines.push(`  📡 ${call.purpose.slice(0, 60)}... → ${call.output_chars} chars (${call.duration_s}s)`);
      }
    }
    lines.push('');
  }

  if (data.assertions) {
    lines.push('### Pipeline Assertions');
    for (const a of data.assertions) {
      lines.push(`${a.pass ? '✅' : '❌'} ${a.name} — ${a.detail}`);
    }
    lines.push('');
  }

  if (data.results) {
    lines.push('### Tool Results');
    for (const r of data.results) {
      const icon = r.pass ? '✅' : '❌';
      lines.push(`${icon} **${r.name}** (${r.duration_ms}ms) — ${r.details}`);
      if (r.summary && typeof r.summary === 'object') {
        const vals = Object.entries(r.summary).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toLocaleString() : v}`).join(', ');
        if (vals) lines.push(`   ${vals}`);
      }
      if (r.error) lines.push(`   ERROR: ${r.error.slice(0, 100)}`);
    }
  }
  return lines.join('\n');
}

function downloadAllResults(fullData, fileName) {
  const results = fullData.results || [];
  const assertions = fullData.assertions || [];
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();

  // Summary sheet
  if (assertions.length > 0) {
    const assertRows = assertions.map(a => ({ assertion: a.name, pass: a.pass ? 'PASS' : 'FAIL', detail: a.detail }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(assertRows), 'Pipeline Assertions');
    usedNames.add('Pipeline Assertions');
  }

  if (results.length > 0) {
    const summaryRows = results.map(r => ({
      tool: r.tool_id, name: r.name, status: r.pass ? 'PASS' : 'FAIL',
      details: r.details, duration_ms: r.duration_ms,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');
    usedNames.add('Summary');
  }

  // Each tool's key tables
  for (const r of results) {
    for (const table of (r.key_tables || [])) {
      if (!table.data || table.data.length === 0) continue;
      let name = `${(r.tool_id || '').replace('run_', '').slice(0, 12)}_${(table.label || 'data').slice(0, 16)}`.slice(0, 31);
      let base = name, i = 2;
      while (usedNames.has(name)) { name = `${base.slice(0, 28)}_${i}`; i++; }
      usedNames.add(name);
      const data = table.data.map(row => typeof row === 'object' && !Array.isArray(row) ? row : { value: JSON.stringify(row) });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), name);
    }
  }

  XLSX.writeFile(wb, fileName);
}

export default function EvalLabView() {
  const [phase, setPhase] = useState('idle');
  const [sheets, setSheets] = useState(null);
  const [fileName, setFileName] = useState('');
  const [sheetNames, setSheetNames] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [results, setResults] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [expandedTool, setExpandedTool] = useState(null);
  const timerRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (phase === 'running') {
      const start = Date.now();
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    } else { clearInterval(timerRef.current); }
    return () => clearInterval(timerRef.current);
  }, [phase]);

  const parseWorkbook = useCallback((buf, name) => {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const parsed = {};
    let rows = 0;
    for (const sn of wb.SheetNames) { parsed[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn]); rows += parsed[sn].length; }
    setSheets(parsed); setFileName(name); setSheetNames(wb.SheetNames); setTotalRows(rows);
    setPhase('loaded'); setResults(null); setError(null);
  }, []);

  const loadGoldenAndRun = useCallback(async () => {
    setPhase('loading');
    try {
      const resp = await fetch('/sample_data/eval_golden.xlsx');
      if (!resp.ok) throw new Error(`Failed (${resp.status})`);
      const buf = await resp.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const parsed = {};
      let rows = 0;
      for (const sn of wb.SheetNames) { parsed[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn]); rows += parsed[sn].length; }
      setSheets(parsed); setFileName('eval_golden.xlsx'); setSheetNames(wb.SheetNames); setTotalRows(rows);
      // Auto-run
      setPhase('running'); setResults(null); setElapsed(0); setError(null);
      const r = await fetch(`${ML_API}/eval/run-tier1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheets: parsed }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error);
      setResults(data); setPhase('done');
    } catch (err) { setError(err.message); setPhase('error'); }
  }, []);

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => parseWorkbook(ev.target.result, file.name);
    reader.readAsArrayBuffer(file);
  }, [parseWorkbook]);

  const [evalMode, setEvalMode] = useState('unit'); // unit | pipeline | pipeline_llm

  const runEval = useCallback(async (mode) => {
    if (!sheets) return;
    const m = mode || evalMode;
    setPhase('running'); setResults(null); setElapsed(0); setError(null);
    try {
      const endpoint = m === 'unit' ? '/eval/run-tier1' : '/eval/run-pipeline';
      const body = m === 'pipeline_llm'
        ? { sheets, use_llm: true, dataset_name: fileName }
        : { sheets, dataset_name: fileName };
      const resp = await fetch(`${ML_API}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      setResults(data); setPhase('done');
    } catch (err) { setError(err.message); setPhase('error'); }
  }, [sheets, evalMode]);

  const handleReset = () => {
    setPhase('idle'); setSheets(null); setFileName(''); setSheetNames([]);
    setTotalRows(0); setResults(null); setError(null); setExpandedTool(null);
  };

  const passed = results?.passed || 0;
  const total = results?.total_tools || 0;
  const failed = results?.failed || 0;
  const passRate = results?.pass_rate || 0;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-primary)] flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Eval Lab</h1>
          <p className="text-xs text-[var(--text-secondary)]">Tier 1 Tool Verification — 15 tools</p>
        </div>
        <div className="flex items-center gap-3">
          {phase === 'running' && (
            <span className="text-xs font-mono text-[var(--text-tertiary)] tabular-nums">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
          )}
          {phase !== 'idle' && (
            <button onClick={handleReset} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
              <RotateCcw size={14} /> Reset
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {phase === 'idle' && (
          <div className="max-w-md mx-auto mt-16 space-y-4">
            <div onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[var(--border-primary)] rounded-xl p-10 text-center cursor-pointer hover:border-emerald-500 hover:bg-emerald-500/5">
              <Upload size={32} className="mx-auto mb-3 text-[var(--text-tertiary)]" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Drop test Excel or use golden data</p>
              <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileDrop} />
            </div>
            <button onClick={loadGoldenAndRun}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
              <Zap size={16} /> Load Golden Data & Run All
            </button>
          </div>
        )}

        {phase === 'loading' && (
          <div className="flex items-center justify-center mt-20">
            <Loader2 size={24} className="animate-spin text-emerald-500" />
            <span className="ml-3 text-sm text-[var(--text-secondary)]">Loading...</span>
          </div>
        )}

        {phase === 'loaded' && sheets && (
          <div className="max-w-md mx-auto mt-12 space-y-4">
            <div className="rounded-lg border border-[var(--border-primary)] p-4 bg-[var(--bg-secondary)]">
              <div className="flex items-center gap-2">
                <FileSpreadsheet size={16} className="text-emerald-500" />
                <span className="text-sm font-medium text-[var(--text-primary)]">{fileName}</span>
              </div>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">
                {sheetNames.join(', ')} — {totalRows.toLocaleString()} rows
              </p>
            </div>

            {/* Mode selector */}
            <div className="flex rounded-lg border border-[var(--border-primary)] overflow-hidden">
              {[
                { id: 'unit', label: 'Unit Test', desc: 'Each tool independent' },
                { id: 'pipeline', label: 'Pipeline', desc: 'Chain: clean→KPI→...' },
                { id: 'pipeline_llm', label: 'Pipeline + LLM', desc: 'Full with AI cleaning' },
              ].map(m => (
                <button key={m.id} onClick={() => setEvalMode(m.id)}
                  className={`flex-1 px-3 py-2 text-center transition-colors ${
                    evalMode === m.id
                      ? 'bg-emerald-500/10 text-emerald-600 border-b-2 border-emerald-500'
                      : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'
                  }`}>
                  <p className="text-xs font-medium">{m.label}</p>
                  <p className="text-[9px] text-[var(--text-tertiary)]">{m.desc}</p>
                </button>
              ))}
            </div>

            <button onClick={() => runEval()}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
              <Play size={16} /> Run {evalMode === 'unit' ? '15 Tools' : 'Pipeline'}
            </button>
          </div>
        )}

        {phase === 'running' && (
          <div className="flex flex-col items-center justify-center mt-20">
            <Loader2 size={32} className="animate-spin text-emerald-500" />
            <p className="mt-4 text-sm text-[var(--text-secondary)]">
              Running {evalMode === 'unit' ? '15 tools' : 'pipeline'}...
            </p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">
              {evalMode === 'pipeline_llm' ? 'LLM cleaning may take 20-30s' : 'Usually 1-3 seconds'}
            </p>
          </div>
        )}

        {phase === 'done' && results && (
          <div className="max-w-4xl mx-auto space-y-5">
            {/* Banner */}
            <div className={`rounded-xl p-5 flex items-center justify-between ${
              failed === 0 ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-amber-500/10 border border-amber-500/30'
            }`}>
              <div className="flex items-center gap-3">
                {failed === 0 ? <CheckCircle size={28} className="text-emerald-500" /> : <AlertTriangle size={28} className="text-amber-500" />}
                <div>
                  <p className={`text-lg font-bold ${failed === 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {passed}/{total} Passed ({passRate}%)
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    {results.total_duration_ms ? `${(results.total_duration_ms / 1000).toFixed(1)}s` : ''}{failed > 0 ? ` — ${failed} failed` : ' — All operational'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { navigator.clipboard.writeText(buildLogText(results)); }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                  Copy Log
                </button>
                <button onClick={() => downloadAllResults(results, `eval_results_${fileName.replace('.xlsx', '')}.xlsx`)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700">
                  <Download size={14} /> Download Excel
                </button>
              </div>
            </div>

            {/* Pipeline: Execution Log */}
            {results.mode === 'pipeline' && results.step_log && results.step_log.length > 0 && (
              <div className="rounded-lg border border-[var(--border-primary)] overflow-hidden">
                <p className="px-3 py-2 text-xs font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-b border-[var(--border-primary)]">
                  Execution Log ({results.step_log.length} entries)
                  {results.llm_calls?.length > 0 && ` • ${results.llm_calls.length} LLM calls`}
                </p>
                <div className="max-h-[300px] overflow-y-auto px-3 py-2 space-y-0.5">
                  {results.step_log.map((entry, i) => (
                    <p key={i} className={`text-[11px] font-mono leading-relaxed ${
                      entry.msg.includes('FAILED') || entry.msg.includes('ERROR') ? 'text-red-500' :
                      entry.step === 'llm' ? 'text-blue-500' :
                      entry.msg.startsWith('  ') ? 'text-[var(--text-tertiary)]' :
                      'text-[var(--text-secondary)]'
                    }`}>
                      <span className="text-[var(--text-tertiary)]">[{entry.time}s]</span>{' '}
                      <span className="font-semibold">[{entry.step}]</span>{' '}
                      {entry.msg}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Pipeline: LLM Calls Detail */}
            {results.llm_calls && results.llm_calls.length > 0 && (
              <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
                <p className="text-xs font-medium text-blue-600 mb-2">LLM Calls ({results.llm_calls.length})</p>
                {results.llm_calls.map((call, i) => (
                  <div key={i} className="text-[11px] mb-1">
                    {call.error
                      ? <span className="text-red-500">❌ {call.error}</span>
                      : <span className="text-[var(--text-secondary)]">
                          📡 {call.purpose?.slice(0, 50)}... → {call.output_chars} chars ({call.duration_s}s)
                        </span>}
                  </div>
                ))}
              </div>
            )}

            {/* Pipeline assertions */}
            {results.mode === 'pipeline' && results.assertions && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">Pipeline Assertions</p>
                {results.assertions.map((a, i) => (
                  <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg ${
                    a.pass ? 'bg-emerald-500/5 border border-emerald-500/20' : 'bg-red-500/5 border border-red-500/20'
                  }`}>
                    {a.pass ? <CheckCircle size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-red-500" />}
                    <span className="text-xs font-medium text-[var(--text-primary)]">{a.name}</span>
                    <span className="text-[10px] text-[var(--text-tertiary)] ml-auto">{a.detail}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Tool cards (unit test mode) */}
            <div className="space-y-2">
              {(results.results || []).map((r) => {
                const meta = TOOL_META[r.tool_id] || { icon: '🔧', color: '#94a3b8' };
                const isExpanded = expandedTool === r.tool_id;
                const hasData = (r.key_tables || []).some(t => t.data?.length > 0) || r.summary;
                return (
                  <div key={r.tool_id} className={`rounded-lg border overflow-hidden ${
                    r.pass ? 'border-emerald-500/20' : 'border-red-500/20'
                  }`}>
                    {/* Header */}
                    <button onClick={() => setExpandedTool(isExpanded ? null : r.tool_id)}
                      className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                        r.pass ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : 'bg-red-500/5 hover:bg-red-500/10'
                      }`}>
                      {r.pass ? <CheckCircle size={16} className="text-emerald-500 flex-shrink-0" />
                               : <XCircle size={16} className="text-red-500 flex-shrink-0" />}
                      <span className="text-sm">{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-[var(--text-primary)]">{r.name}</p>
                        <p className="text-[10px] text-[var(--text-tertiary)] truncate">{r.details}</p>
                      </div>
                      <span className="text-[10px] font-mono text-[var(--text-tertiary)] flex-shrink-0 mr-2">{r.duration_ms}ms</span>
                      {hasData && (isExpanded ? <ChevronDown size={14} className="text-[var(--text-tertiary)]" /> : <ChevronRight size={14} className="text-[var(--text-tertiary)]" />)}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="border-t border-[var(--border-primary)] bg-[var(--bg-secondary)]/50">
                        {/* Summary KPIs */}
                        {r.summary && typeof r.summary === 'object' && (
                          <div className="px-4 py-2 flex flex-wrap gap-3 border-b border-[var(--border-primary)]">
                            {Object.entries(r.summary).map(([k, v]) => (
                              <div key={k} className="bg-[var(--bg-primary)] rounded px-2 py-1">
                                <p className="text-[9px] text-[var(--text-tertiary)]">{k.replace(/_/g, ' ')}</p>
                                <p className="text-xs font-medium text-[var(--text-primary)]">
                                  {typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v)}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Key tables */}
                        {(r.key_tables || []).map((table, ti) => (
                          table.data?.length > 0 && (
                            <div key={ti} className="px-4 py-2">
                              <p className="text-[10px] font-medium text-[var(--text-secondary)] mb-1.5">
                                {table.label}{table.total_rows > table.data.length ? ` (showing ${table.data.length} of ${table.total_rows})` : ''}
                              </p>
                              <div className="overflow-x-auto border border-[var(--border-primary)] rounded">
                                <table className="text-[11px] w-full">
                                  <thead>
                                    <tr className="bg-[var(--bg-secondary)]">
                                      {typeof table.data[0] === 'object' && Object.keys(table.data[0]).map(col => (
                                        <th key={col} className="px-2 py-1 text-left font-medium text-[var(--text-tertiary)] border-b border-[var(--border-primary)] whitespace-nowrap">{col}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {table.data.map((row, ri) => (
                                      <tr key={ri} className="border-b border-[var(--border-primary)] last:border-0">
                                        {typeof row === 'object' && Object.values(row).map((v, ci) => (
                                          <td key={ci} className="px-2 py-1 text-[var(--text-primary)] whitespace-nowrap max-w-[200px] truncate">
                                            {v != null ? (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : typeof v === 'object' ? JSON.stringify(v) : String(v)) : ''}
                                          </td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )
                        ))}

                        {r.error && (
                          <pre className="px-4 py-2 text-[11px] font-mono text-red-500 max-h-32 overflow-auto">{r.error}</pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Full log (expandable, select-all) */}
            <details className="rounded-lg border border-[var(--border-primary)] overflow-hidden">
              <summary className="px-4 py-2 bg-[var(--bg-secondary)] cursor-pointer text-xs font-medium text-[var(--text-secondary)]">
                Full Log (expand to copy)
              </summary>
              <pre className="px-4 py-3 text-[11px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap max-h-[500px] overflow-auto select-all bg-[var(--bg-primary)]">
                {buildLogText(results)}
              </pre>
            </details>

            {/* Actions */}
            <div className="flex gap-3">
              <button onClick={runEval}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                <RotateCcw size={14} /> Re-run
              </button>
              <button onClick={() => navigator.clipboard.writeText(buildLogText(results))}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                Copy Log
              </button>
              <button onClick={() => downloadAllResults(results, `eval_results_${fileName.replace('.xlsx', '')}.xlsx`)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700">
                <Download size={14} /> Excel
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="max-w-md mx-auto mt-12 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
            <div className="flex items-start gap-2">
              <XCircle size={16} className="text-red-500 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-600">Error</p>
                <p className="text-xs text-red-500 mt-1">{error}</p>
                <button onClick={() => { setError(null); setPhase(sheets ? 'loaded' : 'idle'); }}
                  className="mt-2 text-xs text-red-600 hover:underline">Try again</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
