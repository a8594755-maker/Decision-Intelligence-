/**
 * DataImportPanel - 4-step import wizard for the Settings page.
 * Reuses the one-shot import pipeline (generateSheetPlans / importWorkbookSheets).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, FileSpreadsheet, Loader2, CheckCircle, AlertCircle,
  X, ArrowRight, ArrowLeft, RefreshCw, Clock, ChevronDown,
} from 'lucide-react';
import { Card, Button, Badge } from './ui';
import { useAuth } from '../contexts/AuthContext';
import {
  generateSheetPlans,
  importWorkbookSheets,
  validateSheetPlans,
} from '../services/oneShotImportService';
import { importBatchesService } from '../services/importHistoryService';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';

const UPLOAD_TYPE_OPTIONS = Object.keys(UPLOAD_SCHEMAS);

/* ───────────── Step 1: File Upload ───────────── */
function FileDropZone({ onFileLoaded, loading }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        onFileLoaded(wb, file.name, file.size, file.lastModified);
      } catch (err) {
        console.error('[DataImport] Failed to parse file:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [onFileLoaded]);

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer
        ${dragOver
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
          : 'border-slate-300 dark:border-slate-600 hover:border-blue-300 dark:hover:border-blue-600'}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
      onClick={() => inputRef.current?.click()}
    >
      {loading ? (
        <Loader2 className="w-10 h-10 text-blue-500 mx-auto mb-3 animate-spin" />
      ) : (
        <Upload className="w-10 h-10 text-slate-400 mx-auto mb-3" />
      )}
      <p className="text-sm font-medium mb-1">
        {loading ? 'Analyzing file...' : 'Drop an Excel or CSV file here'}
      </p>
      <p className="text-xs text-slate-400">Supported: .xlsx, .xls, .csv</p>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  );
}

/* ───────────── Step 2: Sheet Review ───────────── */
function SheetReviewList({ plans, onToggle, onTypeChange }) {
  return (
    <div className="space-y-3">
      {plans.map((plan, idx) => (
        <div
          key={plan.sheetId}
          className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
            plan.enabled
              ? 'border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10'
              : 'border-slate-200 dark:border-slate-700 opacity-60'
          }`}
        >
          {/* Enable checkbox */}
          <input
            type="checkbox"
            checked={plan.enabled}
            onChange={() => onToggle(idx)}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />

          {/* Sheet info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <span className="text-sm font-medium truncate">{plan.sheetName}</span>
              <span className="text-xs text-slate-400">{plan.rowCount} rows</span>
            </div>
            {plan.disabledReason && (
              <p className="text-xs text-slate-400 mt-0.5 ml-6">{plan.disabledReason}</p>
            )}
          </div>

          {/* Confidence */}
          <Badge type={plan.confidence >= 70 ? 'success' : plan.confidence >= 40 ? 'warning' : 'error'}>
            {plan.confidence}%
          </Badge>

          {/* Type selector */}
          <select
            value={plan.suggestedType || ''}
            onChange={(e) => onTypeChange(idx, e.target.value || null)}
            className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-transparent dark:bg-slate-800 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            <option value="">-- Select type --</option>
            {UPLOAD_TYPE_OPTIONS.map(t => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

/* ───────────── Step 3: Import Progress ───────────── */
function ImportProgress({ progress, total }) {
  const pct = total > 0 ? Math.round((progress.current / total) * 100) : 0;
  return (
    <div className="py-8">
      <div className="flex items-center justify-center mb-6">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
      <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 mb-3">
        <div
          className="bg-blue-600 h-2 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-sm text-slate-500 text-center">
        Importing sheet {progress.current}/{total}
        {progress.sheetName && `: ${progress.sheetName}`}
      </p>
    </div>
  );
}

/* ───────────── Step 4: Result Report ───────────── */
function ImportReport({ report, onReset }) {
  const STATUS_STYLES = {
    IMPORTED: 'success',
    SKIPPED: 'info',
    FAILED: 'error',
    NEEDS_REVIEW: 'warning',
    ABORTED: 'error',
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-3 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
        <CheckCircle className="w-6 h-6 text-emerald-600 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium">Import Complete</p>
          <p className="text-xs text-slate-500">
            {report.succeededSheets} succeeded, {report.failedSheets} failed, {report.skippedSheets} skipped
          </p>
        </div>
      </div>

      {/* Per-sheet results */}
      <div className="space-y-2">
        {report.sheetReports?.map((sr, i) => (
          <div key={i} className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 min-w-0">
              <FileSpreadsheet className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <span className="text-sm truncate">{sr.sheetName}</span>
              <span className="text-xs text-slate-400">{sr.uploadType}</span>
            </div>
            <div className="flex items-center gap-2">
              {sr.savedCount != null && (
                <span className="text-xs text-slate-500">{sr.savedCount} rows</span>
              )}
              <Badge type={STATUS_STYLES[sr.status] || 'info'}>{sr.status}</Badge>
            </div>
          </div>
        ))}
      </div>

      {/* Reset button */}
      <div className="flex justify-center pt-2">
        <Button variant="outline" onClick={onReset}>
          <RefreshCw className="w-4 h-4 mr-1.5" />
          Import Another File
        </Button>
      </div>
    </div>
  );
}

/* ───────────── Recent Import History ───────────── */
function ImportHistory({ userId }) {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    importBatchesService.getAllBatches(userId, { limit: 10 })
      .then(setBatches)
      .catch(() => setBatches([]))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (batches.length === 0) {
    return (
      <p className="text-sm text-slate-400 text-center py-4">No import history yet.</p>
    );
  }

  return (
    <div className="divide-y divide-slate-100 dark:divide-slate-800">
      {batches.map((b) => (
        <div key={b.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileSpreadsheet className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <span className="text-sm truncate">{b.file_name || b.upload_type}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">{b.row_count ?? '—'} rows</span>
            <Badge type={b.status === 'completed' ? 'success' : b.status === 'failed' ? 'error' : 'info'}>
              {b.status}
            </Badge>
            <span className="text-xs text-slate-400 hidden sm:inline">
              {b.created_at ? new Date(b.created_at).toLocaleDateString() : ''}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════ Main Panel ═══════════════ */
export default function DataImportPanel() {
  const { user, addNotification } = useAuth();
  const [step, setStep] = useState('upload'); // 'upload' | 'review' | 'importing' | 'result'
  const [workbook, setWorkbook] = useState(null);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [fileLastModified, setFileLastModified] = useState(0);
  const [sheetPlans, setSheetPlans] = useState([]);
  const [classifying, setClassifying] = useState(false);
  const [progress, setProgress] = useState({ current: 0, sheetName: '' });
  const [importReport, setImportReport] = useState(null);
  const abortRef = useRef(null);

  /* ── Step 1 → 2: file loaded, classify sheets ── */
  const handleFileLoaded = useCallback((wb, name, size, lastModified) => {
    setClassifying(true);
    setWorkbook(wb);
    setFileName(name);
    setFileSize(size);
    setFileLastModified(lastModified);

    try {
      const plans = generateSheetPlans(wb, name, size, lastModified);
      // Auto-confirm mappings where classification is complete
      const confirmedPlans = plans.map(p => {
        if (p.isComplete && p.mappingDraft && p.suggestedType) {
          return { ...p, mappingFinal: p.mappingDraft, mappingConfirmed: true };
        }
        return p;
      });
      setSheetPlans(confirmedPlans);
      setStep('review');
    } catch (err) {
      addNotification?.(`Failed to analyze file: ${err.message}`, 'error');
    } finally {
      setClassifying(false);
    }
  }, [addNotification]);

  /* ── Sheet toggles ── */
  const handleToggle = (idx) => {
    setSheetPlans(prev => prev.map((p, i) =>
      i === idx ? { ...p, enabled: !p.enabled } : p
    ));
  };

  const handleTypeChange = (idx, newType) => {
    setSheetPlans(prev => prev.map((p, i) => {
      if (i !== idx) return p;
      return { ...p, suggestedType: newType, uploadType: newType };
    }));
  };

  /* ── Step 2 → 3: start import ── */
  const handleStartImport = async () => {
    const validation = validateSheetPlans(sheetPlans);
    if (!validation.valid) {
      addNotification?.(validation.errors.join('; '), 'error');
      return;
    }

    const enabledCount = sheetPlans.filter(p => p.enabled && p.suggestedType).length;
    if (enabledCount === 0) {
      addNotification?.('No sheets enabled for import', 'error');
      return;
    }

    setStep('importing');
    setProgress({ current: 0, sheetName: '' });
    abortRef.current = new AbortController();

    try {
      const report = await importWorkbookSheets({
        userId: user?.id,
        workbook,
        fileName,
        sheetPlans,
        options: {
          mode: 'best-effort',
          signal: abortRef.current.signal,
          onProgress: ({ stage, current, total, sheetName }) => {
            setProgress({ current, sheetName });
          },
        },
      });
      setImportReport(report);
      setStep('result');
      addNotification?.(
        `Import complete: ${report.succeededSheets} succeeded, ${report.failedSheets} failed`,
        report.failedSheets > 0 ? 'error' : 'success'
      );
    } catch (err) {
      addNotification?.(`Import failed: ${err.message}`, 'error');
      setStep('review');
    }
  };

  /* ── Reset to start ── */
  const handleReset = () => {
    setStep('upload');
    setWorkbook(null);
    setFileName('');
    setSheetPlans([]);
    setImportReport(null);
    setProgress({ current: 0, sheetName: '' });
  };

  const enabledCount = sheetPlans.filter(p => p.enabled && p.suggestedType).length;

  return (
    <div className="space-y-6">
      {/* Import Wizard */}
      <Card>
        {/* Step header */}
        <div className="flex items-center gap-2 mb-4">
          <Upload className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold">
            {step === 'upload' && 'Upload Data File'}
            {step === 'review' && `Review Sheets — ${fileName}`}
            {step === 'importing' && 'Importing...'}
            {step === 'result' && 'Import Results'}
          </h3>
        </div>

        {/* Step content */}
        {step === 'upload' && (
          <FileDropZone onFileLoaded={handleFileLoaded} loading={classifying} />
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <SheetReviewList
              plans={sheetPlans}
              onToggle={handleToggle}
              onTypeChange={handleTypeChange}
            />
            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-700">
              <Button variant="outline" onClick={handleReset}>
                <ArrowLeft className="w-4 h-4 mr-1.5" />
                Back
              </Button>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">{enabledCount} sheet(s) selected</span>
                <Button onClick={handleStartImport} disabled={enabledCount === 0}>
                  <ArrowRight className="w-4 h-4 mr-1.5" />
                  Start Import
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'importing' && (
          <ImportProgress progress={progress} total={enabledCount} />
        )}

        {step === 'result' && importReport && (
          <ImportReport report={importReport} onReset={handleReset} />
        )}
      </Card>

      {/* Import History */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-slate-400" />
          <h3 className="font-semibold text-sm">Recent Imports</h3>
        </div>
        <ImportHistory userId={user?.id} />
      </Card>
    </div>
  );
}
