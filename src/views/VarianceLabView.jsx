/**
 * VarianceLabView — Standalone variance analysis test page.
 *
 * Flow: Upload Excel → Profile → Select analyzers → AI maps columns → Deterministic engine → View results.
 * Backend: POST /variance/profile → frontend callLLM → POST /variance/analyze.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, FileSpreadsheet, Loader2, CheckCircle, AlertCircle,
  RotateCcw, Table2, TrendingUp, Download,
} from 'lucide-react';
import { callLLM } from '../services/ai-infra/aiEmployeeLLMService';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';
const MAX_FILE_SIZE_MB = 50;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadExcel(tables, filename) {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  for (const t of tables) {
    let name = (t.label || 'Sheet').slice(0, 31);
    let base = name, i = 2;
    while (usedNames.has(name)) { name = `${base.slice(0, 28)}_${i}`; i++; }
    usedNames.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(t.data), name);
  }
  XLSX.writeFile(wb, filename);
}

export default function VarianceLabView() {
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);

  const [sheets, setSheets] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);

  const [result, setResult] = useState(null);
  const [duration, setDuration] = useState(0);
  const [activeResultSheet, setActiveResultSheet] = useState('');

  const [suggestions, setSuggestions] = useState([]);
  const [selectedAnalyzers, setSelectedAnalyzers] = useState(new Set());
  const [profilePrompts, setProfilePrompts] = useState(null);

  const [liveLog, setLiveLog] = useState([]);
  const addLog = useCallback((msg) => setLiveLog(prev => [...prev, { time: Date.now(), msg }]), []);

  const fileInputRef = useRef(null);

  const parseWorkbook = useCallback((arrayBuffer, name, size) => {
    try {
      setPhase('uploading');
      setError(null);
      const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
      const parsed = {};
      for (const sn of wb.SheetNames) parsed[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn]);
      setSheets(parsed);
      setSheetNames(wb.SheetNames);
      setActiveSheet(wb.SheetNames[0] || '');
      setFileName(name);
      setFileSize(size);
      setPhase('previewing');
      setResult(null);
      setDuration(0);
      setActiveResultSheet('');
      setSuggestions([]);
      setSelectedAnalyzers(new Set());
      setProfilePrompts(null);
      setLiveLog([]);
    } catch (err) {
      setError(`Failed to parse: ${err.message}`);
      setPhase('error');
    }
  }, []);

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) { setError('File too large'); setPhase('error'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => parseWorkbook(ev.target.result, file.name, file.size);
    reader.readAsArrayBuffer(file);
  }, [parseWorkbook]);

  const handleLoadSample = useCallback(async () => {
    try {
      setPhase('uploading');
      setError(null);
      const resp = await fetch('/sample_data/mbr_sample.xlsx');
      if (!resp.ok) throw new Error(`Failed (${resp.status})`);
      const buf = await resp.arrayBuffer();
      parseWorkbook(buf, 'mbr_sample.xlsx (sample)', buf.byteLength);
    } catch (err) { setError(err.message); setPhase('error'); }
  }, [parseWorkbook]);

  const post = async (url, body) => {
    const res = await fetch(`${ML_API}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} failed (${res.status})`);
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error || `${url} failed`);
    return data;
  };

  const runProfile = useCallback(async () => {
    if (!sheets) return;
    setError(null);
    setLiveLog([]);
    addLog('Profiling data for variance analysis...');
    try {
      const step1 = await post('/variance/profile', {
        tool_hint: 'variance-profile',
        input_data: { sheets },
      });
      setSuggestions(step1.suggestions || []);
      setProfilePrompts(step1.prompts);
      const available = (step1.suggestions || []).filter(s => s.available).map(s => s.name);
      setSelectedAnalyzers(new Set(available));
      const candidates = (step1.profile?.variance_candidates || []).length;
      addLog(`  ${candidates} sheets can do variance analysis (${step1.execution_ms}ms)`);
      setPhase('profiled');
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
      setError(err.message);
      setPhase('error');
    }
  }, [sheets, addLog]);

  const runAnalyze = useCallback(async () => {
    if (!sheets || !profilePrompts) return;
    setPhase('analyzing');
    setError(null);
    setResult(null);
    const start = Date.now();

    try {
      const selected = [...selectedAnalyzers];
      addLog(`Step 2: AI mapping ${selected.length} analyzers...`);

      const filtered = await post('/variance/profile', {
        tool_hint: 'variance-profile',
        input_data: { sheets, selected_analyzers: selected },
      });

      const llmResult = await callLLM({
        taskType: 'task_decomposition',
        systemPrompt: filtered.prompts.system,
        prompt: filtered.prompts.user,
        temperature: 0.1, maxTokens: 4000, jsonMode: false,
        modelOverride: { provider: 'deepseek', model_name: 'deepseek-chat' },
      });

      let config;
      const raw = (llmResult.text || '').trim();
      try {
        const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
        config = JSON.parse(s !== -1 && e !== -1 ? raw.slice(s, e + 1) : raw);
      } catch { throw new Error('LLM did not return valid JSON'); }

      const count = (config.analyses || []).length;
      addLog(`  ${count} analysis configs returned`);
      for (const a of (config.analyses || []).slice(0, 6)) addLog(`    ${a.analyzer}: ${a.label || ''}`);

      addLog('Step 3: Executing variance calculations...');
      const step3 = await post('/variance/analyze', {
        tool_hint: 'variance-analyze',
        input_data: { sheets, variance_config: config },
      });

      addLog(`  ${(step3.artifacts || []).length} result tables (${step3.execution_ms}ms)`);
      for (const entry of (step3.log || [])) {
        if (entry.action === 'error') addLog(`  ERROR ${entry.analyzer}: ${entry.error}`);
        if (entry.action === 'warning') addLog(`  WARN: ${entry.message}`);
      }

      setResult(step3);
      setDuration(Date.now() - start);
      const first = (step3.artifacts || []).find(a => a.type === 'table' && Array.isArray(a.data));
      setActiveResultSheet(first?.label || '');
      setPhase('complete');
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
      setError(err.message);
      setPhase('error');
    }
  }, [sheets, profilePrompts, selectedAnalyzers, addLog]);

  const handleReset = useCallback(() => {
    setPhase('idle'); setError(null); setSheets(null); setSheetNames([]);
    setActiveSheet(''); setFileName(''); setFileSize(0);
    setResult(null); setDuration(0); setActiveResultSheet('');
    setSuggestions([]); setSelectedAnalyzers(new Set()); setProfilePrompts(null); setLiveLog([]);
  }, []);

  const currentSheetData = sheets?.[activeSheet] || [];
  const columns = currentSheetData.length > 0 ? Object.keys(currentSheetData[0]) : [];
  const previewRows = currentSheetData.slice(0, 20);
  const totalRows = sheetNames.reduce((s, n) => s + (sheets?.[n]?.length || 0), 0);

  const resultTables = (result?.artifacts || []).filter(a => a.type === 'table' && Array.isArray(a.data) && a.data.length > 0);
  const activeData = resultTables.find(t => t.label === activeResultSheet)?.data || [];
  const activeCols = activeData.length > 0 && typeof activeData[0] === 'object' ? Object.keys(activeData[0]) : [];

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-primary)] flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Variance Lab</h1>
          <p className="text-xs text-[var(--text-secondary)]">Upload Excel &rarr; Waterfall + Contribution + Drill-down</p>
        </div>
        {phase !== 'idle' && (
          <button onClick={handleReset} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors">
            <RotateCcw size={14} /> Start Over
          </button>
        )}
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="w-80 flex-shrink-0 border-r border-[var(--border-primary)] p-4 flex flex-col gap-4 overflow-y-auto">

          {(phase === 'idle' || (phase === 'error' && !sheets)) && (
            <div onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[var(--border-primary)] rounded-xl p-8 text-center cursor-pointer transition-colors hover:border-amber-500 hover:bg-amber-500/5">
              <Upload size={28} className="mx-auto mb-2 text-[var(--text-tertiary)]" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Drop Excel or CSV</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">max {MAX_FILE_SIZE_MB} MB</p>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileDrop} />
            </div>
          )}

          {phase === 'idle' && (
            <button onClick={handleLoadSample} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors">
              <FileSpreadsheet size={14} /> Load Sample Data
            </button>
          )}

          {phase === 'uploading' && (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={20} className="animate-spin text-amber-500" />
              <span className="ml-2 text-sm text-[var(--text-secondary)]">Parsing...</span>
            </div>
          )}

          {sheets && phase !== 'idle' && phase !== 'uploading' && (
            <>
              <div className="rounded-lg border border-[var(--border-primary)] p-3 bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2 min-w-0">
                  <FileSpreadsheet size={14} className="text-amber-500 flex-shrink-0" />
                  <span className="text-xs font-medium text-[var(--text-primary)] truncate">{fileName}</span>
                </div>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  {sheetNames.length} sheet{sheetNames.length > 1 ? 's' : ''} &middot; {totalRows.toLocaleString()} rows &middot; {formatBytes(fileSize)}
                </p>
              </div>

              {phase === 'previewing' && (
                <button onClick={runProfile} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors">
                  <TrendingUp size={16} /> Analyze Variance
                </button>
              )}

              {phase === 'profiled' && suggestions.length > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-3">
                  <p className="text-xs font-medium text-amber-600">Select analyses:</p>
                  <div className="space-y-1.5">
                    {suggestions.map((s) => (
                      <label key={s.name} className={`flex items-start gap-2 p-1.5 rounded cursor-pointer transition-colors ${s.available ? 'hover:bg-amber-500/10' : 'opacity-40 cursor-not-allowed'}`}>
                        <input type="checkbox" checked={selectedAnalyzers.has(s.name)} disabled={!s.available}
                          onChange={(e) => setSelectedAnalyzers(prev => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(s.name) : next.delete(s.name);
                            return next;
                          })}
                          className="mt-0.5 rounded border-[var(--border-primary)]" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-[var(--text-primary)]">{s.name}</p>
                          <p className="text-[10px] text-[var(--text-tertiary)]">{s.description}</p>
                          {!s.available && <p className="text-[10px] text-amber-600">{s.reason}</p>}
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setSelectedAnalyzers(new Set(suggestions.filter(s => s.available).map(s => s.name)))} className="text-[10px] text-amber-600 hover:underline">Select All</button>
                    <button onClick={() => setSelectedAnalyzers(new Set())} className="text-[10px] text-[var(--text-tertiary)] hover:underline">Clear All</button>
                  </div>
                  <button onClick={runAnalyze} disabled={selectedAnalyzers.size === 0}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    <TrendingUp size={16} /> Run {selectedAnalyzers.size} Analysis
                  </button>
                </div>
              )}

              {phase === 'analyzing' && <ProgressPanel liveLog={liveLog} />}

              {phase === 'complete' && result && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle size={14} className="text-emerald-500" />
                      <span className="text-xs font-medium text-emerald-600">{resultTables.length} result tables ({(duration / 1000).toFixed(1)}s)</span>
                    </div>
                  </div>
                  {result.result && Object.keys(result.result).length > 0 && (
                    <div className="grid grid-cols-1 gap-1.5">
                      {Object.entries(result.result).map(([k, v]) => (
                        <div key={k} className="rounded bg-[var(--bg-secondary)] px-2 py-1">
                          <p className="text-[10px] text-[var(--text-tertiary)]">{k.replace(/_/g, ' ')}</p>
                          <p className="text-xs font-medium text-[var(--text-primary)]">
                            {typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  <button onClick={() => downloadExcel(resultTables, fileName.replace(/\.\w+$/, '') + '_variance.xlsx')}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors">
                    <Download size={14} /> Download Excel
                  </button>
                  <button onClick={() => setPhase('profiled')} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-colors">
                    <RotateCcw size={12} /> Change selection
                  </button>
                  {liveLog.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Log ({liveLog.length})</summary>
                      <div className="mt-2 max-h-48 overflow-y-auto space-y-0.5 border-t border-[var(--border-primary)] pt-2">
                        {liveLog.map((e, i) => (
                          <p key={i} className={`text-[11px] font-mono ${e.msg.startsWith('ERROR') ? 'text-red-500' : e.msg.startsWith('  ') ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}>{e.msg}</p>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-600 break-words">{error}</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {phase === 'idle' || phase === 'uploading' ? (
            <div className="flex-1 flex items-center justify-center text-[var(--text-tertiary)]">
              <div className="text-center">
                <TrendingUp size={40} className="mx-auto mb-2 opacity-30" />
                <p className="text-xs">Upload a file to analyze variance</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-primary)] flex-shrink-0 overflow-x-auto">
                {resultTables.length > 0 && (
                  <div className="flex rounded-md border border-[var(--border-primary)] overflow-hidden flex-shrink-0">
                    <button onClick={() => setActiveResultSheet('')}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${!activeResultSheet ? 'bg-[var(--brand-500)]/10 text-[var(--brand-600)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      Raw Data
                    </button>
                    <button onClick={() => setActiveResultSheet(resultTables[0]?.label || '')}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${activeResultSheet ? 'bg-amber-500/10 text-amber-600' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      Results
                    </button>
                  </div>
                )}
                {!activeResultSheet ? (
                  sheetNames.length > 1 && sheetNames.map((name) => (
                    <button key={name} onClick={() => setActiveSheet(name)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${name === activeSheet ? 'bg-[var(--brand-500)]/10 text-[var(--brand-600)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      {name} ({sheets[name]?.length || 0})
                    </button>
                  ))
                ) : (
                  resultTables.map((t, idx) => (
                    <button key={`${t.label}-${idx}`} onClick={() => setActiveResultSheet(t.label)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${t.label === activeResultSheet ? 'bg-amber-500/10 text-amber-600' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      {t.label} ({t.data.length})
                    </button>
                  ))
                )}
              </div>
              <div className="flex-1 overflow-auto p-4">
                {!activeResultSheet ? (
                  columns.length > 0 ? <DataTable columns={columns} rows={previewRows} totalRows={currentSheetData.length} />
                    : <p className="text-xs text-[var(--text-tertiary)]">Empty sheet.</p>
                ) : (
                  activeCols.length > 0 ? <DataTable columns={activeCols} rows={activeData.slice(0, 100)} totalRows={activeData.length} />
                    : <p className="text-xs text-[var(--text-tertiary)]">Select a result table.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressPanel({ liveLog }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    startRef.current = Date.now(); setElapsed(0);
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="text-amber-500 animate-spin" />
          <span className="text-xs font-medium text-amber-600">Analyzing...</span>
        </div>
        <span className="text-xs font-mono text-[var(--text-tertiary)] tabular-nums">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
      </div>
      {liveLog.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-0.5 border-t border-[var(--border-primary)] pt-2">
          {liveLog.map((e, i) => (
            <p key={i} className={`text-[11px] font-mono ${e.msg.startsWith('ERROR') ? 'text-red-500' : e.msg.startsWith('  ') ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}>{e.msg}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function DataTable({ columns, rows, totalRows }) {
  return (
    <div className="border border-[var(--border-primary)] rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr className="bg-[var(--bg-secondary)]">
              <th className="px-2 py-1.5 text-left font-medium text-[var(--text-tertiary)] border-b border-[var(--border-primary)] w-8 sticky left-0 bg-[var(--bg-secondary)]">#</th>
              {columns.map((col) => (
                <th key={col} className="px-2 py-1.5 text-left font-medium text-[var(--text-secondary)] border-b border-[var(--border-primary)] whitespace-nowrap">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border-primary)] last:border-b-0 hover:bg-[var(--bg-secondary)]/50">
                <td className="px-2 py-1 text-[var(--text-tertiary)] sticky left-0 bg-[var(--bg-primary)]">{i + 1}</td>
                {columns.map((col) => (
                  <td key={col} className="px-2 py-1 text-[var(--text-primary)] whitespace-nowrap max-w-[200px] truncate">
                    {row[col] != null ? (typeof row[col] === 'number' ? row[col].toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(row[col])) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalRows > rows.length && (
        <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)] bg-[var(--bg-secondary)] border-t border-[var(--border-primary)]">
          Showing {rows.length} of {totalRows.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
