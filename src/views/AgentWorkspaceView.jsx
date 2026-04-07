/**
 * AgentWorkspaceView — Production-ready Agent workspace.
 *
 * Upload data → Agent auto-analyzes → Chat for Q&A
 * Designed to feel like a product, not a prototype.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, Loader2, CheckCircle, AlertCircle, FileSpreadsheet,
  Brain, Clock, Download, Send, ChevronDown, ChevronRight,
  Sparkles, ArrowRight, RotateCcw, Eye, EyeOff,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';

// Agent thinking card sub-component (needs its own state for expand/collapse)
const AGENT_CONFIG = {
  tool_selection: { icon: '🧠', label: 'Lead Analyst', color: '#c084fc', bg: 'rgba(168,85,247,0.15)' },
  kpi_calculation: { icon: '📊', label: 'KPI Engine', color: '#93c5fd', bg: 'rgba(59,130,246,0.15)' },
  financial_analysis: { icon: '💰', label: 'Financial Analyst', color: '#4ade80', bg: 'rgba(34,197,94,0.15)' },
  operations_analysis: { icon: '⚙️', label: 'Operations Analyst', color: '#fb923c', bg: 'rgba(249,115,22,0.15)' },
  risk_analysis: { icon: '⚠️', label: 'Risk Analyst', color: '#f87171', bg: 'rgba(239,68,68,0.15)' },
  reviewer: { icon: '🔍', label: 'Reviewer', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)' },
};

function AgentThinkingCard({ trace, index, isLast }) {
  const [expanded, setExpanded] = useState(isLast);
  const config = AGENT_CONFIG[trace.phase] || { icon: '💬', label: trace.phase, color: '#9ca3af', bg: 'rgba(107,114,128,0.15)' };
  return (
    <div className="relative pb-4 last:pb-0" style={{ animation: `fadeSlideIn 0.3s ease-out ${index * 0.1}s both` }}>
      <div className="absolute -left-3 w-6 h-6 rounded-full flex items-center justify-center text-xs border-2"
           style={{ borderColor: config.color, backgroundColor: config.bg, top: '2px' }}>
        {config.icon}
      </div>
      <div className="ml-5 rounded-lg border overflow-hidden cursor-pointer transition-colors"
           style={{ borderColor: 'var(--border-default)' }}
           onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2 px-3 py-2" style={{ backgroundColor: config.bg }}>
          <span className="text-xs font-semibold" style={{ color: config.color }}>{config.label}</span>
          {trace.model && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  style={{ backgroundColor: 'rgba(0,0,0,0.4)', color: 'rgba(255,255,255,0.7)' }}>
              {trace.model}
            </span>
          )}
          <ChevronDown className={`w-3 h-3 ml-auto transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} style={{ color: config.color }} />
        </div>
        {expanded && (
          <div className="px-3 py-2 text-sm text-[var(--text-secondary)] leading-relaxed prose prose-invert prose-sm max-w-none" style={{ backgroundColor: 'var(--surface-base)' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{trace.thinking}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Human-readable tool names
const TOOL_LABELS = {
  run_mbr_cleaning: 'Data Cleaning',
  run_mbr_kpi: 'KPI Calculation',
  run_mbr_variance: 'Variance Analysis',
  run_mbr_anomaly: 'Anomaly Detection',
  run_eda: 'Exploratory Analysis',
  run_regression: 'Regression Analysis',
  run_auto_insights: 'Pattern Discovery',
  run_anomaly_detection: 'Anomaly Detection',
  data_cleaning: 'Data Cleaning',
  kpi_calculation: 'KPI Calculation',
  variance_analysis: 'Variance Analysis',
  anomaly_detection: 'Anomaly Detection',
  eda: 'Exploratory Analysis',
  regression: 'Regression Analysis',
  format_validation: 'Format Check',
};

function toolLabel(id) {
  return TOOL_LABELS[id] || id.replace(/^run_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function AgentWorkspaceView() {
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);

  // Data
  const [sheets, setSheets] = useState(null);
  const [fileName, setFileName] = useState('');
  const [sheetNames, setSheetNames] = useState([]);
  const [totalRows, setTotalRows] = useState(0);

  // Agent
  const [tools, setTools] = useState([]);
  const [reasoning, setReasoning] = useState('');
  const [thinkingTraces, setThinkingTraces] = useState([]);
  const [agentStatuses, setAgentStatuses] = useState({}); // {phase: 'running'|'done'}
  const [steps, setSteps] = useState([]);
  const [narrative, setNarrative] = useState('');
  const [totalDuration, setTotalDuration] = useState(0);
  const [artifactCount, setArtifactCount] = useState(0);
  const [downloadId, setDownloadId] = useState(null);
  const [kpiAudit, setKpiAudit] = useState(null);
  const [columnMappings, setColumnMappings] = useState([]);

  // Model selection
  const [selectedModel, setSelectedModel] = useState('auto');
  const MODEL_OPTIONS = [
    { value: 'auto', label: 'Auto (GPT-5.4 + DeepSeek)', desc: 'Default' },
    { value: 'kimi', label: 'Kimi K2.5', desc: 'Moonshot' },
    { value: 'openai', label: 'GPT-5.4', desc: 'OpenAI' },
    { value: 'deepseek', label: 'DeepSeek', desc: 'DeepSeek' },
    { value: 'anthropic', label: 'Claude Sonnet', desc: 'Anthropic' },
  ];

  // Chat
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [expandedSteps, setExpandedSteps] = useState(new Set());
  const [showEvidence, setShowEvidence] = useState(false);

  const fileRef = useRef(null);
  const scrollRef = useRef(null);

  // Auto-scroll to bottom when new content appears
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps, narrative, chatMessages]);

  // ── File Upload ──
  const handleFile = useCallback(async (e) => {
    const file = e.target?.files?.[0] || e;
    if (!file) return;
    setError(null);
    try {
      const data = await (file.arrayBuffer ? file.arrayBuffer() : Promise.resolve(file));
      const wb = XLSX.read(data, { type: 'array' });
      const parsed = {};
      let rows = 0;
      for (const sn of wb.SheetNames) {
        const json = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
        parsed[sn] = json;
        rows += json.length;
      }
      setSheets(parsed);
      setSheetNames(wb.SheetNames);
      setFileName(file.name);
      setTotalRows(rows);
      setPhase('ready');
      // Don't auto-run — let user type a query first
    } catch (err) {
      setError(`Unable to read file: ${err.message}`);
      setPhase('error');
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-[var(--brand-500)]');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile({ target: { files: [file] } });
  }, [handleFile]);

  // ── Run Agent ──
  const runAgent = useCallback(async (sheetsData, query) => {
    setPhase('running');
    setError(null);
    setSteps([]);
    setTools([]);
    setReasoning('');
    setThinkingTraces([]);
    setAgentStatuses({});
    setNarrative('');
    setKpiAudit(null);
    setColumnMappings([]);
    setDownloadId(null);
    setArtifactCount(0);
    setExpandedSteps(new Set());

    try {
      const resp = await fetch(`${ML_API}/agent/general/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          sheets: sheetsData || sheets,
          ...(selectedModel !== 'auto' ? {
            llm_config: {
              provider: selectedModel,
              model: selectedModel === 'kimi' ? 'kimi-k2.5'
                   : selectedModel === 'openai' ? 'gpt-5.4'
                   : selectedModel === 'deepseek' ? 'deepseek-chat'
                   : selectedModel === 'anthropic' ? 'claude-sonnet-4-6'
                   : undefined,
            },
          } : {}),
        }),
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
          let evt;
          try { evt = JSON.parse(line.slice(6).trim()); } catch { continue; }

          switch (evt.type) {
            case 'agent_status':
              setAgentStatuses(prev => ({ ...prev, [evt.phase]: evt.status }));
              break;
            case 'agent_thinking':
              setThinkingTraces(prev => [...prev, {
                phase: evt.phase || 'general',
                thinking: evt.thinking || '',
                model: evt.model || '',
              }]);
              break;
            case 'plan_done':
              setTools(evt.tools || []);
              setReasoning(evt.reasoning || '');
              break;
            case 'tool_start':
              setSteps(prev => [...prev, { tool: evt.tool_id, status: 'running', index: evt.step_index, total: evt.total_steps }]);
              break;
            case 'tool_finding':
              setSteps(prev => { const c = [...prev]; const l = c[c.length - 1]; if (l) l.finding = evt.finding; return c; });
              break;
            case 'tool_done':
              setSteps(prev => { const c = [...prev]; const l = c[c.length - 1]; if (l) { l.status = 'done'; l.duration_ms = evt.duration_ms; } return c; });
              break;
            case 'tool_error':
              setSteps(prev => { const c = [...prev]; const l = c[c.length - 1]; if (l) { l.status = 'error'; l.error = evt.error; l.duration_ms = evt.duration_ms; } return c; });
              break;
            case 'column_mapping':
              setColumnMappings(evt.mappings || []);
              break;
            case 'kpi_audit':
              setKpiAudit(evt);
              if (evt.reasoning) {
                setThinkingTraces(prev => [...prev, {
                  phase: 'kpi_calculation',
                  thinking: evt.reasoning + (evt.derivations?.length ? `\nDerived: ${evt.derivations.join(', ')}` : ''),
                }]);
              }
              break;
            case 'synthesize_chunk':
              setNarrative(prev => prev + (evt.text || ''));
              break;
            case 'agent_done': {
              const r = evt.result || {};
              setTotalDuration(r.total_duration_ms || 0);
              setArtifactCount(r.artifact_count || 0);
              // download_id may be included in agent_done (more reliable than separate artifacts_ready)
              if (r.download_id) setDownloadId(r.download_id);
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
            case 'format_rejected':
              setSteps([{ tool: 'format_validation', status: 'error', finding: (evt.issues || []).map(i => i.detail).join('; ') }]);
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
      setError(`Analysis failed: ${err.message}`);
      setPhase('error');
    }
  }, [sheets, selectedModel]);

  // ── Chat ──
  const sendChat = useCallback(() => {
    if (!chatInput.trim() || !sheets) return;
    const msg = chatInput.trim();
    setChatMessages(prev => [...prev, { role: 'user', text: msg }]);
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'agent', text: '...' }]);
    runAgent(sheets, msg).then(() => {
      setChatMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'agent' && last.text === '...') last.text = 'Analysis updated. See results above.';
        return updated;
      });
    });
  }, [chatInput, sheets, runAgent]);

  const toggleStep = (i) => setExpandedSteps(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });

  // ── Render ──
  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--surface-base, #0f1117)' }}>

      {/* ══════════ IDLE: Upload Screen ══════════ */}
      {phase === 'idle' ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          {/* Hero */}
          <div className="mb-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center mx-auto mb-5 shadow-lg shadow-purple-500/20">
              <Sparkles className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              Decision Intelligence
            </h1>
            <p className="text-[var(--text-secondary)] text-sm max-w-md">
              Upload your supply chain data. The AI worker will analyze it autonomously — cleaning, KPIs, anomalies, variance, and a full executive summary.
            </p>
          </div>

          {/* What the worker does */}
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-1 mb-8 text-xs text-[var(--text-muted)]">
            {['Data Cleaning', 'KPI Calculation', 'Anomaly Detection', 'Demand Forecast', 'Risk Scoring', 'Executive Summary'].map(cap => (
              <span key={cap} className="flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-purple-400" />
                {cap}
              </span>
            ))}
          </div>

          {/* Upload zone */}
          <div
            className="max-w-md w-full p-10 border-2 border-dashed rounded-2xl text-center cursor-pointer transition-all duration-200 hover:border-purple-400 hover:bg-purple-500/5"
            style={{ borderColor: 'var(--border-default, #2a2d35)' }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--brand-500, #8b5cf6)'; }}
            onDragLeave={e => { e.currentTarget.style.borderColor = ''; }}
            onDrop={handleDrop}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
            <Upload className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
            <p className="font-medium text-[var(--text-primary)] mb-1">Drop your file here</p>
            <p className="text-xs text-[var(--text-muted)]">.xlsx, .xls, or .csv — any size</p>
          </div>

          {/* Try with sample data */}
          <div className="mt-8 text-center">
            <p className="text-xs text-[var(--text-muted)] mb-3">Or try with sample data:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                { label: 'MBR Report (6 sheets)', file: 'eval_golden.xlsx' },
                { label: 'Financial Sample', file: 'financial_sample.xlsx' },
                { label: 'Supply Chain (35K rows)', file: 'sc_analytics.xlsx' },
                { label: 'EMS/ODM (Chinese)', file: 'ems_odm_sample.xlsx' },
              ].map(({ label, file }) => (
                <button
                  key={file}
                  onClick={async () => {
                    try {
                      const resp = await fetch(`/sample_data/${file}`);
                      const blob = await resp.blob();
                      const f = new File([blob], file, { type: blob.type });
                      handleFile({ target: { files: [f] } });
                    } catch (err) {
                      setError(`Failed to load sample: ${err.message}`);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs border transition-all hover:border-purple-400 hover:bg-purple-500/10"
                  style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Supported formats */}
          <p className="mt-6 text-xs text-[var(--text-muted)] opacity-50">
            Works with sales data, MBR exports, financial reports, inventory snapshots, and more.
          </p>
        </div>
      ) : (
        <>
          {/* ══════════ ACTIVE: Status Bar + Results ══════════ */}

          {/* Top status bar */}
          <div className="flex-shrink-0 h-12 px-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card, #1a1d27)' }}>
            <div className="flex items-center gap-3 text-sm min-w-0">
              <FileSpreadsheet className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="font-medium text-[var(--text-primary)] truncate">{fileName}</span>
              <span className="text-[var(--text-muted)] shrink-0">{sheetNames.length} sheet{sheetNames.length > 1 ? 's' : ''} &middot; {totalRows.toLocaleString()} rows</span>
              {phase === 'running' && <Loader2 className="w-4 h-4 animate-spin text-purple-400 shrink-0" />}
              {phase === 'done' && <span className="text-emerald-400 flex items-center gap-1 shrink-0"><CheckCircle className="w-3.5 h-3.5" /> Done in {formatMs(totalDuration)}</span>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {downloadId && (
                <a href={`${ML_API}/agent/mbr/download/${downloadId}`} target="_blank" rel="noopener noreferrer"
                   className="h-7 px-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors">
                  <Download className="w-3 h-3" /> Download Report
                </a>
              )}
              <button
                onClick={() => { setPhase('idle'); setSheets(null); setSteps([]); setNarrative(''); setTools([]); setChatMessages([]); setDownloadId(null); setError(null); }}
                className="h-7 px-3 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] flex items-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3 h-3" /> New Analysis
              </button>
            </div>
          </div>

          {/* ── Query Input (shown after upload, before running) ── */}
          {phase === 'ready' && (
            <div className="flex-shrink-0 border-b px-4 py-4" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)' }}>
              <div className="max-w-2xl mx-auto">
                <div className="flex items-center gap-3 mb-2">
                  <p className="text-sm text-[var(--text-secondary)]">What would you like to analyze?</p>
                  <select
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    className="h-7 px-2 rounded-md border text-xs text-[var(--text-secondary)]"
                    style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
                  >
                    {MODEL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        const q = chatInput.trim() || 'Analyze this data comprehensively: calculate KPIs, detect anomalies, find patterns, and provide actionable recommendations.';
                        setChatInput('');
                        runAgent(sheets, q);
                      }
                    }}
                    placeholder="e.g. Run full analysis: forecast, KPI, variance, anomaly, BOM"
                    autoFocus
                    className="flex-1 h-10 px-4 rounded-lg border text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                    style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
                  />
                  <button
                    onClick={() => {
                      const q = chatInput.trim() || 'Analyze this data comprehensively: calculate KPIs, detect anomalies, find patterns, and provide actionable recommendations.';
                      setChatInput('');
                      runAgent(sheets, q);
                    }}
                    className="h-10 px-5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium flex items-center gap-2 transition-colors"
                  >
                    <Sparkles className="w-4 h-4" /> Analyze
                  </button>
                </div>
                <div className="flex gap-2 mt-2">
                  {['Full MBR analysis', 'Forecast demand', 'Calculate KPIs and margins', 'Detect anomalies'].map(q => (
                    <button
                      key={q}
                      onClick={() => { setChatInput(''); runAgent(sheets, q); }}
                      className="px-2.5 py-1 rounded-md text-xs border hover:bg-purple-500/10 hover:border-purple-500/30 transition-colors"
                      style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Main scroll area */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-6 py-6 space-y-5">

              {/* Error */}
              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-300">{error}</p>
                </div>
              )}

              {/* ── Pipeline Progress ── */}
              {(tools.length > 0 || steps.length > 0) && (
                <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                  {/* Header */}
                  <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: 'var(--border-default)' }}>
                    <div className="flex items-center gap-2">
                      <Brain className="w-4 h-4 text-purple-400" />
                      <span className="text-sm font-semibold text-[var(--text-primary)]">Analysis Pipeline</span>
                      {steps.length > 0 && (
                        <span className="text-xs text-[var(--text-muted)]">
                          {steps.filter(s => s.status === 'done').length}/{steps.length} complete
                        </span>
                      )}
                    </div>
                    {(columnMappings.length > 0 || kpiAudit) && (
                      <button
                        onClick={() => setShowEvidence(!showEvidence)}
                        className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 transition-colors"
                      >
                        {showEvidence ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        {showEvidence ? 'Hide' : 'Show'} Evidence
                      </button>
                    )}
                  </div>

                  {/* Tool pills (planning phase) */}
                  {tools.length > 0 && steps.length === 0 && (
                    <div className="px-4 py-3 flex flex-wrap gap-1.5">
                      {tools.map(t => (
                        <span key={t} className="px-2.5 py-1 rounded-full text-xs bg-purple-500/10 text-purple-300 border border-purple-500/20">
                          {toolLabel(t)}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Execution steps */}
                  {steps.map((s, i) => (
                    <div key={i} className="border-t" style={{ borderColor: 'var(--border-default)' }}>
                      <div
                        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                        onClick={() => toggleStep(i)}
                      >
                        <div className="w-5 flex justify-center shrink-0">
                          {s.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
                          {s.status === 'done' && <CheckCircle className="w-4 h-4 text-emerald-400" />}
                          {s.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--text-primary)]">{toolLabel(s.tool)}</span>
                            {s.duration_ms != null && (
                              <span className="text-xs text-[var(--text-muted)]">{formatMs(s.duration_ms)}</span>
                            )}
                          </div>
                          {s.finding && !expandedSteps.has(i) && (
                            <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{s.finding}</p>
                          )}
                        </div>
                        {(s.finding || s.fullSummary) && (
                          <div className="shrink-0 text-[var(--text-muted)]">
                            {expandedSteps.has(i) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </div>
                        )}
                      </div>
                      {/* Expanded detail */}
                      {expandedSteps.has(i) && (s.fullSummary || s.finding || s.error) && (
                        <div className="px-4 pb-3 pl-12">
                          {s.error ? (
                            <p className="text-xs text-red-400">{s.error}</p>
                          ) : (
                            <pre className="p-3 rounded-lg text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto" style={{ backgroundColor: 'var(--surface-base)' }}>
                              {s.fullSummary || s.finding}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Evidence section (collapsible) */}
                  {showEvidence && (columnMappings.length > 0 || kpiAudit) && (
                    <div className="border-t px-4 py-3 space-y-3" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)' }}>
                      {columnMappings.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-[var(--text-muted)] mb-1.5 uppercase tracking-wide">Column Mapping</p>
                          <div className="font-mono text-xs space-y-0.5 text-[var(--text-secondary)]">
                            {columnMappings.map((m, i) => (
                              <div key={i} className={m.includes('revenue') || m.includes('cost') ? 'text-amber-300' : ''}>{m}</div>
                            ))}
                          </div>
                        </div>
                      )}
                      {kpiAudit && (
                        <div>
                          <p className="text-xs font-medium text-[var(--text-muted)] mb-1.5 uppercase tracking-wide">KPI Calculation Audit</p>
                          {kpiAudit.reasoning && <p className="text-xs text-[var(--text-secondary)] mb-1">{kpiAudit.reasoning}</p>}
                          {kpiAudit.derivations?.length > 0 && <p className="text-xs text-amber-300">Derived: {kpiAudit.derivations.join(', ')}</p>}
                          {kpiAudit.code && (
                            <details className="mt-1">
                              <summary className="text-xs text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-primary)]">View generated code</summary>
                              <pre className="mt-1 p-2 rounded text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap" style={{ backgroundColor: 'var(--surface-card)' }}>
                                {kpiAudit.code}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Agent Thinking Panel (streaming timeline) ── */}
              {(thinkingTraces.length > 0 || Object.keys(agentStatuses).length > 0) && (() => {
                const isAnalyzing = Object.values(agentStatuses).some(s => s === 'running');
                const completedPhases = new Set(thinkingTraces.map(t => t.phase));
                const runningPhases = Object.entries(agentStatuses)
                  .filter(([phase, status]) => status === 'running' && !completedPhases.has(phase))
                  .map(([phase]) => phase);

                return (
                  <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                    {/* Header with shimmer */}
                    <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-default)' }}>
                      {isAnalyzing ? (
                        <div className="w-4 h-4 rounded-full border-2 border-purple-500 border-t-transparent timeline-dot-spin" />
                      ) : (
                        <Brain className="w-4 h-4 text-amber-400" />
                      )}
                      <span className={`text-sm font-semibold ${isAnalyzing ? 'shimmer-text' : 'text-[var(--text-primary)]'}`}>
                        {isAnalyzing ? 'Agents Analyzing...' : 'Agent Analysis'}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        {thinkingTraces.length} complete{runningPhases.length > 0 ? ` · ${runningPhases.length} running` : ''}
                      </span>
                    </div>

                    {/* Timeline */}
                    <div className="relative pl-8 pr-4 py-3">
                      <div className="absolute left-5 top-3 bottom-3 w-px" style={{ backgroundColor: 'var(--border-default)' }} />

                      {/* Running agents (show dots animation) */}
                      {runningPhases.map((phase) => {
                        const config = AGENT_CONFIG[phase] || { icon: '💬', label: phase, color: '#9ca3af', bg: 'rgba(107,114,128,0.15)' };
                        return (
                          <div key={`running-${phase}`} className="relative pb-4" style={{ animation: 'fadeSlideIn 0.3s ease-out both' }}>
                            <div className="absolute -left-3 w-6 h-6 rounded-full flex items-center justify-center text-xs border-2 border-dashed"
                                 style={{ borderColor: config.color, backgroundColor: config.bg, top: '2px' }}>
                              <div className="w-3 h-3 rounded-full border-2 border-t-transparent timeline-dot-spin"
                                   style={{ borderColor: config.color }} />
                            </div>
                            <div className="ml-5 rounded-lg border px-3 py-2 flex items-center gap-2" style={{ borderColor: 'var(--border-default)', backgroundColor: config.bg }}>
                              <span className="text-xs font-semibold" style={{ color: config.color }}>{config.label}</span>
                              <span className="thinking-dots"><span /><span /><span /></span>
                            </div>
                          </div>
                        );
                      })}

                      {/* Completed agents (show content) */}
                      {thinkingTraces.map((trace, i) => (
                        <AgentThinkingCard key={`done-${trace.phase}-${i}`} trace={trace} index={i} isLast={i === thinkingTraces.length - 1} />
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* ── Executive Summary ── */}
              {narrative && (
                <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                  <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-default)' }}>
                    <Sparkles className="w-4 h-4 text-purple-400" />
                    <span className="text-sm font-semibold text-[var(--text-primary)]">Executive Summary</span>
                  </div>
                  <div className="px-5 py-4 prose prose-invert prose-sm max-w-none text-[var(--text-primary)] leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{narrative}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* ── Chat Messages ── */}
              {chatMessages.length > 0 && (
                <div className="space-y-3 pt-3">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-purple-600 text-white'
                          : 'text-[var(--text-primary)]'
                      }`} style={msg.role !== 'user' ? { backgroundColor: 'var(--surface-card)' } : undefined}>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Chat Input ── */}
          {(phase === 'done' || phase === 'ready') && (
            <div className="flex-shrink-0 border-t px-4 py-3" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
              <div className="max-w-2xl mx-auto flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendChat()}
                  placeholder="Ask about the results, request deeper analysis, or suggest corrections..."
                  className="flex-1 h-10 px-4 rounded-lg border text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-purple-500/50 transition-colors"
                  style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)' }}
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim()}
                  className="h-10 w-10 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-20 disabled:cursor-default text-white flex items-center justify-center transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
