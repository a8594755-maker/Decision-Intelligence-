/**
 * DataImportPanel - 4-step import wizard for the Settings page.
 * Reuses the one-shot import pipeline (generateSheetPlans / importWorkbookSheets).
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, FileSpreadsheet, Loader2, CheckCircle, AlertCircle,
  X, ArrowRight, ArrowLeft, RefreshCw, Clock, ChevronDown, Eye,
} from 'lucide-react';
import { Card, Button, Badge } from './ui';
import { useAuth } from '../contexts/AuthContext';
import {
  generateSheetPlans,
  importWorkbookSheets,
  validateSheetPlans,
} from '../services/oneShotImportService';
import { importBatchesService } from '../services/importHistoryService';
import { loadSampleWorkbook } from '../services/sampleDataService';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import MappingReviewPanel from './MappingReviewPanel';
import { saveMappingProfile, generateHeaderFingerprint } from '../services/mappingProfileService';

const UPLOAD_TYPE_OPTIONS = Object.keys(UPLOAD_SCHEMAS);

/* ───────────── Step 1: File Upload ───────────── */
function FileDropZone({ onFileLoaded, onLoadSample, loading }) {
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
    <div className="space-y-4">
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

      {onLoadSample && (
        <div className="text-center">
          <button
            onClick={onLoadSample}
            disabled={loading}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            Or load sample data to try the platform
          </button>
        </div>
      )}
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

/* ───────────── Pre-validation helper ───────────── */
function preValidateSheets(workbook, sheetPlans) {
  const results = [];
  for (const plan of sheetPlans) {
    if (!plan.enabled || !plan.suggestedType) continue;
    const ws = workbook.Sheets[plan.sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const sampleRows = rows.slice(0, 5);
    const schema = UPLOAD_SCHEMAS[plan.suggestedType];
    const requiredFields = schema?.required_fields || [];
    const mapping = plan.mappingFinal || plan.mappingDraft || {};
    const reversedMapping = {};
    for (const [srcCol, tgtField] of Object.entries(mapping)) {
      reversedMapping[tgtField] = srcCol;
    }

    // Check for bad rows (missing required mapped fields)
    const badRows = [];
    rows.forEach((row, idx) => {
      const missing = [];
      for (const field of requiredFields) {
        const srcCol = reversedMapping[field];
        if (srcCol && (row[srcCol] === '' || row[srcCol] == null)) {
          missing.push(field);
        }
      }
      if (missing.length > 0) {
        badRows.push({ rowIndex: idx + 2, missing }); // +2 for 1-indexed + header
      }
    });

    // Duplicate detection using composite key of required fields
    const seen = new Set();
    let duplicateCount = 0;
    for (const row of rows) {
      const keyParts = requiredFields.map(f => {
        const srcCol = reversedMapping[f];
        return srcCol ? String(row[srcCol] ?? '') : '';
      });
      const key = keyParts.join('|');
      if (seen.has(key)) duplicateCount++;
      else seen.add(key);
    }

    results.push({
      sheetName: plan.sheetName,
      uploadType: plan.suggestedType,
      totalRows: rows.length,
      sampleRows,
      headers: Object.keys(rows[0] || {}),
      badRowCount: badRows.length,
      badRowSample: badRows.slice(0, 10),
      duplicateCount,
      totalValid: rows.length - badRows.length,
    });
  }
  return results;
}

/* ───────────── Step 2.5: Validation Preview ───────────── */
function ValidationPreview({ validationResults, onConfirm, onBack }) {
  const [expandedSheet, setExpandedSheet] = useState(null);
  const totalBad = validationResults.reduce((s, r) => s + r.badRowCount, 0);
  const totalDups = validationResults.reduce((s, r) => s + r.duplicateCount, 0);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className={`flex items-center gap-3 p-3 rounded-lg border ${
        totalBad > 0 || totalDups > 0
          ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
          : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800'
      }`}>
        <Eye className="w-5 h-5 text-slate-600 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium">Validation Preview</p>
          <p className="text-xs text-slate-500">
            {validationResults.reduce((s, r) => s + r.totalRows, 0)} total rows
            {totalBad > 0 && ` · ${totalBad} rows with missing fields`}
            {totalDups > 0 && ` · ${totalDups} duplicate keys`}
          </p>
        </div>
      </div>

      {/* Per-sheet details */}
      {validationResults.map((vr) => (
        <div key={vr.sheetName} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedSheet(expandedSheet === vr.sheetName ? null : vr.sheetName)}
            className="w-full flex items-center justify-between p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium">{vr.sheetName}</span>
              <span className="text-xs text-slate-400">{vr.uploadType}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-green-600">{vr.totalValid} valid</span>
              {vr.badRowCount > 0 && <Badge type="warning">{vr.badRowCount} bad</Badge>}
              {vr.duplicateCount > 0 && <Badge type="info">{vr.duplicateCount} dup</Badge>}
              <ChevronDown className={`w-4 h-4 transition-transform ${expandedSheet === vr.sheetName ? 'rotate-180' : ''}`} />
            </div>
          </button>

          {expandedSheet === vr.sheetName && (
            <div className="border-t border-slate-200 dark:border-slate-700 p-3 space-y-3">
              {/* Sample data table */}
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Sample Data (first 5 rows)</p>
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse w-full">
                    <thead>
                      <tr>
                        {vr.headers.slice(0, 8).map(h => (
                          <th key={h} className="px-2 py-1 text-left bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 truncate max-w-[120px]">{h}</th>
                        ))}
                        {vr.headers.length > 8 && <th className="px-2 py-1 bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600">...</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {vr.sampleRows.map((row, i) => (
                        <tr key={i}>
                          {vr.headers.slice(0, 8).map(h => (
                            <td key={h} className="px-2 py-1 border border-slate-200 dark:border-slate-600 truncate max-w-[120px]">{String(row[h] ?? '')}</td>
                          ))}
                          {vr.headers.length > 8 && <td className="px-2 py-1 border border-slate-200 dark:border-slate-600 text-slate-400">...</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bad rows */}
              {vr.badRowSample.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-amber-600 mb-1">Rows with missing required fields</p>
                  <div className="space-y-1">
                    {vr.badRowSample.map((br, i) => (
                      <p key={i} className="text-xs text-slate-500">
                        Row {br.rowIndex}: missing {br.missing.join(', ')}
                      </p>
                    ))}
                    {vr.badRowCount > 10 && (
                      <p className="text-xs text-slate-400">...and {vr.badRowCount - 10} more</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-700">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1.5" />
          Back
        </Button>
        <Button onClick={onConfirm}>
          <ArrowRight className="w-4 h-4 mr-1.5" />
          {totalBad > 0 ? `Import (skip ${totalBad} bad rows)` : 'Proceed with Import'}
        </Button>
      </div>
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
      {progress.substep && (
        <p className="text-xs text-slate-400 text-center mt-1">
          {progress.substep}
        </p>
      )}
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
  const [step, setStep] = useState('upload'); // 'upload' | 'review' | 'mapping_review' | 'preview' | 'importing' | 'result'
  const [mappingReviewSheet, setMappingReviewSheet] = useState(null); // sheet index needing review
  const [workbook, setWorkbook] = useState(null);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [fileLastModified, setFileLastModified] = useState(0);
  const [sheetPlans, setSheetPlans] = useState([]);
  const [classifying, setClassifying] = useState(false);
  const [progress, setProgress] = useState({ current: 0, sheetName: '' });
  const [importReport, setImportReport] = useState(null);
  const [validationResults, setValidationResults] = useState([]);
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

  /* ── Load sample data ── */
  const handleLoadSample = useCallback(async () => {
    setClassifying(true);
    try {
      const { workbook: wb, fileName: name, fileSize: size } = await loadSampleWorkbook();
      handleFileLoaded(wb, name, size, Date.now());
    } catch (err) {
      addNotification?.(`Failed to load sample data: ${err.message}`, 'error');
      setClassifying(false);
    }
  }, [handleFileLoaded, addNotification]);

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

  /* ── Check if any sheet needs mapping review ── */
  const sheetsNeedingReview = useMemo(() => {
    return sheetPlans
      .map((p, idx) => ({ ...p, idx }))
      .filter(p => p.enabled && p.suggestedType && p.mappingMeta)
      .filter(p => {
        const meta = p.mappingMeta || {};
        return Object.values(meta).some(m => m.confidence < 0.85);
      });
  }, [sheetPlans]);

  /* ── Step 2 → 2.5 (or mapping review): validate and preview ── */
  const handlePreview = () => {
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
    // If any sheets need mapping review, show review first
    if (sheetsNeedingReview.length > 0) {
      setMappingReviewSheet(sheetsNeedingReview[0].idx);
      setStep('mapping_review');
      return;
    }
    const results = preValidateSheets(workbook, sheetPlans);
    setValidationResults(results);
    setStep('preview');
  };

  /* ── Mapping review handlers ── */
  const handleMappingAccept = useCallback((updatedMapping) => {
    if (mappingReviewSheet !== null) {
      setSheetPlans(prev => prev.map((p, i) =>
        i === mappingReviewSheet ? { ...p, mappingDraft: updatedMapping, mappingFinal: updatedMapping, mappingConfirmed: true } : p
      ));
    }
    // Check if more sheets need review
    const nextSheet = sheetsNeedingReview.find(s => s.idx !== mappingReviewSheet);
    if (nextSheet) {
      setMappingReviewSheet(nextSheet.idx);
    } else {
      // All reviewed — proceed to validation preview
      setMappingReviewSheet(null);
      const results = preValidateSheets(workbook, sheetPlans);
      setValidationResults(results);
      setStep('preview');
    }
  }, [mappingReviewSheet, sheetsNeedingReview, workbook, sheetPlans]);

  /* ── Step 2.5 → 3: start import ── */
  const handleStartImport = async () => {
    const enabledCount = sheetPlans.filter(p => p.enabled && p.suggestedType).length;
    if (enabledCount === 0) return;

    setStep('importing');
    setProgress({ current: 0, sheetName: '', substep: '' });
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
          onProgress: ({ stage, current, total, sheetName, substep }) => {
            setProgress(prev => ({
              ...prev,
              current: current ?? prev.current,
              sheetName: sheetName ?? prev.sheetName,
              substep: stage === 'substep' ? substep : prev.substep,
            }));
          },
        },
      });
      setImportReport(report);
      setStep('result');
      addNotification?.(
        `Import complete: ${report.succeededSheets} succeeded, ${report.failedSheets} failed`,
        report.failedSheets > 0 ? 'error' : 'success'
      );

      // Save mapping profiles for successfully imported sheets (fire-and-forget)
      for (const plan of sheetPlans) {
        if (plan.enabled && plan.suggestedType && plan.mappingFinal && plan.headers) {
          saveMappingProfile({
            userId: user?.id,
            sourceFingerprint: generateHeaderFingerprint(plan.headers),
            uploadType: plan.suggestedType,
            columnMapping: plan.mappingFinal,
            fieldConfidence: plan.mappingMeta || null,
          }).catch(() => {}); // Silent failure
        }
      }
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
    setProgress({ current: 0, sheetName: '', substep: '' });
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
            {step === 'mapping_review' && 'Column Mapping Review'}
            {step === 'preview' && 'Validation Preview'}
            {step === 'importing' && 'Importing...'}
            {step === 'result' && 'Import Results'}
          </h3>
        </div>

        {/* Step content */}
        {step === 'upload' && (
          <FileDropZone onFileLoaded={handleFileLoaded} onLoadSample={handleLoadSample} loading={classifying} />
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
                <Button onClick={handlePreview} disabled={enabledCount === 0}>
                  <Eye className="w-4 h-4 mr-1.5" />
                  Preview & Validate
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'mapping_review' && mappingReviewSheet !== null && sheetPlans[mappingReviewSheet] && (
          <div className="space-y-4">
            <MappingReviewPanel
              sheetName={sheetPlans[mappingReviewSheet].sheetName}
              uploadType={sheetPlans[mappingReviewSheet].suggestedType}
              columnMapping={sheetPlans[mappingReviewSheet].mappingDraft || {}}
              mappingMeta={sheetPlans[mappingReviewSheet].mappingMeta || {}}
              sampleRows={sheetPlans[mappingReviewSheet].sampleRows || []}
              schemaFields={UPLOAD_SCHEMAS[sheetPlans[mappingReviewSheet].suggestedType]?.fields || []}
              sourceHeaders={sheetPlans[mappingReviewSheet].headers || []}
              onMappingChange={(updated) => {
                setSheetPlans(prev => prev.map((p, i) =>
                  i === mappingReviewSheet ? { ...p, mappingDraft: updated } : p
                ));
              }}
              onAcceptAll={handleMappingAccept}
            />
            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-700">
              <Button variant="outline" onClick={() => setStep('review')}>
                <ArrowLeft className="w-4 h-4 mr-1.5" />
                Back
              </Button>
              <span className="text-xs text-slate-400">
                {sheetsNeedingReview.length} sheet(s) need review
              </span>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <ValidationPreview
            validationResults={validationResults}
            onConfirm={handleStartImport}
            onBack={() => setStep('review')}
          />
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
