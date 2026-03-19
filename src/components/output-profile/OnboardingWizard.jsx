// @product: ai-employee
//
// OnboardingWizard.jsx — Learning pipeline progress wizard.
// Design reference: Templafy's step-by-step workflow + Frontify's progressive brand setup.
// Shows 6 onboarding stages with real-time progress, status indicators, and log output.

import React, { useState, useEffect, useRef } from 'react';
import {
  X, Play, CheckCircle2, Clock, AlertTriangle, Loader2,
  FileText, BookOpen, Paintbrush, MessageSquare, BarChart3, Sparkles,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  runOnboarding,
  ONBOARDING_STAGES,
} from '../../services/aiEmployee/styleLearning';

const STAGE_META = {
  policies:  { icon: FileText,       color: '#6366f1', label: 'Policy Ingestion',   desc: 'Import company handbook, glossary, naming rules' },
  exemplars: { icon: BookOpen,       color: '#0ea5e9', label: 'Exemplar Ingestion',  desc: 'Process approved deliverables into style samples' },
  bulk_style:{ icon: Paintbrush,     color: '#10b981', label: 'Style Extraction',    desc: 'Extract structure, formatting, KPI patterns' },
  feedback:  { icon: MessageSquare,  color: '#f59e0b', label: 'Feedback Learning',   desc: 'Mine rules from past manager reviews' },
  metrics:   { icon: BarChart3,      color: '#8b5cf6', label: 'Trust Metrics',       desc: 'Compute confidence, first-pass rate, autonomy' },
  profile:   { icon: Sparkles,       color: '#ec4899', label: 'Profile Synthesis',   desc: 'Compile canonical output profile from all signals' },
};

// Display stages in pipeline order (ONBOARDING_STAGES is an object of status strings, not the display list)
const STAGES = ['policies', 'exemplars', 'bulk_style', 'feedback', 'metrics', 'profile'];

export default function OnboardingWizard({ employeeId, asModal = false, onClose, onComplete }) {
  const [running, setRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState(null);
  const [completedStages, setCompletedStages] = useState([]);
  const [failedStage, setFailedStage] = useState(null);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const logsEndRef = useRef(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (message, type = 'info') => {
    setLogs(prev => [...prev, { message, type, time: new Date().toLocaleTimeString() }]);
  };

  const handleRun = async () => {
    setRunning(true);
    setCompletedStages([]);
    setFailedStage(null);
    setLogs([]);
    setResult(null);

    addLog('Starting learning pipeline...', 'info');

    try {
      if (!employeeId) {
        throw new Error('No worker ID. Please wait for authentication to complete.');
      }

      // Map onboarding stages to wizard stages
      const stageMapping = {
        [ONBOARDING_STAGES.POLICIES]: 'policies',
        [ONBOARDING_STAGES.EXEMPLARS]: 'exemplars',
        [ONBOARDING_STAGES.BULK_STYLE]: 'bulk_style',
        [ONBOARDING_STAGES.FEEDBACK]: 'feedback',
        [ONBOARDING_STAGES.METRICS]: 'metrics',
        [ONBOARDING_STAGES.COMPLETE]: 'profile',
      };

      // Run onboarding with progress callback
      const onboardingResult = await runOnboarding({
        employeeId,
        teamId: null,
        inputs: {},
        onProgress: (stage, detail) => {
          const wizardStage = stageMapping[stage] || stage;
          if (stage === ONBOARDING_STAGES.COMPLETE) {
            setCompletedStages(STAGES);
            setCurrentStage(null);
            addLog(detail || 'Pipeline complete!', 'success');
          } else {
            // Mark previous stages as completed when moving to a new one
            setCurrentStage(prev => {
              if (prev && prev !== wizardStage) {
                setCompletedStages(cs => cs.includes(prev) ? cs : [...cs, prev]);
              }
              return wizardStage;
            });
            addLog(detail || `Stage: ${wizardStage}`, 'info');
          }
        },
      });

      setResult(onboardingResult);
      addLog('Learning pipeline completed!', 'success');

      if (onComplete) {
        setTimeout(() => onComplete(), 1500);
      }
    } catch (err) {
      addLog(`Pipeline error: ${err.message}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const getStageStatus = (stage) => {
    if (failedStage === stage) return 'failed';
    if (completedStages.includes(stage)) return 'completed';
    if (currentStage === stage) return 'running';
    return 'pending';
  };

  const content = (
    <div>
      {/* Stage Progress — like Templafy's document creation steps */}
      <div style={{ marginBottom: 20 }}>
        {STAGES.map((stage, index) => {
          const meta = STAGE_META[stage] || { icon: Sparkles, color: '#999', label: stage, desc: '' };
          const status = getStageStatus(stage);
          const StageIcon = meta.icon;

          return (
            <div key={stage}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 0',
              }}>
                {/* Status indicator */}
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: status === 'completed' ? '#dcfce7'
                    : status === 'running' ? meta.color + '20'
                    : status === 'failed' ? '#fef2f2'
                    : '#f3f4f6',
                  border: `1.5px solid ${
                    status === 'completed' ? '#10b981'
                    : status === 'running' ? meta.color
                    : status === 'failed' ? '#ef4444'
                    : '#e5e7eb'
                  }`,
                  flexShrink: 0,
                  transition: 'all 0.3s ease',
                }}>
                  {status === 'completed' ? (
                    <CheckCircle2 size={16} style={{ color: '#10b981' }} />
                  ) : status === 'running' ? (
                    <div style={{ animation: 'spin 1s linear infinite' }}>
                      <Loader2 size={16} style={{ color: meta.color }} />
                    </div>
                  ) : status === 'failed' ? (
                    <AlertTriangle size={16} style={{ color: '#ef4444' }} />
                  ) : (
                    <StageIcon size={16} style={{ color: '#ccc' }} />
                  )}
                </div>

                {/* Label & description */}
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500,
                    color: status === 'pending' ? 'var(--text-secondary)' : 'var(--text-primary)',
                  }}>
                    {meta.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                    {meta.desc}
                  </div>
                </div>

                {/* Duration / status */}
                <span style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 8,
                  background: status === 'completed' ? '#dcfce7'
                    : status === 'running' ? '#dbeafe'
                    : status === 'failed' ? '#fef2f2'
                    : 'transparent',
                  color: status === 'completed' ? '#166534'
                    : status === 'running' ? '#1e40af'
                    : status === 'failed' ? '#991b1b'
                    : 'transparent',
                  fontWeight: 500,
                }}>
                  {status === 'completed' ? 'Done' : status === 'running' ? 'Running...' : status === 'failed' ? 'Failed' : ''}
                </span>
              </div>

              {/* Connector line */}
              {index < STAGES.length - 1 && (
                <div style={{
                  marginLeft: 17, width: 2, height: 12,
                  background: completedStages.includes(stage) ? '#10b981' : '#e5e7eb',
                  transition: 'background 0.3s ease',
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Overall Progress
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>
            {completedStages.length}/{STAGES.length}
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${(completedStages.length / STAGES.length) * 100}%`,
            background: failedStage ? '#ef4444' : 'linear-gradient(90deg, #6366f1, #10b981)',
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Logs — like build output terminal */}
      {logs.length > 0 && (
        <div style={{
          background: '#1e1e2e', borderRadius: 8,
          padding: '10px 14px', maxHeight: 140, overflowY: 'auto',
          marginBottom: 16,
        }}>
          {logs.map((log, i) => (
            <div key={i} style={{
              fontSize: 11, fontFamily: 'monospace',
              color: log.type === 'error' ? '#fca5a5' : log.type === 'success' ? '#86efac' : '#94a3b8',
              marginBottom: 2,
            }}>
              <span style={{ color: '#64748b', marginRight: 8 }}>{log.time}</span>
              {log.message}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      )}

      {/* Action button */}
      {!running && !result && (
        <button
          onClick={handleRun}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '10px 16px', borderRadius: 8,
            border: 'none', background: '#4f46e5', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Play size={14} /> Start Learning Pipeline
        </button>
      )}

      {result && (
        <div style={{
          padding: '12px 16px', borderRadius: 8,
          background: '#dcfce7', border: '1px solid #10b98140',
          textAlign: 'center',
        }}>
          <CheckCircle2 size={20} style={{ color: '#10b981', margin: '0 auto 6px', display: 'block' }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>
            Learning Complete
          </div>
          <div style={{ fontSize: 11, color: '#14532d', marginTop: 2 }}>
            Output profiles have been created or updated. Switch to the Profiles tab to review.
          </div>
        </div>
      )}

      {/* CSS animation for spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );

  // Render as modal or inline
  if (asModal) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 50, padding: 16,
      }}>
        <div style={{
          width: '100%', maxWidth: 520,
          background: 'var(--surface-card)',
          borderRadius: 14, boxShadow: 'var(--shadow-float)',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '16px 20px', borderBottom: '1px solid var(--border-default)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={16} style={{ color: '#6366f1' }} />
              <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                Run Learning Pipeline
              </h3>
            </div>
            <button
              onClick={onClose}
              disabled={running}
              style={{
                background: 'none', border: 'none', cursor: running ? 'not-allowed' : 'pointer',
                padding: 4, color: 'var(--text-secondary)', opacity: running ? 0.5 : 1,
              }}
            >
              <X size={18} />
            </button>
          </div>

          <div style={{ padding: '16px 20px' }}>
            {content}
          </div>
        </div>
      </div>
    );
  }

  // Inline variant (for Learning tab)
  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Style Learning Pipeline
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
          Run the full learning pipeline to extract style patterns from uploaded exemplars and generate output profiles.
        </p>
      </div>
      {content}
    </div>
  );
}
