// @product: ai-employee
//
// TaskPlanCard.jsx — Renders a task decomposition for user approval.
// Shows subtask list with time estimates, token cost breakdown, and approve/edit/cancel actions.

import React, { useEffect, useState } from 'react';

// ── Time & cost estimation heuristics ──
const STEP_TIME_ESTIMATES = {
  forecast:        { min: 8, max: 20, label: '8-20s' },
  plan:            { min: 10, max: 30, label: '10-30s' },
  risk:            { min: 5, max: 15, label: '5-15s' },
  synthesize:      { min: 3, max: 8, label: '3-8s' },
  report:          { min: 5, max: 12, label: '5-12s' },
  export:          { min: 2, max: 5, label: '2-5s' },
  dynamic_tool:    { min: 15, max: 60, label: '15-60s' },
  registered_tool: { min: 5, max: 20, label: '5-20s' },
  builtin_tool:    { min: 5, max: 20, label: '5-20s' },
};

const COST_PER_STEP = 0.003; // ~$0.003 per step (unified model)

// Forecast model options for the selector
const FORECAST_MODELS = [
  { value: 'compare',  label: 'Compare All (Prophet + LightGBM + Chronos)' },
  { value: 'auto',     label: 'Auto (best fit)' },
  { value: 'prophet',  label: 'Prophet' },
  { value: 'lightgbm', label: 'LightGBM' },
  { value: 'chronos',  label: 'Chronos' },
  { value: 'xgboost',  label: 'XGBoost' },
  { value: 'ets',      label: 'ETS' },
  { value: 'naive',    label: 'Naive (JS built-in)' },
];

function estimateStepTime(workflowType) {
  return STEP_TIME_ESTIMATES[workflowType] || { min: 5, max: 15, label: '5-15s' };
}

function hasForecastStep(subtasks) {
  return subtasks.some(s => s.builtin_tool_id === 'forecast_from_sap');
}

function getInitialModel(subtasks) {
  const step = subtasks.find(s => s.builtin_tool_id === 'forecast_from_sap');
  return step?.input_args?.forecast_model || 'compare';
}

/**
 * @param {object} props
 * @param {object} props.decomposition - From chatTaskDecomposer.decomposeTask()
 * @param {function} props.onApprove - Called with decomposition when user approves
 * @param {function} [props.onCancel] - Called when user cancels
 * @param {function} [props.onEdit] - Called with edited decomposition
 * @param {boolean} [props.disabled] - Disable actions
 */
export default function TaskPlanCard({ decomposition, onApprove, onCancel, onEdit, disabled = false }) {
  const subtasks = decomposition?.subtasks || [];
  const showModelSelector = hasForecastStep(subtasks);
  const [expanded, setExpanded] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => getInitialModel(subtasks));

  useEffect(() => {
    setSelectedModel(getInitialModel(subtasks));
  }, [subtasks]);

  if (!subtasks.length) {
    return null;
  }

  const { confidence, estimated_cost, report_format, needs_dynamic_tool } = decomposition;

  // Build patched decomposition with selected model injected into forecast step
  function getApprovalDecomposition() {
    if (!showModelSelector) return decomposition;
    return {
      ...decomposition,
      subtasks: subtasks.map(s =>
        s.builtin_tool_id === 'forecast_from_sap'
          ? { ...s, input_args: { ...(s.input_args || {}), forecast_model: selectedModel } }
          : s
      ),
    };
  }

  // Calculate totals
  const totalTimeRange = subtasks.reduce((acc, step) => {
    const est = estimateStepTime(step.workflow_type);
    return { min: acc.min + est.min, max: acc.max + est.max };
  }, { min: 0, max: 0 });

  const totalCost = estimated_cost ?? subtasks.length * COST_PER_STEP;

  const workflowIcons = {
    forecast: '\u{1F4CA}',
    plan: '\u{1F4CB}',
    risk: '\u26A0\uFE0F',
    synthesize: '\u{1F517}',
    dynamic_tool: '\u{1F916}',
    registered_tool: '\u{1F527}',
    builtin_tool: '\u{1F9F0}',
    report: '\u{1F4C4}',
    export: '\u{1F4E4}',
  };

  return (
    <div style={{
      border: '1px solid var(--border-default, #e2e8f0)',
      borderLeft: '3px solid var(--cat-plan)',
      borderRadius: 12,
      overflow: 'hidden',
      background: 'var(--surface-card, #fafbff)',
      marginBottom: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      {/* ── Header bar ── */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--border-default, #e2e8f0)',
        background: 'linear-gradient(135deg, #eef2ff 0%, #f8fafc 100%)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>{'\u{1F4DD}'}</span>
            <div>
              <strong style={{ fontSize: 15, color: 'var(--text-primary, #1e293b)' }}>Task Plan</strong>
              <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)' }}>
                  {subtasks.length} step{subtasks.length > 1 ? 's' : ''}
                </span>
                {confidence != null && (
                  <span style={{
                    fontSize: 11,
                    color: confidence > 0.8 ? '#059669' : confidence > 0.5 ? '#d97706' : '#dc2626',
                  }}>
                    {Math.round(confidence * 100)}% confidence
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Summary badges ── */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <SummaryBadge
            icon="\u23F1\uFE0F"
            label={`${formatTime(totalTimeRange.min)} - ${formatTime(totalTimeRange.max)}`}
            tooltip="Estimated processing time"
          />
          <SummaryBadge
            icon="\u{1F4B0}"
            label={`$${totalCost.toFixed(4)}`}
            tooltip="Estimated token cost"
          />
          {needs_dynamic_tool && (
            <SummaryBadge icon="\u{1F916}" label="AI Code Gen" color="#b91c1c" bg="#fee2e2" />
          )}
          {report_format && (
            <SummaryBadge icon="\u{1F4C1}" label={report_format.toUpperCase()} color="#1d4ed8" bg="#dbeafe" />
          )}
        </div>
      </div>

      {/* ── Model selector (for forecast tasks) ── */}
      {showModelSelector && (
        <div style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-default, #e2e8f0)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary, #64748b)', whiteSpace: 'nowrap' }}>
            Forecast Model
          </span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={disabled}
            style={{
              flex: 1, maxWidth: 220,
              padding: '6px 10px', borderRadius: 6,
              border: '1px solid var(--border-default, #d1d5db)',
              background: 'var(--surface-card, #fff)',
              fontSize: 13, color: 'var(--text-primary, #1e293b)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              outline: 'none',
            }}
          >
            {FORECAST_MODELS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* ── Step list ── */}
      <div style={{ padding: '8px 12px' }}>
        {subtasks.slice(0, expanded ? undefined : 5).map((step, i) => {
          const timeEst = estimateStepTime(step.workflow_type);

          return (
            <div key={step.name || i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              margin: '4px 0',
              background: 'var(--surface-bg, #fff)',
              border: '1px solid var(--border-default, #f1f5f9)',
              borderRadius: 8,
              fontSize: 13,
              transition: 'border-color 0.15s',
            }}>
              {/* Step number */}
              <span style={{
                width: 22, height: 22, borderRadius: '50%',
                background: '#e0e7ff', color: '#4338ca',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>
                {i + 1}
              </span>

              {/* Icon */}
              <span style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>
                {workflowIcons[step.workflow_type] || '\u25B6\uFE0F'}
              </span>

              {/* Name + description */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ color: 'var(--text-primary, #1e293b)' }}>{step.name}</strong>
                {step.description && (
                  <div style={{ color: 'var(--text-muted, #94a3b8)', fontSize: 11, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {step.description}
                  </div>
                )}
              </div>

              {/* Time estimate */}
              <span style={{ fontSize: 10, color: 'var(--text-muted, #94a3b8)', whiteSpace: 'nowrap' }}>
                ~{timeEst.label}
              </span>


              {/* Review indicator */}
              {step.requires_review && (
                <span style={{ fontSize: 12 }} title="Requires human review">{'\u{1F441}\uFE0F'}</span>
              )}
            </div>
          );
        })}
      </div>

      {subtasks.length > 5 && (
        <div style={{ padding: '0 16px 8px' }}>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              fontSize: 12, color: '#6366f1', background: 'none', border: 'none',
              cursor: 'pointer', padding: '4px 0', fontWeight: 500,
            }}
          >
            {expanded ? '\u25B2 Show less' : `\u25BC Show all ${subtasks.length} steps`}
          </button>
        </div>
      )}

      {/* ── Action bar ── */}
      <div style={{
        display: 'flex', gap: 8, padding: '12px 16px',
        borderTop: '1px solid var(--border-default, #e2e8f0)',
        background: 'var(--surface-subtle, #f8fafc)',
        justifyContent: 'flex-end', alignItems: 'center',
      }}>
        {/* Left side: cost summary */}
        <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted, #94a3b8)' }}>
          Total: ~{formatTime(totalTimeRange.min)}-{formatTime(totalTimeRange.max)} &middot; ~${totalCost.toFixed(4)}
        </div>

        {onCancel && (
          <button
            onClick={onCancel}
            disabled={disabled}
            style={{
              padding: '8px 16px', borderRadius: 8,
              border: '1px solid var(--border-default, #d1d5db)',
              background: 'var(--surface-card, #fff)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 13, color: 'var(--text-secondary, #64748b)',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            Reject
          </button>
        )}
        {onEdit && (
          <button
            onClick={() => onEdit(getApprovalDecomposition())}
            disabled={disabled}
            style={{
              padding: '8px 16px', borderRadius: 8,
              border: '1px solid #818cf8',
              background: '#eef2ff',
              color: '#4338ca',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            Modify
          </button>
        )}
        <button
          onClick={() => typeof onApprove === 'function' ? onApprove(getApprovalDecomposition()) : console.warn('[TaskPlanCard] onApprove is not a function — message may have been restored from cache')}
          disabled={disabled}
          style={{
            padding: '8px 20px', borderRadius: 8,
            border: 'none',
            background: disabled ? '#9ca3af' : 'linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)',
            color: '#fff',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13, fontWeight: 600,
            boxShadow: disabled ? 'none' : '0 2px 8px rgba(79, 70, 229, 0.3)',
            transition: 'box-shadow 0.15s, transform 0.1s',
          }}
          onMouseEnter={(e) => { if (!disabled) e.target.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={(e) => { e.target.style.transform = 'none'; }}
        >
          Approve & Execute
        </button>
      </div>
    </div>
  );
}

// ── Helper components ──

function SummaryBadge({ icon, label, tooltip, color = 'var(--text-muted, #64748b)', bg = 'var(--surface-subtle, #f1f5f9)' }) {
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, padding: '3px 10px', borderRadius: 20,
        background: bg, color,
        fontWeight: 500,
      }}
    >
      <span>{icon}</span>
      {label}
    </span>
  );
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}
