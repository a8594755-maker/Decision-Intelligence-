// @product: ai-employee
//
// ExemplarUploadPanel.jsx — Bulk upload & auto-learn panel.
// Flow: Drop files → auto-detect doc types → one-click "Upload & Learn" → done.
// No manual metadata tagging per file. System infers everything.

import React, { useState, useRef, useMemo } from 'react';
import {
  Upload, X, FileText, FileSpreadsheet, CheckCircle2,
  AlertTriangle, Trash2, Sparkles, Loader2, FolderOpen,
  Zap, Eye, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  runOnboarding,
} from '../../services/aiEmployee/styleLearning';

const ACCEPTED_TYPES = [
  '.xlsx', '.xls', '.csv',
  '.docx', '.doc', '.pdf',
  '.pptx', '.ppt',
];

// ── Auto-detect doc type from filename ──────────────────────
function inferDocType(filename) {
  const name = filename.toLowerCase();
  if (/mbr|monthly.?business.?review|月報|月會/i.test(name)) return { type: 'excel_mbr', label: 'MBR Report' };
  if (/weekly|週報|周報|week/i.test(name)) return { type: 'weekly_ops', label: 'Weekly Ops' };
  if (/qbr|quarterly|季報|季度/i.test(name)) return { type: 'qbr_deck', label: 'QBR Deck' };
  if (/risk|風險/i.test(name)) return { type: 'risk_report', label: 'Risk Report' };
  if (/forecast|預測|demand/i.test(name)) return { type: 'forecast_report', label: 'Forecast' };
  if (/email|mail|摘要|update/i.test(name)) return { type: 'manager_email', label: 'Email Update' };
  if (/kpi|dashboard|儀表/i.test(name)) return { type: 'excel_mbr', label: 'KPI Dashboard' };
  if (/summary|總覽|report|報告|analysis|分析/i.test(name)) return { type: 'general_report', label: 'Report' };
  // Can't tell from filename → will classify from sheet content during learning
  return { type: 'auto', label: 'By content' };
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ['xlsx', 'xls', 'csv'].includes(ext) ? FileSpreadsheet : FileText;
}

function formatSize(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Phases ──────────────────────────────────────────────────
const PHASE = {
  SELECT:   'select',
  LEARNING: 'learning',
  DONE:     'done',
};

export default function ExemplarUploadPanel({ onClose, onUploaded }) {
  const [files, setFiles] = useState([]);  // { file, inferred }
  const [phase, setPhase] = useState(PHASE.SELECT);
  const [progress, setProgress] = useState({ stage: '', detail: '', pct: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const inputRef = useRef(null);

  // ── File handling ─────────────────────────────────────────
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileSelect = (e) => {
    addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const addFiles = (newFiles) => {
    const valid = newFiles
      .filter(f => {
        const ext = '.' + f.name.split('.').pop().toLowerCase();
        return ACCEPTED_TYPES.includes(ext);
      })
      .map(f => ({ file: f, inferred: inferDocType(f.name) }));
    setFiles(prev => [...prev, ...valid]);
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => setFiles([]);

  // ── Stats ─────────────────────────────────────────────────
  const stats = useMemo(() => {
    const byType = {};
    for (const { inferred } of files) {
      byType[inferred.label] = (byType[inferred.label] || 0) + 1;
    }
    const totalSize = files.reduce((s, f) => s + f.file.size, 0);
    return { byType, totalSize };
  }, [files]);

  // ── One-click learn ───────────────────────────────────────
  const handleLearn = async () => {
    if (files.length === 0) return;
    setPhase(PHASE.LEARNING);
    setError(null);

    const _stages = ['Reading files', 'Extracting structure', 'Analyzing style', 'Building profile', 'Computing metrics'];
    let stageIdx = 0;

    try {
      // Read all file buffers
      setProgress({ stage: 'Reading files...', detail: `0/${files.length}`, pct: 5 });

      const bulkFiles = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const buffer = await f.file.arrayBuffer();
        bulkFiles.push({ buffer, filename: f.file.name });
        setProgress({
          stage: 'Reading files...',
          detail: `${i + 1}/${files.length}`,
          pct: 5 + Math.round((i / files.length) * 15),
        });
      }

      // Call onboarding pipeline with bulk files
      setProgress({ stage: 'Running learning pipeline...', detail: 'Extracting style patterns', pct: 25 });

      const onboardingResult = await runOnboarding({
        employeeId: 'default',
        teamId: 'default',
        inputs: {
          bulkFiles,
        },
        onProgress: (stage, detail) => {
          stageIdx++;
          const pct = Math.min(25 + Math.round((stageIdx / 6) * 70), 95);
          setProgress({
            stage: detail || stage,
            detail: `Stage ${Math.min(stageIdx, 5)}/5`,
            pct,
          });
        },
      });

      setProgress({ stage: 'Complete!', detail: '', pct: 100 });
      setResult(onboardingResult);
      setPhase(PHASE.DONE);

      if (onUploaded) {
        setTimeout(() => onUploaded(), 2000);
      }
    } catch (err) {
      setError(err.message);
      setPhase(PHASE.SELECT);
    }
  };

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 50, padding: 16,
    }}>
      <div style={{
        width: '100%', maxWidth: 600,
        background: 'var(--surface-card)',
        borderRadius: 14, boxShadow: 'var(--shadow-float)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '16px 20px', borderBottom: '1px solid var(--border-default)',
        }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              {phase === PHASE.DONE ? 'Learning Complete' : 'Bulk Upload & Learn'}
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 0' }}>
              {phase === PHASE.SELECT && 'Drop all company files — doc types are auto-detected'}
              {phase === PHASE.LEARNING && 'Learning style patterns from your files...'}
              {phase === PHASE.DONE && 'Output profiles have been created from your files'}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={phase === PHASE.LEARNING}
            style={{
              background: 'none', border: 'none',
              cursor: phase === PHASE.LEARNING ? 'not-allowed' : 'pointer',
              padding: 4, color: 'var(--text-secondary)',
              opacity: phase === PHASE.LEARNING ? 0.4 : 1,
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px' }}>
          {/* ── SELECT PHASE ── */}
          {phase === PHASE.SELECT && (
            <>
              {/* Drop zone */}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? '#6366f1' : 'var(--border-default)'}`,
                  borderRadius: 10,
                  padding: files.length > 0 ? '16px 20px' : '36px 20px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragOver ? '#eef2ff' : 'transparent',
                  transition: 'all 0.2s ease',
                  marginBottom: 12,
                }}
              >
                <Upload size={files.length > 0 ? 18 : 28} style={{ color: dragOver ? '#6366f1' : '#999', margin: '0 auto 6px', display: 'block' }} />
                <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                  {files.length > 0 ? 'Add more files' : 'Drop all company deliverables here'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  Excel, Word, PDF, PPT — doc types auto-detected from filenames
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={ACCEPTED_TYPES.join(',')}
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                  // webkitdirectory for folder upload
                />
              </div>

              {/* File list with auto-detected types */}
              {files.length > 0 && (
                <>
                  {/* Summary bar */}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    marginBottom: 8,
                  }}>
                    <button
                      onClick={() => setShowFiles(!showFiles)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', padding: 0,
                      }}
                    >
                      {showFiles ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {files.length} files ({formatSize(stats.totalSize)})
                    </button>
                    <button
                      onClick={clearAll}
                      style={{
                        fontSize: 11, color: '#ef4444', background: 'none', border: 'none',
                        cursor: 'pointer', padding: '2px 6px',
                      }}
                    >
                      Clear all
                    </button>
                  </div>

                  {/* Auto-detected type badges */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    {Object.entries(stats.byType).map(([label, count]) => (
                      <span
                        key={label}
                        title={label === 'By content' ? 'These files will be classified by sheet names & KPI keywords during learning' : `Detected from filename`}
                        style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 12,
                          background: label === 'By content' ? '#fef3c7' : '#eef2ff',
                          color: label === 'By content' ? '#92400e' : '#4338ca',
                          fontWeight: 500,
                        }}
                      >
                        {label} ({count}){label === 'By content' && ' — will scan sheets'}
                      </span>
                    ))}
                  </div>

                  {/* File list (collapsible) */}
                  {showFiles && (
                    <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
                      {files.map((f, i) => {
                        const FileIcon = fileIcon(f.file.name);
                        return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '5px 8px', borderRadius: 6,
                            marginBottom: 1,
                          }}>
                            <FileIcon size={13} style={{ color: '#6366f1', flexShrink: 0 }} />
                            <span style={{
                              flex: 1, fontSize: 11, color: 'var(--text-primary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {f.file.name}
                            </span>
                            <span
                              title={f.inferred.type === 'auto' ? 'Will classify from sheet content' : 'Detected from filename'}
                              style={{
                                fontSize: 9, padding: '1px 6px', borderRadius: 6,
                                background: f.inferred.type === 'auto' ? '#fef3c7' : '#dbeafe',
                                color: f.inferred.type === 'auto' ? '#92400e' : '#1e40af',
                                flexShrink: 0,
                              }}
                            >
                              {f.inferred.label}
                            </span>
                            <span style={{ fontSize: 9, color: '#999', flexShrink: 0 }}>
                              {formatSize(f.file.size)}
                            </span>
                            <button
                              onClick={() => removeFile(i)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#ccc' }}
                            >
                              <X size={11} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Error */}
              {error && (
                <div style={{
                  padding: '8px 12px', borderRadius: 6,
                  background: '#fef2f2', color: '#991b1b', fontSize: 12,
                  marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <AlertTriangle size={14} /> {error}
                </div>
              )}
            </>
          )}

          {/* ── LEARNING PHASE ── */}
          {phase === PHASE.LEARNING && (
            <div style={{ padding: '20px 0' }}>
              {/* Progress bar */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {progress.stage}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {progress.detail}
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: '#e5e7eb', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 4,
                    width: `${progress.pct}%`,
                    background: 'linear-gradient(90deg, #6366f1, #10b981)',
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              </div>

              {/* Animated indicator */}
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{ animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>
                  <Loader2 size={32} style={{ color: '#6366f1' }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                  Processing {files.length} files — extracting structure, formatting, KPI patterns, text style...
                </div>
              </div>

              <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* ── DONE PHASE ── */}
          {phase === PHASE.DONE && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{
                width: 56, height: 56, borderRadius: 16,
                background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 12px',
              }}>
                <CheckCircle2 size={28} style={{ color: '#10b981' }} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                Learned from {files.length} files
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
                {result?.profileCreated
                  ? 'Output profiles have been created. Check the Profiles tab.'
                  : 'Style patterns extracted. Run the full pipeline to generate profiles.'}
              </div>

              {/* Stats */}
              {result && (
                <div style={{
                  display: 'inline-flex', gap: 16,
                  padding: '10px 20px', borderRadius: 8,
                  background: '#f0fdf4', fontSize: 12,
                }}>
                  {result.policiesCreated > 0 && (
                    <span><strong>{result.policiesCreated}</strong> policies</span>
                  )}
                  {result.exemplarsCreated > 0 && (
                    <span><strong>{result.exemplarsCreated}</strong> exemplars</span>
                  )}
                  {result.profileCreated && <span>Profile created</span>}
                  {result.rulesExtracted > 0 && (
                    <span><strong>{result.rulesExtracted}</strong> rules</span>
                  )}
                  {result.errors?.length > 0 && (
                    <span style={{ color: '#f59e0b' }}>{result.errors.length} warnings</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '12px 20px', borderTop: '1px solid var(--border-default)',
        }}>
          {phase === PHASE.SELECT && (
            <>
              <button
                onClick={onClose}
                style={{
                  padding: '8px 16px', borderRadius: 8,
                  border: '1px solid var(--border-default)', background: 'var(--surface-card)',
                  fontSize: 13, cursor: 'pointer', color: 'var(--text-primary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleLearn}
                disabled={files.length === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 18px', borderRadius: 8,
                  border: 'none',
                  background: files.length === 0 ? '#a5b4fc' : '#4f46e5',
                  color: '#fff', fontSize: 13, fontWeight: 600,
                  cursor: files.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                <Zap size={14} />
                Upload & Learn ({files.length} files)
              </button>
            </>
          )}
          {phase === PHASE.DONE && (
            <button
              onClick={onClose}
              style={{
                padding: '8px 18px', borderRadius: 8,
                border: 'none', background: '#4f46e5', color: '#fff',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
