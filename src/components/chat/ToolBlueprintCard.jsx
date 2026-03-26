/**
 * ToolBlueprintCard.jsx
 *
 * Displays an auto-generated tool blueprint for user review and approval.
 * Shows: tool name, description, generated code (collapsible), I/O schema,
 * and action buttons (Approve & Register / Modify / Reject).
 *
 * Used when the agent loop detects a capability gap and generates a tool
 * blueprint via toolBlueprintGenerator.
 */

import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  Check,
  X,
  Copy,
  AlertTriangle,
  Sparkles,
  ArrowRight,
} from 'lucide-react';

export default function ToolBlueprintCard({ blueprint, onApprove, onReject, disabled }) {
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [schemaExpanded, setSchemaExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [approving, setApproving] = useState(false);

  if (!blueprint) return null;

  const {
    name,
    description,
    category,
    code,
    inputSchema,
    outputSchema,
    tags,
    testCase,
    gapType,
    gapDescription,
    generationFailed,
  } = blueprint;

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      await onApprove?.(blueprint);
    } finally {
      setApproving(false);
    }
  };

  const gapTypeLabel = {
    format_mismatch: '格式轉換 Format Adapter',
    missing_tool: '缺少工具 Missing Tool',
    chain_break: '工具鏈斷裂 Chain Break',
  }[gapType] || gapType;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-50/80 to-orange-50/60 dark:from-amber-950/30 dark:to-orange-950/20 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-amber-200/50 dark:border-amber-800/30">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-lg bg-amber-500/15 dark:bg-amber-500/20 flex items-center justify-center">
            <Sparkles size={15} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
              Auto-Generated Tool Blueprint
            </h3>
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              {gapTypeLabel}
            </span>
          </div>
        </div>
        {gapDescription && (
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">
            {gapDescription}
          </p>
        )}
      </div>

      {/* Tool Info */}
      <div className="px-4 py-3 space-y-2">
        {/* Name + Category */}
        <div className="flex items-center gap-2">
          <Wrench size={13} className="text-[var(--text-muted)] flex-shrink-0" />
          <code className="text-sm font-mono font-semibold text-indigo-700 dark:text-indigo-300">
            {name}
          </code>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200/80 dark:bg-slate-700/60 text-[var(--text-secondary)] font-medium">
            {category}
          </span>
        </div>

        {/* Description */}
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {description}
        </p>

        {/* Tags */}
        {tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag, i) => (
              <span
                key={i}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-muted)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* I/O Schema (collapsible) */}
        {(inputSchema && Object.keys(inputSchema).length > 0 ||
          outputSchema && Object.keys(outputSchema).length > 0) && (
          <div className="border border-[var(--border-default)] rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setSchemaExpanded(v => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--accent-hover)] transition-colors"
            >
              {schemaExpanded
                ? <ChevronDown size={13} className="text-slate-400" />
                : <ChevronRight size={13} className="text-slate-400" />
              }
              <span>Input / Output Schema</span>
            </button>
            {schemaExpanded && (
              <div className="px-3 pb-3 space-y-2">
                {inputSchema && Object.keys(inputSchema).length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                      Input
                    </div>
                    <div className="space-y-0.5">
                      {Object.entries(inputSchema).map(([key, desc]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <code className="text-blue-600 dark:text-blue-400 font-mono shrink-0">{key}</code>
                          <ArrowRight size={10} className="text-slate-400 mt-0.5 shrink-0" />
                          <span className="text-[var(--text-secondary)]">{String(desc)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {outputSchema && Object.keys(outputSchema).length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                      Output
                    </div>
                    <div className="space-y-0.5">
                      {Object.entries(outputSchema).map(([key, desc]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <code className="text-emerald-600 dark:text-emerald-400 font-mono shrink-0">{key}</code>
                          <ArrowRight size={10} className="text-slate-400 mt-0.5 shrink-0" />
                          <span className="text-[var(--text-secondary)]">{String(desc)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Code Preview (collapsible) */}
        <div className="border border-[var(--border-default)] rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setCodeExpanded(v => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            {codeExpanded
              ? <ChevronDown size={13} className="text-slate-400" />
              : <ChevronRight size={13} className="text-slate-400" />
            }
            <span>Generated Code</span>
            <span className="ml-auto text-[10px] text-slate-400">
              {code?.split('\n').length || 0} lines
            </span>
          </button>
          {codeExpanded && (
            <div className="relative">
              <pre className="px-3 pb-3 text-xs font-mono text-emerald-700 dark:text-emerald-300 bg-[var(--surface-base)]/60 overflow-x-auto leading-relaxed whitespace-pre-wrap">
                {code}
              </pre>
              <button
                type="button"
                onClick={handleCopy}
                className="absolute top-1 right-2 p-1 rounded hover:bg-[var(--accent-hover)] transition-colors"
                title="Copy code"
              >
                {copied
                  ? <Check size={12} className="text-green-500" />
                  : <Copy size={12} className="text-slate-400" />
                }
              </button>
            </div>
          )}
        </div>

        {/* Generation failure warning */}
        {generationFailed && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-800/30">
            <AlertTriangle size={13} className="text-red-500 shrink-0" />
            <span className="text-xs text-red-700 dark:text-red-300">
              Auto-generation failed. You can approve and manually edit the code later.
            </span>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="px-4 py-3 border-t border-amber-200/50 dark:border-amber-800/30 flex items-center gap-2">
        <button
          type="button"
          onClick={handleApprove}
          disabled={disabled || approving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={13} />
          {approving ? 'Registering...' : 'Approve & Register'}
        </button>
        <button
          type="button"
          onClick={() => onReject?.(blueprint)}
          disabled={disabled || approving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <X size={13} />
          Reject
        </button>
      </div>
    </div>
  );
}
