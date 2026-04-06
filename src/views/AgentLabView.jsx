/**
 * AgentLabView — General Agent test page.
 * Upload Excel + type a question → Agent selects tools → executes → synthesizes narrative.
 *
 * Uses POST /agent/general/stream (SSE) for real-time progress.
 */

import { useState, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, Loader2, CheckCircle, AlertCircle, Play, Download, Brain,
  Wrench, FileSpreadsheet, MessageSquare, Clock,
} from 'lucide-react';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Main View ───────────────────────────────────────────────────────────────

export default function AgentLabView() {
  const [phase, setPhase] = useState('idle'); // idle | uploading | ready | running | done | error
  const [error, setError] = useState(null);

  // File state
  const [sheets, setSheets] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [fileName, setFileName] = useState('');
  const [totalRows, setTotalRows] = useState(0);

  // Query
  const [query, setQuery] = useState('Analyze this data and find issues');

  // Agent state
  const [steps, setSteps] = useState([]);
  const [selectedTools, setSelectedTools] = useState([]);
  const [columnMappings, setColumnMappings] = useState([]);
  const [kpiAudit, setKpiAudit] = useState(null);
  const [reasoning, setReasoning] = useState('');
  const [narrative, setNarrative] = useState('');
  const [totalDuration, setTotalDuration] = useState(0);
  const [artifactCount, setArtifactCount] = useState(0);
  const [downloadId, setDownloadId] = useState(null);

  // JS Tool Verification
  const [verifyResults, setVerifyResults] = useState(null);
  const [verifyRunning, setVerifyRunning] = useState(false);

  const runJsToolVerification = useCallback(async () => {
    setVerifyRunning(true);
    setVerifyResults(null);
    try {
      const { verifyJsTools } = await import('../services/agent-core/jsToolVerifier.js');
      const results = await verifyJsTools();
      setVerifyResults(results);
    } catch (err) {
      setVerifyResults({ error: err.message, passed: 0, failed: 0, total: 0, results: [] });
    }
    setVerifyRunning(false);
  }, []);

  const fileRef = useRef(null);

  // ── File Upload ──────────────────────────────────────────────────────────

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPhase('uploading');
    setError(null);
    setSteps([]);
    setNarrative('');
    setSelectedTools([]);

    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });

      const parsed = {};
      let rows = 0;
      for (const sn of wb.SheetNames) {
        const ws = wb.Sheets[sn];
        const json = XLSX.utils.sheet_to_json(ws, { defval: null });
        parsed[sn] = json;
        rows += json.length;
      }

      setSheets(parsed);
      setSheetNames(wb.SheetNames);
      setFileName(file.name);
      setTotalRows(rows);
      setPhase('ready');
    } catch (err) {
      setError(`Failed to parse Excel: ${err.message}`);
      setPhase('error');
    }
  }, []);

  // ── Run Agent ────────────────────────────────────────────────────────────

  const runAgent = useCallback(async () => {
    if (!sheets || !query.trim()) return;

    setPhase('running');
    setError(null);
    setSteps([]);
    setNarrative('');
    setSelectedTools([]);
    setColumnMappings([]);
    setKpiAudit(null);
    setReasoning('');
    setDownloadId(null);
    setArtifactCount(0);

    try {
      const resp = await fetch(`${ML_API}/agent/general/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), sheets }),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }

          switch (evt.type) {
            case 'plan_done':
              setSelectedTools(evt.tools || []);
              setReasoning(evt.reasoning || '');
              break;

            case 'format_rejected':
              setSteps([{
                tool: 'format_validation',
                status: 'error',
                finding: (evt.issues || []).map(i => i.detail).join('; '),
              }]);
              break;

            case 'column_mapping':
              setColumnMappings(evt.mappings || []);
              break;

            case 'kpi_audit':
              setKpiAudit(evt);
              break;

            case 'tool_start':
              setSteps(prev => [...prev, {
                tool: evt.tool_id,
                status: 'running',
                index: evt.step_index,
                total: evt.total_steps,
              }]);
              break;

            case 'tool_finding':
              setSteps(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last) last.finding = evt.finding;
                return copy;
              });
              break;

            case 'tool_done':
              setSteps(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last) {
                  last.status = 'done';
                  last.duration_ms = evt.duration_ms;
                }
                return copy;
              });
              break;

            case 'tool_error':
              setSteps(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last) {
                  last.status = 'error';
                  last.error = evt.error;
                  last.duration_ms = evt.duration_ms;
                }
                return copy;
              });
              break;

            case 'synthesize_chunk':
              setNarrative(prev => prev + (evt.text || ''));
              break;

            case 'agent_done': {
              const r = evt.result || {};
              setTotalDuration(r.total_duration_ms || 0);
              setArtifactCount(r.artifact_count || 0);
              // Update steps with full summaries from server
              if (r.steps_log?.length) {
                setSteps(prev => {
                  const updated = [...prev];
                  for (const sl of r.steps_log) {
                    const match = updated.find(s => s.tool === sl.tool);
                    if (match && sl.summary) match.fullSummary = sl.summary;
                  }
                  return updated;
                });
              }
              break;
            }

            case 'artifacts_ready':
              setDownloadId(evt.download_id);
              setArtifactCount(evt.count || 0);
              break;

            case 'error':
              setError(evt.message);
              setPhase('error');
              return;
          }
        }
      }

      setPhase('done');
    } catch (err) {
      setError(`Agent failed: ${err.message}`);
      setPhase('error');
    }
  }, [sheets, query]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Brain className="w-8 h-8 text-purple-500" />
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">General Agent Lab</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Upload Excel + ask a question → Agent selects tools → executes → synthesizes
          </p>
        </div>
      </div>

      {/* JS Tool Verification */}
      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-secondary)]">JS Tool Verification</h2>
            <p className="text-xs text-[var(--text-secondary)] opacity-60">Test 9 core JS tools with sample data</p>
          </div>
          <button
            onClick={runJsToolVerification}
            disabled={verifyRunning}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg text-sm font-medium flex items-center gap-2"
          >
            {verifyRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
            {verifyRunning ? 'Running...' : 'Verify Tools'}
          </button>
        </div>
        {verifyResults && (
          <div className="mt-3 space-y-1">
            <div className="text-sm font-medium text-[var(--text-primary)]">
              {verifyResults.passed} passed / {verifyResults.failed} failed / {verifyResults.skipped || 0} skipped
            </div>
            {verifyResults.error && (
              <div className="text-xs text-red-400">{verifyResults.error}</div>
            )}
            {(verifyResults.results || []).map((r, i) => (
              <div key={i} className="border-b border-[var(--border-primary)] pb-1 last:border-0">
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span>{r.pass === true ? '✅' : r.pass === false ? '❌' : '⏭️'}</span>
                  <span className="text-[var(--text-primary)]">{r.id}</span>
                  <span className="text-[var(--text-secondary)]">({r.ms}ms)</span>
                  {r.error && <span className="text-red-400 truncate max-w-md">{r.error}</span>}
                </div>
                {r.sampleOutput && (
                  <details className="ml-6 mt-1">
                    <summary className="text-xs text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]">
                      Show output ({r.sampleOutput.reduce((a, s) => a + (s.rows || 0), 0)} rows)
                    </summary>
                    <div className="mt-1 space-y-2">
                      {r.sampleOutput.map((table, ti) => (
                        <div key={ti}>
                          <div className="text-xs text-purple-300 mb-1">{table.label} ({table.rows} rows)</div>
                          <div className="overflow-x-auto max-h-40">
                            {Array.isArray(table.preview) && table.preview.length > 0 && typeof table.preview[0] === 'object' ? (
                              <table className="text-xs border-collapse w-full">
                                <thead>
                                  <tr>
                                    {Object.keys(table.preview[0]).slice(0, 8).map(k => (
                                      <th key={k} className="px-2 py-1 text-left border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">{k}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {table.preview.slice(0, 5).map((row, ri) => (
                                    <tr key={ri}>
                                      {Object.keys(table.preview[0]).slice(0, 8).map(k => (
                                        <td key={k} className="px-2 py-0.5 border border-[var(--border-primary)] text-[var(--text-primary)]">
                                          {typeof row[k] === 'number' ? row[k].toLocaleString() : String(row[k] ?? '')}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <pre className="p-2 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)] text-xs whitespace-pre-wrap">
                                {JSON.stringify(table.preview, null, 2).slice(0, 500)}
                              </pre>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
            {verifyResults.passed > 0 && (
              <button
                onClick={() => {
                  const data = JSON.stringify(verifyResults, null, 2);
                  const blob = new Blob([data], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = 'js_tool_verification.json'; a.click();
                  URL.revokeObjectURL(url);
                }}
                className="mt-2 px-3 py-1.5 bg-[var(--bg-primary)] hover:bg-[var(--border-primary)] text-[var(--text-secondary)] rounded text-xs flex items-center gap-1.5 border border-[var(--border-primary)]"
              >
                <Download className="w-3 h-3" /> Download Results (JSON)
              </button>
            )}
          </div>
        )}
      </div>

      {/* Upload + Query */}
      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5 space-y-4">
        {/* File upload */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
            1. Upload Excel File
          </label>
          <div
            className="border-2 border-dashed border-[var(--border-primary)] rounded-lg p-6 text-center cursor-pointer hover:border-purple-400 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
            {fileName ? (
              <div className="flex items-center justify-center gap-2 text-[var(--text-primary)]">
                <FileSpreadsheet className="w-5 h-5 text-green-500" />
                <span className="font-medium">{fileName}</span>
                <span className="text-[var(--text-secondary)]">— {sheetNames.length} sheets, {totalRows} rows</span>
              </div>
            ) : (
              <div className="text-[var(--text-secondary)]">
                <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                Click to upload .xlsx / .xls / .csv
              </div>
            )}
          </div>
        </div>

        {/* Query input */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
            2. What do you want to analyze?
          </label>
          <div className="flex gap-3">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. Analyze this MBR data and find issues"
              className="flex-1 px-4 py-2.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              onKeyDown={e => e.key === 'Enter' && phase === 'ready' && runAgent()}
            />
            <button
              onClick={runAgent}
              disabled={phase !== 'ready' && phase !== 'done'}
              className="px-6 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-medium flex items-center gap-2 transition-colors"
            >
              {phase === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run Agent
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Tool Selection */}
      {selectedTools.length > 0 && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5">
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3 flex items-center gap-2">
            <Wrench className="w-4 h-4" /> Tools Selected (LLM Call #1)
          </h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {selectedTools.map(t => (
              <span key={t} className="px-3 py-1 rounded-full text-xs font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30">
                {t}
              </span>
            ))}
          </div>
          {reasoning && (
            <p className="text-xs text-[var(--text-secondary)] italic">{reasoning}</p>
          )}
        </div>
      )}

      {/* Column Mapping (audit trail — clickable to override) */}
      {columnMappings.length > 0 && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5">
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3 flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4" /> Column Mapping
            <span className="text-xs font-normal opacity-60 ml-1">
              (click a mapping to override — re-run to apply)
            </span>
          </h2>
          <div className="font-mono text-xs space-y-1 text-[var(--text-secondary)]">
            {columnMappings.map((m, i) => {
              const isRevenue = m.includes('revenue') || m.includes('cost');
              return (
                <div
                  key={i}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer hover:bg-[var(--bg-primary)] transition-colors ${isRevenue ? 'text-yellow-300' : ''}`}
                  onClick={async () => {
                    // Parse "  ColName → role" format
                    const parts = m.trim().split('→');
                    if (parts.length !== 2) return;
                    const col = parts[0].trim();
                    const currentRole = parts[1].trim();
                    const newRole = prompt(`Override mapping for "${col}"\nCurrent: ${currentRole}\n\nEnter new role (revenue, cost, category, date, quantity, __ignore__) or cancel:`);
                    if (!newRole) return;
                    try {
                      await fetch(`${ML_API}/rules/user/column`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sheet: 'Sheet1', column: col, role: newRole }),
                      });
                      alert(`Saved: "${col}" → ${newRole}\nRe-run the agent to apply.`);
                    } catch (err) {
                      alert(`Failed to save: ${err.message}`);
                    }
                  }}
                >
                  {m}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Execution Steps */}
      {steps.length > 0 && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5">
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3 flex items-center gap-2">
            <Wrench className="w-4 h-4" /> Execution (Deterministic)
          </h2>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <div className="mt-0.5">
                  {s.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
                  {s.status === 'done' && <CheckCircle className="w-4 h-4 text-green-400" />}
                  {s.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[var(--text-primary)]">{s.tool}</span>
                    {s.duration_ms != null && (
                      <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {formatMs(s.duration_ms)}
                      </span>
                    )}
                  </div>
                  {s.finding && (
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{s.finding}</p>
                  )}
                  {s.fullSummary && s.fullSummary.length > 60 && (
                    <details className="mt-1">
                      <summary className="text-xs text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]">
                        Show full output
                      </summary>
                      <pre className="mt-1 p-2 rounded bg-[var(--bg-primary)] text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {s.fullSummary}
                      </pre>
                    </details>
                  )}
                  {s.error && (
                    <p className="text-xs text-red-400 mt-0.5">{s.error}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI Audit Trail */}
      {kpiAudit && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5">
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3 flex items-center gap-2">
            <Brain className="w-4 h-4" /> KPI Calculation Audit
          </h2>
          <div className="space-y-3">
            <div>
              <span className="text-xs text-[var(--text-secondary)]">Method: </span>
              <span className="text-xs font-mono text-purple-300">{kpiAudit.method}</span>
            </div>
            {kpiAudit.reasoning && (
              <div>
                <span className="text-xs text-[var(--text-secondary)]">Reasoning: </span>
                <span className="text-xs text-[var(--text-primary)]">{kpiAudit.reasoning}</span>
              </div>
            )}
            {kpiAudit.derivations?.length > 0 && (
              <div>
                <span className="text-xs text-[var(--text-secondary)]">Derivations: </span>
                <span className="text-xs text-yellow-300">{kpiAudit.derivations.join(', ')}</span>
              </div>
            )}
            {kpiAudit.code && (
              <details className="text-xs">
                <summary className="text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]">
                  Show generated code
                </summary>
                <pre className="mt-2 p-3 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)] font-mono overflow-x-auto whitespace-pre-wrap">
                  {kpiAudit.code}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}

      {/* Narrative */}
      {narrative && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5">
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3 flex items-center gap-2">
            <MessageSquare className="w-4 h-4" /> Executive Summary (LLM Call #2)
          </h2>
          <div className="prose prose-invert prose-sm max-w-none text-[var(--text-primary)] whitespace-pre-wrap">
            {narrative}
          </div>
        </div>
      )}

      {/* Summary bar */}
      {phase === 'done' && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4 flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm text-green-300">
            <CheckCircle className="w-5 h-5" />
            <span>Done in {formatMs(totalDuration)}</span>
            <span>•</span>
            <span>{steps.length} tools executed</span>
            <span>•</span>
            <span>{artifactCount} artifacts</span>
          </div>
          {downloadId && (
            <a
              href={`${ML_API}/agent/mbr/download/${downloadId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
            >
              <Download className="w-4 h-4" /> Download Excel ({artifactCount} tables)
            </a>
          )}
        </div>
      )}
    </div>
  );
}
