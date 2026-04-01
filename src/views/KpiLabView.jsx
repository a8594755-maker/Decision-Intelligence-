/**
 * KpiLabView — Standalone KPI calculation test page.
 *
 * Flow: Upload Excel → Profile → AI maps columns → Deterministic calculators → View KPI tables.
 * Backend: POST /kpi/profile (no LLM) → frontend callLLM → POST /kpi/calculate (no LLM).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, FileSpreadsheet, Loader2, CheckCircle, AlertCircle,
  RotateCcw, Table2, BarChart3, Download,
} from 'lucide-react';
import { callLLM } from '../services/ai-infra/aiEmployeeLLMService';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';
const MAX_FILE_SIZE_MB = 50;

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    let base = name;
    let i = 2;
    while (usedNames.has(name)) {
      name = `${base.slice(0, 28)}_${i}`;
      i++;
    }
    usedNames.add(name);
    const ws = XLSX.utils.json_to_sheet(t.data);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, filename);
}

// ── Main View ───────────────────────────────────────────────────────────────

export default function KpiLabView() {
  const [phase, setPhase] = useState('idle'); // idle | uploading | previewing | profiled | calculating | complete | error
  const [error, setError] = useState(null);

  // Raw data
  const [sheets, setSheets] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);

  // KPI results
  const [kpiResult, setKpiResult] = useState(null);
  const [kpiDuration, setKpiDuration] = useState(0);
  const [activeKpiSheet, setActiveKpiSheet] = useState('');

  // Profile + calculator selection
  const [profile, setProfile] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [selectedCalcs, setSelectedCalcs] = useState(new Set());
  const [profilePrompts, setProfilePrompts] = useState(null);

  // Live log
  const [liveLog, setLiveLog] = useState([]);
  const addLog = useCallback((msg) => {
    setLiveLog(prev => [...prev, { time: Date.now(), msg }]);
  }, []);

  const fileInputRef = useRef(null);

  // ── Parse Excel ──────────────────────────────────────────────────────────

  const parseWorkbook = useCallback((arrayBuffer, name, size) => {
    try {
      setPhase('uploading');
      setError(null);
      const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
      const parsed = {};
      for (const sn of wb.SheetNames) {
        parsed[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn]);
      }
      setSheets(parsed);
      setSheetNames(wb.SheetNames);
      setActiveSheet(wb.SheetNames[0] || '');
      setFileName(name);
      setFileSize(size);
      setPhase('previewing');
      setKpiResult(null);
      setKpiDuration(0);
      setActiveKpiSheet('');
      setProfile(null);
      setLiveLog([]);
    } catch (err) {
      setError(`Failed to parse file: ${err.message}`);
      setPhase('error');
    }
  }, []);

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setError(`File too large. Max ${MAX_FILE_SIZE_MB} MB.`);
      setPhase('error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => parseWorkbook(ev.target.result, file.name, file.size);
    reader.readAsArrayBuffer(file);
  }, [parseWorkbook]);

  const handleLoadSample = useCallback(async () => {
    try {
      setPhase('uploading');
      setError(null);
      const resp = await fetch('/sample_data/mbr_sample.xlsx');
      if (!resp.ok) throw new Error(`Failed to load sample (${resp.status})`);
      const buf = await resp.arrayBuffer();
      parseWorkbook(buf, 'mbr_sample.xlsx (sample)', buf.byteLength);
    } catch (err) {
      setError(`Failed to load sample: ${err.message}`);
      setPhase('error');
    }
  }, [parseWorkbook]);

  // ── KPI Flow: profile → select → LLM → calculate ──────────────────────

  const post = async (url, body) => {
    const res = await fetch(`${ML_API}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error || `${url} returned ok=false`);
    return data;
  };

  // Step 1: Profile — returns suggestions checklist
  const runProfile = useCallback(async () => {
    if (!sheets) return;
    setError(null);
    setLiveLog([]);
    addLog('Profiling data structure...');

    try {
      const step1 = await post('/kpi/profile', {
        tool_hint: 'kpi-profile',
        input_data: { sheets },
      });
      setProfile(step1.profile);
      setSuggestions(step1.suggestions || []);
      setProfilePrompts(step1.prompts);

      // Auto-select available calculators
      const available = (step1.suggestions || []).filter(s => s.available).map(s => s.name);
      setSelectedCalcs(new Set(available));

      const sheetCount = Object.keys(step1.profile?.sheets || {}).length;
      addLog(`  ${sheetCount} sheets, ${available.length} calculators available (${step1.execution_ms}ms)`);
      setPhase('profiled');
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
      setError(err.message);
      setPhase('error');
    }
  }, [sheets, addLog]);

  // Steps 2+3: LLM mapping → deterministic calculate
  const runCalculate = useCallback(async () => {
    if (!sheets || !profilePrompts) return;
    setPhase('calculating');
    setError(null);
    setKpiResult(null);
    const start = Date.now();

    try {
      // Re-fetch prompts with selected calculators filter
      const selected = [...selectedCalcs];
      addLog(`Step 2: AI mapping ${selected.length} calculators...`);

      const filteredProfile = await post('/kpi/profile', {
        tool_hint: 'kpi-profile',
        input_data: { sheets, selected_calculators: selected },
      });

      const llmResult = await callLLM({
        taskType: 'task_decomposition',
        systemPrompt: filteredProfile.prompts.system,
        prompt: filteredProfile.prompts.user,
        temperature: 0.1,
        maxTokens: 4000,
        jsonMode: false,
        modelOverride: { provider: 'deepseek', model_name: 'deepseek-chat' },
      });

      let kpiConfig;
      const rawText = (llmResult.text || '').trim();
      try {
        const s = rawText.indexOf('{');
        const e = rawText.lastIndexOf('}');
        kpiConfig = JSON.parse(s !== -1 && e !== -1 ? rawText.slice(s, e + 1) : rawText);
      } catch {
        addLog('  ERROR: LLM did not return valid JSON');
        throw new Error('LLM did not return valid JSON config');
      }

      const calcCount = (kpiConfig.calculations || []).length;
      addLog(`  ${calcCount} calculator configs returned`);
      for (const c of (kpiConfig.calculations || []).slice(0, 8)) {
        addLog(`    ${c.calculator}: ${c.label || ''}`);
      }

      // Step 3: Calculate
      addLog('Step 3: Executing deterministic calculations...');
      const step3 = await post('/kpi/calculate', {
        tool_hint: 'kpi-calculate',
        input_data: { sheets, kpi_config: kpiConfig },
      });

      const artCount = (step3.artifacts || []).length;
      addLog(`  ${artCount} KPI tables generated (${step3.execution_ms}ms)`);

      for (const entry of (step3.log || [])) {
        if (entry.action === 'error') {
          addLog(`  ERROR ${entry.calculator}: ${entry.error}`);
        }
      }

      setKpiResult(step3);
      setKpiDuration(Date.now() - start);
      const firstArt = (step3.artifacts || []).find(a => a.type === 'table' && Array.isArray(a.data));
      setActiveKpiSheet(firstArt?.label || '');
      setPhase('complete');

    } catch (err) {
      addLog(`ERROR: ${err.message}`);
      setError(err.message);
      setPhase('error');
    }
  }, [sheets, profilePrompts, selectedCalcs, addLog]);

  const handleReset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setSheets(null);
    setSheetNames([]);
    setActiveSheet('');
    setFileName('');
    setFileSize(0);
    setKpiResult(null);
    setKpiDuration(0);
    setActiveKpiSheet('');
    setProfile(null);
    setSuggestions([]);
    setSelectedCalcs(new Set());
    setProfilePrompts(null);
    setLiveLog([]);
  }, []);

  // ── Derived data ─────────────────────────────────────────────────────────

  const currentSheetData = sheets?.[activeSheet] || [];
  const columns = currentSheetData.length > 0 ? Object.keys(currentSheetData[0]) : [];
  const previewRows = currentSheetData.slice(0, 20);
  const totalRows = sheetNames.reduce((sum, name) => sum + (sheets?.[name]?.length || 0), 0);

  const kpiTables = (kpiResult?.artifacts || []).filter(a => a.type === 'table' && Array.isArray(a.data) && a.data.length > 0);
  const activeKpiData = kpiTables.find(t => t.label === activeKpiSheet)?.data || [];
  const activeKpiCols = activeKpiData.length > 0 && typeof activeKpiData[0] === 'object' ? Object.keys(activeKpiData[0]) : [];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-primary)] flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">KPI Lab</h1>
          <p className="text-xs text-[var(--text-secondary)]">Upload Excel &rarr; AI maps columns &rarr; Deterministic KPI engine</p>
        </div>
        {phase !== 'idle' && (
          <button onClick={handleReset}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
              text-[var(--text-secondary)] hover:text-[var(--text-primary)]
              hover:bg-[var(--bg-secondary)] transition-colors">
            <RotateCcw size={14} /> Start Over
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Panel */}
        <div className="w-80 flex-shrink-0 border-r border-[var(--border-primary)] p-4 flex flex-col gap-4 overflow-y-auto">

          {/* Drop Zone */}
          {(phase === 'idle' || (phase === 'error' && !sheets)) && (
            <div onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[var(--border-primary)] rounded-xl p-8
                text-center cursor-pointer transition-colors
                hover:border-blue-500 hover:bg-blue-500/5">
              <Upload size={28} className="mx-auto mb-2 text-[var(--text-tertiary)]" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Drop Excel or CSV</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">max {MAX_FILE_SIZE_MB} MB</p>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileDrop} />
            </div>
          )}

          {phase === 'idle' && (
            <button onClick={handleLoadSample}
              className="w-full flex items-center justify-center gap-2 px-3 py-2
                rounded-lg border border-[var(--border-primary)] text-xs
                text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                hover:bg-[var(--bg-secondary)] transition-colors">
              <FileSpreadsheet size={14} /> Load Sample Data
            </button>
          )}

          {phase === 'uploading' && (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={20} className="animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-[var(--text-secondary)]">Parsing...</span>
            </div>
          )}

          {/* File info + actions */}
          {sheets && phase !== 'idle' && phase !== 'uploading' && (
            <>
              <div className="rounded-lg border border-[var(--border-primary)] p-3 bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2 min-w-0">
                  <FileSpreadsheet size={14} className="text-blue-500 flex-shrink-0" />
                  <span className="text-xs font-medium text-[var(--text-primary)] truncate">{fileName}</span>
                </div>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  {sheetNames.length} sheet{sheetNames.length > 1 ? 's' : ''} &middot; {totalRows.toLocaleString()} rows &middot; {formatBytes(fileSize)}
                </p>
              </div>

              {/* Step 1: Profile button */}
              {phase === 'previewing' && (
                <button onClick={runProfile}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                    rounded-lg bg-blue-600 text-white text-sm font-medium
                    hover:bg-blue-700 transition-colors">
                  <BarChart3 size={16} /> Analyze Data
                </button>
              )}

              {/* Calculator selection checklist */}
              {phase === 'profiled' && suggestions.length > 0 && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-3">
                  <p className="text-xs font-medium text-blue-600">Select KPIs to calculate:</p>
                  <div className="space-y-1.5">
                    {suggestions.map((s) => (
                      <label key={s.name}
                        className={`flex items-start gap-2 p-1.5 rounded cursor-pointer transition-colors ${
                          s.available ? 'hover:bg-blue-500/10' : 'opacity-40 cursor-not-allowed'
                        }`}>
                        <input
                          type="checkbox"
                          checked={selectedCalcs.has(s.name)}
                          disabled={!s.available}
                          onChange={(e) => {
                            setSelectedCalcs(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(s.name);
                              else next.delete(s.name);
                              return next;
                            });
                          }}
                          className="mt-0.5 rounded border-[var(--border-primary)]"
                        />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-[var(--text-primary)]">{s.name}</p>
                          <p className="text-[10px] text-[var(--text-tertiary)]">{s.description}</p>
                          {!s.available && (
                            <p className="text-[10px] text-amber-600">{s.reason}</p>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedCalcs(new Set(suggestions.filter(s => s.available).map(s => s.name)))}
                      className="text-[10px] text-blue-600 hover:underline">Select All</button>
                    <button
                      onClick={() => setSelectedCalcs(new Set())}
                      className="text-[10px] text-[var(--text-tertiary)] hover:underline">Clear All</button>
                  </div>
                  <button onClick={runCalculate}
                    disabled={selectedCalcs.size === 0}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                      rounded-lg bg-blue-600 text-white text-sm font-medium
                      hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    <BarChart3 size={16} /> Calculate {selectedCalcs.size} KPI{selectedCalcs.size !== 1 ? 's' : ''}
                  </button>
                </div>
              )}

              {/* Progress */}
              {phase === 'calculating' && (
                <KpiProgress liveLog={liveLog} />
              )}

              {/* Results summary */}
              {phase === 'complete' && kpiResult && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle size={14} className="text-emerald-500 flex-shrink-0" />
                      <span className="text-xs font-medium text-emerald-600">
                        {kpiTables.length} KPI tables ({(kpiDuration / 1000).toFixed(1)}s)
                      </span>
                    </div>
                  </div>

                  {/* KPI summary values */}
                  {kpiResult.result && Object.keys(kpiResult.result).length > 0 && (
                    <div className="grid grid-cols-2 gap-1.5">
                      {Object.entries(kpiResult.result).map(([k, v]) => (
                        <div key={k} className="rounded bg-[var(--bg-secondary)] px-2 py-1">
                          <p className="text-[10px] text-[var(--text-tertiary)] truncate">{k.replace(/_/g, ' ')}</p>
                          <p className="text-xs font-medium text-[var(--text-primary)]">
                            {typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
                              : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button onClick={() => downloadExcel(kpiTables, fileName.replace(/\.\w+$/, '') + '_kpi.xlsx')}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2
                        rounded-lg bg-emerald-600 text-white text-xs font-medium
                        hover:bg-emerald-700 transition-colors">
                      <Download size={14} /> Download KPI Excel
                    </button>
                  </div>

                  <button onClick={() => setPhase('profiled')}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5
                      rounded-lg text-xs text-[var(--text-tertiary)]
                      hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-colors">
                    <RotateCcw size={12} /> Change selection & re-calculate
                  </button>

                  {/* Log */}
                  {liveLog.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                        Execution log ({liveLog.length} entries)
                      </summary>
                      <div className="mt-2 max-h-48 overflow-y-auto space-y-0.5 border-t border-[var(--border-primary)] pt-2">
                        {liveLog.map((entry, i) => (
                          <p key={i} className={`text-[11px] leading-relaxed font-mono ${
                            entry.msg.startsWith('ERROR') ? 'text-red-500 font-medium' :
                            entry.msg.startsWith('  ') ? 'text-[var(--text-tertiary)]' :
                            'text-[var(--text-secondary)]'
                          }`}>{entry.msg}</p>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-600 break-words">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Right Panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {phase === 'idle' || phase === 'uploading' ? (
            <div className="flex-1 flex items-center justify-center text-[var(--text-tertiary)]">
              <div className="text-center">
                <BarChart3 size={40} className="mx-auto mb-2 opacity-30" />
                <p className="text-xs">Upload a file to calculate KPIs</p>
              </div>
            </div>
          ) : (
            <>
              {/* Toolbar: Raw / KPI toggle + tabs */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-primary)] flex-shrink-0 overflow-x-auto">
                {kpiTables.length > 0 && (
                  <div className="flex rounded-md border border-[var(--border-primary)] overflow-hidden flex-shrink-0">
                    <button onClick={() => setActiveKpiSheet('')}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        !activeKpiSheet
                          ? 'bg-[var(--brand-500)]/10 text-[var(--brand-600)]'
                          : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      Raw Data
                    </button>
                    <button onClick={() => {
                      const first = kpiTables[0]?.label || '';
                      setActiveKpiSheet(first);
                    }}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        activeKpiSheet
                          ? 'bg-blue-500/10 text-blue-600'
                          : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      KPI Results
                    </button>
                  </div>
                )}

                {/* Tabs */}
                {!activeKpiSheet ? (
                  sheetNames.length > 1 && sheetNames.map((name) => (
                    <button key={name} onClick={() => setActiveSheet(name)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                        name === activeSheet
                          ? 'bg-[var(--brand-500)]/10 text-[var(--brand-600)]'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                      {name} ({sheets[name]?.length || 0})
                    </button>
                  ))
                ) : (
                  kpiTables.map((t, idx) => (
                    <button key={`${t.label}-${idx}`} onClick={() => setActiveKpiSheet(t.label)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                        t.label === activeKpiSheet
                          ? 'bg-blue-500/10 text-blue-600'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                      {t.label} ({t.data.length})
                    </button>
                  ))
                )}
              </div>

              {/* Data table */}
              <div className="flex-1 overflow-auto p-4">
                {!activeKpiSheet ? (
                  columns.length > 0 ? (
                    <DataTable columns={columns} rows={previewRows} totalRows={currentSheetData.length} />
                  ) : (
                    <p className="text-xs text-[var(--text-tertiary)]">This sheet is empty.</p>
                  )
                ) : (
                  activeKpiCols.length > 0 ? (
                    <DataTable columns={activeKpiCols} rows={activeKpiData.slice(0, 100)} totalRows={activeKpiData.length} />
                  ) : (
                    <p className="text-xs text-[var(--text-tertiary)]">Select a KPI table from the tabs above.</p>
                  )
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Progress with live log + timer ──────────────────────────────────────────

function KpiProgress({ liveLog }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="text-blue-500 animate-spin" />
          <span className="text-xs font-medium text-blue-600">Calculating KPIs...</span>
        </div>
        <span className="text-xs font-mono text-[var(--text-tertiary)] tabular-nums">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </span>
      </div>

      {/* Step indicators */}
      <div className="flex gap-2">
        {[
          { id: 'profile', label: 'Profile', icon: '1' },
          { id: 'mapping', label: 'AI Map', icon: '2' },
          { id: 'calculate', label: 'Calculate', icon: '3' },
        ].map((s) => {
          const logText = liveLog.map(l => l.msg).join(' ');
          const isDone =
            (s.id === 'profile' && logText.includes('Step 2')) ||
            (s.id === 'mapping' && logText.includes('Step 3')) ||
            (s.id === 'calculate' && logText.includes('tables generated'));
          const isActive =
            (s.id === 'profile' && logText.includes('Step 1') && !logText.includes('Step 2')) ||
            (s.id === 'mapping' && logText.includes('Step 2') && !logText.includes('Step 3')) ||
            (s.id === 'calculate' && logText.includes('Step 3') && !logText.includes('tables generated'));
          return (
            <div key={s.id} className="flex-1">
              <div className={`flex items-center gap-1.5 mb-1 ${
                isActive ? 'text-blue-600' : isDone ? 'text-emerald-600' : 'text-[var(--text-tertiary)]'
              }`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  isDone ? 'bg-emerald-500 text-white' :
                  isActive ? 'bg-blue-500 text-white' :
                  'bg-[var(--border-primary)] text-[var(--text-tertiary)]'
                }`}>
                  {isDone ? '\u2713' : s.icon}
                </div>
                <span className="text-[10px] font-medium">{s.label}</span>
              </div>
              <div className={`h-1 rounded-full ${
                isDone ? 'bg-emerald-500' :
                isActive ? 'bg-blue-500 animate-pulse' :
                'bg-[var(--border-primary)]'
              }`} />
            </div>
          );
        })}
      </div>

      {/* Live log */}
      {liveLog.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-[var(--border-primary)] pt-2 space-y-0.5">
          {liveLog.map((entry, i) => (
            <p key={i} className={`text-[11px] leading-relaxed font-mono ${
              entry.msg.startsWith('ERROR') ? 'text-red-500 font-medium' :
              entry.msg.startsWith('  ') ? 'text-[var(--text-tertiary)]' :
              'text-[var(--text-secondary)]'
            }`}>{entry.msg}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reusable data table ─────────────────────────────────────────────────────

function DataTable({ columns, rows, totalRows }) {
  return (
    <div className="border border-[var(--border-primary)] rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr className="bg-[var(--bg-secondary)]">
              <th className="px-2 py-1.5 text-left font-medium text-[var(--text-tertiary)] border-b border-[var(--border-primary)] w-8 sticky left-0 bg-[var(--bg-secondary)]">#</th>
              {columns.map((col) => (
                <th key={col} className="px-2 py-1.5 text-left font-medium text-[var(--text-secondary)] border-b border-[var(--border-primary)] whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border-primary)] last:border-b-0 hover:bg-[var(--bg-secondary)]/50">
                <td className="px-2 py-1 text-[var(--text-tertiary)] sticky left-0 bg-[var(--bg-primary)]">{i + 1}</td>
                {columns.map((col) => (
                  <td key={col} className="px-2 py-1 text-[var(--text-primary)] whitespace-nowrap max-w-[200px] truncate">
                    {row[col] !== null && row[col] !== undefined
                      ? (typeof row[col] === 'number'
                        ? row[col].toLocaleString(undefined, { maximumFractionDigits: 2 })
                        : String(row[col]))
                      : ''}
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
