// ============================================================================
// AgentExecutionPanel — Real-time Agent Execution Dashboard
//
// Side panel that shows step-by-step execution progress with full transparency:
// - Step timeline with status indicators
// - Generated code (Python/JS) per step
// - API calls and responses
// - Artifacts produced (row counts, types)
// - Errors, retries, self-healing actions
// - AI review scores
// ============================================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Clock, CheckCircle2, AlertTriangle, Loader2, Code2, FileText,
  ChevronDown, ChevronRight, Terminal, Zap, Eye, Database,
  RotateCcw, Brain, XCircle, Activity, Copy, Check, ArrowRight, X, Wifi,
} from 'lucide-react';
import useEventBus from '../../hooks/useEventBus';

// ── Status styles & icons ──────────────────────────────────────────────────

const STATUS_STYLES = {
  pending:     { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-500', dot: 'bg-slate-400', label: 'Pending' },
  running:     { bg: 'bg-blue-50 dark:bg-blue-900/20', text: 'text-blue-600', dot: 'bg-blue-500', label: 'Running' },
  succeeded:   { bg: 'bg-emerald-50 dark:bg-emerald-900/20', text: 'text-emerald-600', dot: 'bg-emerald-500', label: 'Done' },
  failed:      { bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-600', dot: 'bg-red-500', label: 'Failed' },
  blocked:     { bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-600', dot: 'bg-red-500', label: 'Blocked' },
  review_hold: { bg: 'bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-600', dot: 'bg-amber-500', label: 'Review' },
  skipped:     { bg: 'bg-slate-50 dark:bg-slate-800', text: 'text-slate-400', dot: 'bg-slate-300', label: 'Skipped' },
  revision_needed: { bg: 'bg-orange-50 dark:bg-orange-900/20', text: 'text-orange-600', dot: 'bg-orange-500', label: 'Revision' },
};

const STATUS_ICONS = {
  pending:     <Clock className="w-4 h-4" />,
  running:     <Loader2 className="w-4 h-4 animate-spin" />,
  succeeded:   <CheckCircle2 className="w-4 h-4" />,
  failed:      <XCircle className="w-4 h-4" />,
  blocked:     <AlertTriangle className="w-4 h-4" />,
  review_hold: <Eye className="w-4 h-4" />,
  skipped:     <ArrowRight className="w-4 h-4" />,
  revision_needed: <RotateCcw className="w-4 h-4" />,
};

// ── Utility: duration formatting ───────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// ── Copy button ────────────────────────────────────────────────────────────

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
    </button>
  );
}

// ── Code block ─────────────────────────────────────────────────────────────

function CodeBlock({ code, language: _language = 'python', maxHeight = 300 }) {
  const [expanded, setExpanded] = useState(false);
  if (!code) return null;

  const lines = code.split('\n');
  const isLong = lines.length > 15;
  const displayCode = expanded || !isLong ? code : lines.slice(0, 15).join('\n') + '\n# ...';

  return (
    <div className="relative group">
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
        <CopyButton text={code} />
      </div>
      <pre
        className="text-xs font-mono bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto"
        style={{ maxHeight: expanded ? 'none' : `${maxHeight}px` }}
      >
        <code>{displayCode}</code>
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-center text-xs text-blue-500 hover:text-blue-400 py-1 bg-slate-800 rounded-b-lg -mt-1"
        >
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

// ── Artifact badge ─────────────────────────────────────────────────────────

function ArtifactBadge({ artifact }) {
  const rowCount = Array.isArray(artifact.data) ? artifact.data.length : null;
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
      <Database className="w-3 h-3 text-emerald-600" />
      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
        {artifact.label || artifact.type}
      </span>
      {rowCount !== null && (
        <span className="text-[10px] text-emerald-600 dark:text-emerald-500">
          {rowCount.toLocaleString()} rows
        </span>
      )}
    </div>
  );
}

// ── Single step detail card ────────────────────────────────────────────────

function StepDetailCard({ step, stepEvent, index, isActive }) {
  const [isOpen, setIsOpen] = useState(false);
  const style = STATUS_STYLES[step.status] || STATUS_STYLES.pending;
  const eventStyle = stepEvent?.status ? (STATUS_STYLES[stepEvent.status] || style) : style;

  // Auto-open when step becomes active
  useEffect(() => {
    if (step.status === 'running' || step.status === 'succeeded') {
      queueMicrotask(() => setIsOpen(true));
    }
  }, [step.status]);

  const durationMs = step.started_at && step.finished_at
    ? new Date(step.finished_at) - new Date(step.started_at)
    : null;

  // Gather rich details from step event
  const details = stepEvent || {};
  const hasCode = !!details.code;
  const hasApiCall = !!details.api_call;
  const hasArtifacts = details.artifacts?.length > 0 || step.artifact_refs?.length > 0;
  const hasError = !!step.error || !!details.error;
  const hasReview = details.review_score !== undefined;
  const hasHealing = !!details.healing_strategy || !!step._healing_strategy;

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${
      isActive ? 'border-blue-300 dark:border-blue-700 shadow-md shadow-blue-100 dark:shadow-blue-900/20' : 'border-slate-200 dark:border-slate-700'
    }`}>
      {/* Header */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${
          isActive ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
        }`}
      >
        {/* Step number + status dot */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center ${style.bg}`}>
            <span className={`text-xs font-bold ${style.text}`}>
              {step.status === 'running' ? STATUS_ICONS.running : index + 1}
            </span>
          </div>
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
              {step.name}
            </span>
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>
              {eventStyle.label}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            {step.workflow_type && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                {step.workflow_type}
              </span>
            )}
            {durationMs !== null && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-0.5">
                <Clock className="w-2.5 h-2.5" />
                {formatDuration(durationMs)}
              </span>
            )}
            {step.retry_count > 0 && (
              <span className="text-[10px] text-orange-600 dark:text-orange-400 flex items-center gap-0.5">
                <RotateCcw className="w-2.5 h-2.5" />
                {step.retry_count}
              </span>
            )}
          </div>
        </div>

        {/* Detail indicators */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasCode && <Code2 className="w-3.5 h-3.5 text-violet-500" title="Has code" />}
          {hasApiCall && <Terminal className="w-3.5 h-3.5 text-cyan-500" title="API call" />}
          {hasArtifacts && <Database className="w-3.5 h-3.5 text-emerald-500" title="Artifacts" />}
          {hasReview && <Brain className="w-3.5 h-3.5 text-amber-500" title="AI Review" />}
          {hasError && <AlertTriangle className="w-3.5 h-3.5 text-red-500" title="Error" />}
          {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        </div>
      </button>

      {/* Expandable detail body */}
      {isOpen && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-slate-700/50 bg-white dark:bg-slate-900/30">
          {/* Running indicator */}
          {step.status === 'running' && (
            <div className="flex items-center gap-2 py-2 text-blue-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Executing...</span>
              {step.started_at && (
                <span className="text-xs text-slate-400 ml-auto">{formatTimestamp(step.started_at)}</span>
              )}
            </div>
          )}

          {/* Summary */}
          {details.summary && (
            <div className="text-sm text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
              {details.summary}
            </div>
          )}

          {/* API Call Info */}
          {details.api_call && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-400 mb-1.5">
                <Terminal className="w-3.5 h-3.5" />
                API Call
              </div>
              <div className="text-xs font-mono bg-slate-800 text-cyan-300 rounded-lg p-3 overflow-x-auto">
                <div className="text-slate-500">
                  {details.api_call.method || 'POST'} {details.api_call.url}
                </div>
                {details.api_call.provider && (
                  <div className="text-slate-400 mt-1">Provider: {details.api_call.provider} | Model: {details.api_call.model || '—'}</div>
                )}
                {details.api_call.duration_ms && (
                  <div className="text-slate-400">Duration: {formatDuration(details.api_call.duration_ms)}</div>
                )}
                {details.api_call.status && (
                  <div className={details.api_call.status >= 400 ? 'text-red-400' : 'text-emerald-400'}>
                    Status: {details.api_call.status}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Generated Code */}
          {hasCode && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-400 mb-1.5">
                <Code2 className="w-3.5 h-3.5" />
                Generated Code
                {details.code_language && (
                  <span className="text-[10px] bg-violet-100 dark:bg-violet-900/30 px-1.5 py-0.5 rounded font-mono">
                    {details.code_language}
                  </span>
                )}
              </div>
              <CodeBlock code={details.code} language={details.code_language || 'python'} />
            </div>
          )}

          {/* Execution Output (stdout/stderr) */}
          {(details.stdout || details.stderr) && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                <Terminal className="w-3.5 h-3.5" />
                Output
              </div>
              {details.stdout && (
                <pre className="text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg p-3 max-h-40 overflow-auto">
                  {details.stdout.slice(0, 2000)}
                </pre>
              )}
              {details.stderr && (
                <pre className="text-xs font-mono bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-lg p-3 max-h-40 overflow-auto mt-1">
                  {details.stderr.slice(0, 2000)}
                </pre>
              )}
            </div>
          )}

          {/* Artifacts */}
          {hasArtifacts && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 mb-1.5">
                <Database className="w-3.5 h-3.5" />
                Artifacts ({(details.artifacts || step.artifact_refs || []).length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(details.artifacts || step.artifact_refs || []).map((art, i) => (
                  <ArtifactBadge key={i} artifact={art} />
                ))}
              </div>
            </div>
          )}

          {/* AI Review */}
          {hasReview && (
            <div className={`rounded-lg p-3 ${details.review_passed ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-amber-50 dark:bg-amber-900/20'}`}>
              <div className="flex items-center gap-2">
                <Brain className={`w-4 h-4 ${details.review_passed ? 'text-emerald-600' : 'text-amber-600'}`} />
                <span className="text-xs font-medium">
                  AI Review: {details.review_score}/{details.review_threshold || 70}
                </span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  details.review_passed ? 'bg-emerald-200 text-emerald-800' : 'bg-amber-200 text-amber-800'
                }`}>
                  {details.review_passed ? 'PASS' : 'FAIL'}
                </span>
              </div>
              {details.suggestions?.length > 0 && (
                <ul className="text-xs text-slate-600 dark:text-slate-400 mt-2 space-y-1 ml-6 list-disc">
                  {details.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Error + Diagnosis */}
          {hasError && (
            <div className="rounded-lg p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                {details.diagnosis?.root_cause ? 'Diagnosis' : 'Error'}
              </div>
              {details.diagnosis?.root_cause ? (
                <>
                  <p className="text-xs text-red-600 dark:text-red-300 mb-1.5">
                    {details.diagnosis.root_cause}
                  </p>
                  {details.diagnosis.suggestions?.length > 0 && (
                    <ul className="text-[10px] text-red-500 dark:text-red-400 space-y-0.5 ml-3 list-disc">
                      {details.diagnosis.suggestions.map((s, i) => (
                        <li key={i}>{s.detail}</li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[9px] text-red-400 dark:text-red-500 font-mono mt-1.5 break-all">
                    {(details.error || step.error || '').slice(0, 200)}
                  </p>
                </>
              ) : (
                <p className="text-xs text-red-600 dark:text-red-300 font-mono break-all">
                  {(details.error || step.error || '').slice(0, 500)}
                </p>
              )}
            </div>
          )}

          {/* Self-Healing */}
          {hasHealing && (
            <div className="rounded-lg p-3 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800">
              <div className="flex items-center gap-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-400 mb-1">
                <Zap className="w-3.5 h-3.5" />
                Self-Healing
              </div>
              <p className="text-xs text-indigo-600 dark:text-indigo-300">
                Strategy: {details.healing_strategy || step._healing_strategy?.healingStrategy || '—'}
              </p>
              {(details.healing_reasoning || step._healing_strategy?.reasoning) && (
                <p className="text-xs text-indigo-500 dark:text-indigo-400 mt-1">
                  {details.healing_reasoning || step._healing_strategy?.reasoning}
                </p>
              )}
            </div>
          )}

          {/* Timestamps */}
          <div className="flex gap-4 text-[10px] text-slate-400">
            {step.started_at && <span>Start: {formatTimestamp(step.started_at)}</span>}
            {step.finished_at && <span>End: {formatTimestamp(step.finished_at)}</span>}
            {durationMs > 0 && <span>Duration: {formatDuration(durationMs)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Summary bar ────────────────────────────────────────────────────────────

function SummaryBar({ steps, events }) {
  const succeeded = steps.filter(s => s.status === 'succeeded').length;
  const failed = steps.filter(s => s.status === 'failed' || s.status === 'blocked').length;
  const running = steps.filter(s => s.status === 'running').length;
  const total = steps.length;
  const pct = total > 0 ? Math.round((succeeded / total) * 100) : 0;

  const totalArtifacts = events.reduce((sum, e) => sum + (Array.isArray(e?.artifacts) ? e.artifacts.length : 0), 0);
  const totalRows = events.reduce((sum, e) => {
    const arts = Array.isArray(e?.artifacts) ? e.artifacts : [];
    return sum + arts.reduce((rs, a) => rs + (a && Array.isArray(a.data) ? a.data.length : 0), 0);
  }, 0);

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-500 ease-out rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stat chips */}
      <div className="flex flex-wrap gap-2 text-[10px] font-medium">
        <span className="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
          {succeeded}/{total} done
        </span>
        {running > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 flex items-center gap-1">
            <Loader2 className="w-2.5 h-2.5 animate-spin" /> {running} running
          </span>
        )}
        {failed > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
            {failed} failed
          </span>
        )}
        {totalArtifacts > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">
            {totalArtifacts} artifacts
          </span>
        )}
        {totalRows > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400">
            {totalRows.toLocaleString()} rows
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export default function AgentExecutionPanel({ loopState, stepEvents = [], taskTitle, onClose, sseConnected = false }) {
  const scrollRef = useRef(null);
  const steps = useMemo(() => loopState?.steps || [], [loopState?.steps]);

  // Collect events from EventBus (supplements props-based events)
  const [busEvents, setBusEvents] = useState([]);

  useEventBus('agent:*', useCallback((payload, eventName) => {
    if (payload?.step_name) {
      setBusEvents(prev => {
        const idx = prev.findIndex(e => e.step_name === payload.step_name);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...payload, _eventName: eventName };
          return updated;
        }
        return [...prev, { ...payload, _eventName: eventName }];
      });
    }
  }, []));

  // Merge props events + bus events
  const allEvents = useMemo(() => {
    const merged = [...stepEvents];
    for (const be of busEvents) {
      if (!merged.some(e => e.step_name === be.step_name)) {
        merged.push(be);
      }
    }
    return merged;
  }, [stepEvents, busEvents]);

  // Build event map: step_name → latest event
  const eventMap = useMemo(() => {
    const map = {};
    for (const ev of allEvents) {
      if (ev?.step_name) {
        map[ev.step_name] = { ...(map[ev.step_name] || {}), ...ev };
      }
    }
    return map;
  }, [allEvents]);

  // Auto-scroll to active step
  useEffect(() => {
    if (scrollRef.current) {
      const active = scrollRef.current.querySelector('[data-active="true"]');
      if (active) {
        active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [steps]);

  const activeStepName = steps.find(s => s.status === 'running')?.name;
  const isComplete = steps.length > 0 && steps.every(s => s.status === 'succeeded' || s.status === 'skipped');

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
        <Activity className="w-5 h-5 text-blue-600" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
            {taskTitle || 'Agent Execution'}
          </h3>
          <p className="text-[10px] text-slate-500 flex items-center gap-1">
            {steps.length} steps {isComplete ? '— Complete' : ''}
            {sseConnected && (
              <span className="inline-flex items-center gap-0.5 text-emerald-500" title="SSE connected">
                <Wifi className="w-3 h-3" /> <span className="text-[9px]">Live</span>
              </span>
            )}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4 text-slate-400" />
          </button>
        )}
      </div>

      {/* Summary bar */}
      {steps.length > 0 && (
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex-shrink-0">
          <SummaryBar steps={steps} events={stepEvents} />
        </div>
      )}

      {/* Steps timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {steps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
            <Activity className="w-8 h-8" />
            <p className="text-sm">Waiting for execution...</p>
          </div>
        ) : (
          steps.map((step, i) => (
            <div key={step.name} data-active={step.status === 'running' ? 'true' : undefined}>
              <StepDetailCard
                step={step}
                stepEvent={eventMap[step.name]}
                index={i}
                isActive={step.name === activeStepName}
              />
            </div>
          ))
        )}
      </div>

      {/* Footer: completion or live indicator */}
      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex-shrink-0">
        {isComplete ? (
          <div className="flex items-center gap-2 text-emerald-600">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-xs font-medium">All steps completed successfully</span>
          </div>
        ) : steps.some(s => s.status === 'running') ? (
          <div className="flex items-center gap-2 text-blue-600">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs font-medium">Executing...</span>
          </div>
        ) : steps.some(s => s.status === 'failed' || s.status === 'blocked') ? (
          <div className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-xs font-medium">Execution halted — check errors above</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-slate-400">
            <Clock className="w-4 h-4" />
            <span className="text-xs">Ready</span>
          </div>
        )}
      </div>
    </div>
  );
}
