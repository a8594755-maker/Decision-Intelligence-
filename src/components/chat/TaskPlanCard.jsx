// @product: ai-employee
//
// TaskPlanCard.jsx — Renders a task decomposition for user approval.
// Shows subtask list with descriptions, tiers, costs, and approve/edit/cancel actions.

import React, { useState } from 'react';

/**
 * @param {object} props
 * @param {object} props.decomposition - From chatTaskDecomposer.decomposeTask()
 * @param {function} props.onApprove - Called with decomposition when user approves
 * @param {function} [props.onCancel] - Called when user cancels
 * @param {function} [props.onEdit] - Called with edited decomposition
 * @param {boolean} [props.disabled] - Disable actions
 */
export default function TaskPlanCard({ decomposition, onApprove, onCancel, onEdit, disabled = false }) {
  const [expanded, setExpanded] = useState(false);

  if (!decomposition?.subtasks?.length) {
    return null;
  }

  const { subtasks, confidence, estimated_cost, report_format, needs_dynamic_tool } = decomposition;

  const tierColors = {
    tier_a: '#e94560',
    tier_b: '#f59e0b',
    tier_c: '#10b981',
  };

  const workflowIcons = {
    forecast: '📊',
    plan: '📋',
    risk: '⚠️',
    synthesize: '🔗',
    dynamic_tool: '🤖',
    registered_tool: '🔧',
    report: '📄',
    export: '📤',
  };

  return (
    <div style={{
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 16,
      background: '#fafbff',
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <strong style={{ fontSize: 15 }}>Task Plan</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#666' }}>
            {subtasks.length} step{subtasks.length > 1 ? 's' : ''}
            {confidence != null && ` · confidence: ${Math.round(confidence * 100)}%`}
          </span>
        </div>
        {estimated_cost != null && (
          <span style={{ fontSize: 12, color: '#666' }}>
            Est. cost: ${estimated_cost.toFixed(4)}
          </span>
        )}
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {needs_dynamic_tool && (
          <span style={{ fontSize: 11, background: '#fee2e2', color: '#b91c1c', padding: '2px 8px', borderRadius: 12 }}>
            AI will generate code
          </span>
        )}
        {report_format && (
          <span style={{ fontSize: 11, background: '#dbeafe', color: '#1d4ed8', padding: '2px 8px', borderRadius: 12 }}>
            Output: {report_format.toUpperCase()}
          </span>
        )}
      </div>

      {/* Step list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {subtasks.slice(0, expanded ? undefined : 5).map((step, i) => (
          <div key={step.name || i} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            background: '#fff',
            border: '1px solid #eee',
            borderRadius: 6,
            fontSize: 13,
          }}>
            <span style={{ width: 20, textAlign: 'center' }}>
              {workflowIcons[step.workflow_type] || '▶️'}
            </span>
            <span style={{ flex: 1 }}>
              <strong>{step.name}</strong>
              {step.description && (
                <span style={{ color: '#666', marginLeft: 6 }}>{step.description}</span>
              )}
            </span>
            {step.estimated_tier && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: tierColors[step.estimated_tier] || '#999',
                color: '#fff',
              }}>
                {step.estimated_tier.replace('tier_', 'T')}
              </span>
            )}
            {step.requires_review && (
              <span style={{ fontSize: 10, color: '#f59e0b' }} title="Requires review">👁️</span>
            )}
          </div>
        ))}
      </div>

      {subtasks.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ marginTop: 6, fontSize: 12, color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {expanded ? 'Show less' : `Show all ${subtasks.length} steps`}
        </button>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={disabled}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: '#fff',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 13,
            }}
          >
            Cancel
          </button>
        )}
        {onEdit && (
          <button
            onClick={() => onEdit(decomposition)}
            disabled={disabled}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #3b82f6',
              background: '#eff6ff',
              color: '#1d4ed8',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 13,
            }}
          >
            Edit Steps
          </button>
        )}
        <button
          onClick={() => onApprove(decomposition)}
          disabled={disabled}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: disabled ? '#9ca3af' : '#3b82f6',
            color: '#fff',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Approve & Execute
        </button>
      </div>
    </div>
  );
}
