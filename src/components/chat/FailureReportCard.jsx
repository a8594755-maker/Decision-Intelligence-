import { AlertTriangle, ChevronDown, ChevronUp, Lightbulb, RefreshCw, Shield } from 'lucide-react';
import { useState } from 'react';

const SEVERITY_STYLES = {
  recoverable: { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-300 dark:border-amber-700', text: 'text-amber-700 dark:text-amber-300', label: 'Recoverable' },
  needs_user_action: { bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-300 dark:border-red-700', text: 'text-red-700 dark:text-red-300', label: 'Needs Action' },
  critical: { bg: 'bg-red-100 dark:bg-red-900/30', border: 'border-red-400 dark:border-red-600', text: 'text-red-800 dark:text-red-200', label: 'Critical' },
};

const ACTION_ICONS = {
  upload_data: '📂', set_default: '⚙️', wait_retry: '⏳', switch_provider: '🔄',
  configure_key: '🔑', simplify_request: '✏️', provide_example: '📝',
  reduce_data: '📉', reduce_scope: '🎯', retry: '🔁', contact_support: '📞',
  update_permissions: '🔐',
};

export default function FailureReportCard({ payload }) {
  const [expanded, setExpanded] = useState(false);
  if (!payload) return null;

  const {
    root_cause, category, severity = 'needs_user_action', suggestions = [],
    confidence, source, step_name, retry_count, error_snippet, diagnosis_ms,
  } = payload;

  const style = SEVERITY_STYLES[severity] || SEVERITY_STYLES.needs_user_action;

  return (
    <div className={`rounded-xl ${style.bg} ${style.border} border p-4 my-2 max-w-lg`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className={`w-5 h-5 ${style.text}`} />
        <span className={`text-sm font-semibold ${style.text}`}>
          Step &ldquo;{step_name || 'unknown'}&rdquo; Failed
        </span>
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium ${style.bg} ${style.text} border ${style.border}`}>
          {style.label}
        </span>
      </div>

      {/* Root cause */}
      <p className="text-sm text-[var(--text-secondary)] mb-3 leading-relaxed">
        {root_cause || 'Unknown failure reason.'}
      </p>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] mb-1.5">
            <Lightbulb className="w-3.5 h-3.5" />
            Suggested Actions
          </div>
          <ul className="space-y-1.5">
            {suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-secondary)] bg-white/60 dark:bg-slate-800/40 rounded-lg px-3 py-2">
                <span className="text-base leading-none mt-0.5">{ACTION_ICONS[s.action] || '💡'}</span>
                <span>{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Retry info + expand toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          {retry_count > 0 && (
            <span className="flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> {retry_count} retries
            </span>
          )}
          {confidence != null && (
            <span className="flex items-center gap-1">
              <Shield className="w-3 h-3" /> {Math.round(confidence * 100)}% confidence
            </span>
          )}
          {source && (
            <span className="opacity-60">{source === 'llm' ? 'AI diagnosis' : 'Pattern-based'}</span>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-0.5"
        >
          Details {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-[var(--border-default)] space-y-2">
          {category && (
            <div className="text-[10px]">
              <span className="text-slate-400">Category: </span>
              <span className="text-[var(--text-secondary)] font-mono">{category}</span>
            </div>
          )}
          {error_snippet && (
            <div className="text-[10px]">
              <span className="text-slate-400">Error: </span>
              <code className="text-red-500 dark:text-red-400 font-mono break-all text-[9px]">{error_snippet}</code>
            </div>
          )}
          {diagnosis_ms != null && (
            <div className="text-[10px] text-slate-400">
              Diagnosed in {diagnosis_ms}ms
            </div>
          )}
        </div>
      )}
    </div>
  );
}
