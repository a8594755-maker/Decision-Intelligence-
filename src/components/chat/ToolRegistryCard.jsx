// @product: ai-employee
//
// ToolRegistryCard.jsx — Shows a dynamic tool after human review passes.
// Offers "Save to Tool Library" action.

import React, { useState } from 'react';

/**
 * @param {object} props
 * @param {object} props.tool - Tool entry from dynamicToolExecutor output
 * @param {function} [props.onSave] - Called when user clicks "Save to Tool Library"
 * @param {boolean} [props.saved] - Whether the tool has already been saved
 */
export default function ToolRegistryCard({ tool, onSave, saved = false }) {
  const [showCode, setShowCode] = useState(false);

  if (!tool) return null;

  const { name, description, category, code, code_hash, quality_score, usage_count, status } = tool;

  const statusColors = {
    draft: '#f59e0b',
    active: '#10b981',
    deprecated: '#9ca3af',
  };

  return (
    <div style={{
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 16,
      background: '#fff',
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <strong style={{ fontSize: 14 }}>{name || 'Unnamed Tool'}</strong>
          {category && (
            <span style={{
              marginLeft: 8,
              fontSize: 11,
              padding: '1px 8px',
              borderRadius: 12,
              background: '#ede9fe',
              color: '#6d28d9',
            }}>
              {category}
            </span>
          )}
        </div>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 12,
          background: `${statusColors[status] || '#999'}20`,
          color: statusColors[status] || '#999',
        }}>
          {status || 'draft'}
        </span>
      </div>

      {/* Description */}
      {description && (
        <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 8 }}>
          {description}
        </div>
      )}

      {/* Metrics */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#666', marginBottom: 10 }}>
        {quality_score != null && (
          <span>Quality: <strong>{(quality_score * 100).toFixed(0)}%</strong></span>
        )}
        {usage_count != null && (
          <span>Uses: <strong>{usage_count}</strong></span>
        )}
        {code_hash && (
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#999' }}>
            #{code_hash.slice(0, 8)}
          </span>
        )}
      </div>

      {/* Code preview */}
      {code && (
        <div>
          <button
            onClick={() => setShowCode(!showCode)}
            style={{
              fontSize: 12,
              color: '#3b82f6',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              marginBottom: 4,
            }}
          >
            {showCode ? 'Hide code' : 'Show code'}
          </button>
          {showCode && (
            <pre style={{
              background: '#1e1e2e',
              color: '#cdd6f4',
              padding: 12,
              borderRadius: 6,
              fontSize: 11,
              overflow: 'auto',
              maxHeight: 200,
              margin: '4px 0 0',
            }}>
              {code}
            </pre>
          )}
        </div>
      )}

      {/* Save action */}
      {onSave && !saved && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={() => onSave(tool)}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#7c3aed',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Save to Tool Library
          </button>
        </div>
      )}

      {saved && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#10b981', fontWeight: 600 }}>
          Saved to tool library
        </div>
      )}
    </div>
  );
}
