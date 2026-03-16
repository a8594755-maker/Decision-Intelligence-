// @product: ai-employee
//
// WorkOrderDraftCard — Phase 0 confirmation card before full task decomposition.
// Shows inferred workflow, matched tools, data hints, and optional clarifications.

import React, { useState } from 'react';
import {
  FileText, Paperclip, FolderOpen, Database, Clock,
  CheckCircle2, ChevronRight, X,
} from 'lucide-react';

const WORKFLOW_ICON = {
  forecast: '📈',
  replenishment: '📦',
  risk_plan: '⚠️',
  full_report: '📊',
  bom_analysis: '🔩',
  scenario: '🔮',
  negotiation: '🤝',
  cost_analysis: '💰',
  inventory: '📋',
  data_quality: '🔍',
  macro_oracle: '🌐',
  mbr_with_excel: '📑',
};

const DATA_HINT_ICON = {
  attached: Paperclip,
  folder_ref: FolderOpen,
  time_range: Clock,
  system_ref: Database,
};

const DATA_HINT_LABEL = {
  attached: 'File attached',
  folder_ref: 'Cloud folder',
  time_range: 'Time range specified',
  system_ref: 'System reference',
};

/**
 * @param {object} props
 * @param {import('../../services/aiEmployee/workOrderDraftService').WorkOrderDraft} props.draft
 * @param {(draft: object, answers: object) => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @param {() => void} [props.onAttach]
 * @param {boolean} [props.disabled]
 */
export default function WorkOrderDraftCard({ draft, onConfirm, onCancel, onAttach, disabled }) {
  const [answers, setAnswers] = useState({});

  if (!draft) return null;

  const icon = WORKFLOW_ICON[draft.workflow_type] || '⚡';

  const handleAnswer = (key, value) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="text-2xl" role="img" aria-label={draft.workflow_label}>{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {draft.workflow_label}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
            {draft.description}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
          ~{draft.estimated_steps} step{draft.estimated_steps !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Matched tools */}
      {draft.matched_tools?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {draft.matched_tools.map((tool) => (
            <span
              key={tool.id}
              className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300"
            >
              {tool.name}
            </span>
          ))}
        </div>
      )}

      {/* Data hints */}
      {draft.data_hints?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {draft.data_hints.map((hint) => {
            const Icon = DATA_HINT_ICON[hint] || FileText;
            return (
              <span
                key={hint}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
              >
                <Icon className="h-3 w-3" />
                {DATA_HINT_LABEL[hint] || hint}
              </span>
            );
          })}
        </div>
      )}

      {/* Clarifications */}
      {draft.clarifications?.length > 0 && (
        <div className="mt-4 space-y-3">
          {draft.clarifications.map((clar) => (
            <div key={clar.key}>
              <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                {clar.label}
              </label>
              {clar.type === 'choice' && clar.options ? (
                <div className="flex flex-wrap gap-1.5">
                  {clar.options.map((opt) => {
                    const selected = answers[clar.key] === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          handleAnswer(clar.key, opt);
                          if (opt === 'Attach a file') onAttach?.();
                        }}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          selected
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-900/30 dark:text-indigo-300'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-700'
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input
                  type="text"
                  disabled={disabled}
                  placeholder={clar.label}
                  className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-700"
                  onChange={(e) => handleAnswer(clar.key, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
        >
          <X className="h-3.5 w-3.5" />
          Dismiss
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onConfirm?.(draft, answers)}
          className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Confirm & Plan
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
