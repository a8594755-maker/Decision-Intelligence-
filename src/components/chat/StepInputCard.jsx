/**
 * StepInputCard.jsx — Interactive card for providing input to a blocked step.
 *
 * Displayed when a task step enters `waiting_input` state (e.g., requires
 * a dataset that isn't attached). Allows users to:
 *   1. Select an existing dataset profile
 *   2. Upload a new file (triggers profiling)
 *   3. Skip the step entirely
 *
 * Calls `onProvideInput(input)` or `onSkip()` on user action.
 */

import React, { useState, useRef, useEffect } from 'react';

// ── Icons (inline SVG to avoid extra deps) ──────────────────────────────────

function DatabaseIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  );
}

function UploadIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function AlertTriangleIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CheckIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Loader2Icon({ className }) {
  return (
    <svg className={`${className} animate-spin`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function StepInputCard({
  taskId,
  stepName,
  stepIndex,
  reason = 'dataset_required',
  message,
  datasets = [],
  onProvideInput,
  onSkip,
  disabled = false,
}) {
  const [mode, setMode] = useState('select'); // 'select' | 'upload'
  const [selectedDatasetId, setSelectedDatasetId] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef(null);

  const canSubmit = mode === 'select'
    ? Boolean(selectedDatasetId)
    : Boolean(uploadedFile);

  const handleSubmit = async () => {
    if (!canSubmit || submitting || submitted || disabled) return;
    setSubmitting(true);
    try {
      if (mode === 'select') {
        const dataset = datasets.find(d => d.id === selectedDatasetId);
        await onProvideInput?.({
          datasetProfileId: selectedDatasetId,
          datasetProfileRow: dataset || null,
        });
      } else {
        await onProvideInput?.({
          uploadedFile,
        });
      }
      setSubmitted(true);
    } catch (err) {
      console.error('[StepInputCard] Submit failed:', err);
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (submitting || submitted || disabled) return;
    setSubmitting(true);
    try {
      await onSkip?.();
      setSubmitted(true);
    } catch {
      setSubmitting(false);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) setUploadedFile(file);
  };

  // ── Submitted state ──
  if (submitted) {
    return (
      <div className="w-full rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10 p-4">
        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 text-sm">
          <CheckIcon className="shrink-0" />
          <span className="font-medium">
            {selectedDatasetId ? 'Dataset attached — step resuming.' : 'Step skipped.'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start gap-2">
        <AlertTriangleIcon className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Step Blocked: Input Required
          </div>
          <div className="text-xs text-amber-700/80 dark:text-amber-400/70 mt-0.5">
            Step {stepIndex + 1} &ldquo;{stepName}&rdquo; needs data to continue.
          </div>
          {message && (
            <div className="text-xs text-[var(--text-secondary)] mt-1">
              {message}
            </div>
          )}
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 bg-amber-100/60 dark:bg-amber-900/20 rounded-md p-0.5">
        <button
          type="button"
          onClick={() => setMode('select')}
          disabled={disabled || submitting}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            mode === 'select'
              ? 'bg-[var(--surface-card)] text-amber-800 dark:text-amber-200 shadow-sm'
              : 'text-amber-700/70 dark:text-amber-400/60 hover:text-amber-800 dark:hover:text-amber-300'
          }`}
        >
          <DatabaseIcon className="shrink-0" />
          Choose Dataset
        </button>
        <button
          type="button"
          onClick={() => setMode('upload')}
          disabled={disabled || submitting}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            mode === 'upload'
              ? 'bg-[var(--surface-card)] text-amber-800 dark:text-amber-200 shadow-sm'
              : 'text-amber-700/70 dark:text-amber-400/60 hover:text-amber-800 dark:hover:text-amber-300'
          }`}
        >
          <UploadIcon className="shrink-0" />
          Upload File
        </button>
      </div>

      {/* Content area */}
      {mode === 'select' ? (
        <div className="space-y-1.5">
          {datasets.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] italic py-2 text-center">
              No datasets available. Upload a file instead.
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1 rounded-md border border-amber-200/60 dark:border-amber-700/40 bg-white/60 dark:bg-slate-800/40 p-1.5">
              {datasets.map((ds) => (
                <button
                  key={ds.id}
                  type="button"
                  onClick={() => setSelectedDatasetId(ds.id)}
                  disabled={disabled || submitting}
                  className={`w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors flex items-center gap-2 ${
                    selectedDatasetId === ds.id
                      ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-300 dark:ring-indigo-600'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-700/40 text-[var(--text-secondary)]'
                  }`}
                >
                  <DatabaseIcon className="shrink-0 text-slate-400" />
                  <span className="truncate font-medium">{ds.label || ds.file_name || ds.id}</span>
                  {selectedDatasetId === ds.id && (
                    <CheckIcon className="ml-auto shrink-0 text-[var(--brand-600)]" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.tsv,.json"
            onChange={handleFileChange}
            disabled={disabled || submitting}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || submitting}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-md border-2 border-dashed border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 text-xs hover:bg-amber-100/40 dark:hover:bg-amber-900/30 transition-colors"
          >
            <UploadIcon className="shrink-0" />
            {uploadedFile ? uploadedFile.name : 'Click to select a file (.xlsx, .csv, .json)'}
          </button>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={handleSkip}
          disabled={disabled || submitting}
          className="text-xs text-[var(--text-muted)] hover:text-slate-700 dark:hover:text-slate-300 underline underline-offset-2 transition-colors"
        >
          Skip this step
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || disabled || submitting}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
            canSubmit && !disabled && !submitting
              ? 'bg-[var(--brand-600)] text-white hover:bg-indigo-700 shadow-sm hover:shadow-md'
              : 'bg-[var(--surface-subtle)] text-[var(--text-muted)] cursor-not-allowed'
          }`}
        >
          {submitting ? (
            <>
              <Loader2Icon className="shrink-0" />
              Resuming...
            </>
          ) : (
            'Continue'
          )}
        </button>
      </div>
    </div>
  );
}
