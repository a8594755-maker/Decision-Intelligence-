// @product: ai-employee
//
// ProposalDiffPanel.jsx — Side-by-side comparison of baseline vs proposed profile changes.
// Design reference: Jasper before/after brand voice comparison + Templafy version diff.
// Shows rationale, changed fields, and approve/reject actions.

import React, { useState } from 'react';
import {
  X, GitCompare, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  ArrowRight, Plus, Minus, Edit3, MessageSquare,
} from 'lucide-react';

const CHANGE_ICONS = {
  added: { icon: Plus, color: '#10b981', bg: '#dcfce7', label: 'Added' },
  removed: { icon: Minus, color: '#ef4444', bg: '#fef2f2', label: 'Removed' },
  modified: { icon: Edit3, color: '#f59e0b', bg: '#fef3c7', label: 'Modified' },
};

export default function ProposalDiffPanel({ proposal, onClose, onApprove, onReject }) {
  const [rejectComment, setRejectComment] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  const prop = proposal;
  const changes = prop.proposed_changes || {};
  const comparison = prop.comparison_summary || {};
  const candidate = prop.candidate_profile || {};

  // Parse changes into visual diff items
  const diffItems = parseDiffItems(changes, comparison);

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      zIndex: 50, padding: 16,
    }}>
      <div style={{
        width: '100%', maxWidth: 720,
        maxHeight: '90vh',
        background: 'var(--surface-card)',
        borderRadius: 14, boxShadow: 'var(--shadow-float)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: '18px 20px', borderBottom: '1px solid var(--border-default)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <GitCompare size={18} style={{ color: '#f59e0b' }} />
              <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                {prop.proposal_name || 'Improvement Proposal'}
              </h3>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              v{prop.proposed_version || '?'} · {prop.doc_type || 'unknown'} · {prop.status}
              {prop.source_review_id && ` · from review`}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-secondary)' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Rationale — like Jasper's brand voice explanation */}
        {prop.rationale && (
          <div style={{
            padding: '12px 20px', borderBottom: '1px solid var(--border-default)',
            background: '#fefce8',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <MessageSquare size={12} style={{ color: '#92400e' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Rationale
              </span>
            </div>
            <p style={{ fontSize: 12, color: '#78350f', margin: 0, lineHeight: 1.5 }}>
              {prop.rationale}
            </p>
          </div>
        )}

        {/* Diff Content — side-by-side like Templafy version comparison */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {diffItems.length === 0 ? (
            <FallbackDiffView changes={changes} comparison={comparison} candidate={candidate} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {diffItems.map((item, i) => (
                <DiffRow key={i} item={item} />
              ))}
            </div>
          )}
        </div>

        {/* Action Footer — approve/reject with comment */}
        {prop.status === 'pending_approval' && (
          <div style={{
            padding: '14px 20px', borderTop: '1px solid var(--border-default)',
          }}>
            {showRejectForm ? (
              <div>
                <textarea
                  value={rejectComment}
                  onChange={e => setRejectComment(e.target.value)}
                  placeholder="Rejection reason (optional)..."
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 6,
                    border: '1px solid var(--border-default)', fontSize: 12,
                    resize: 'vertical', minHeight: 60, marginBottom: 8,
                    background: 'var(--surface-card)', color: 'var(--text-primary)',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowRejectForm(false)}
                    style={{
                      padding: '7px 14px', borderRadius: 6,
                      border: '1px solid var(--border-default)', background: 'var(--surface-card)',
                      fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => onReject(rejectComment)}
                    style={{
                      padding: '7px 14px', borderRadius: 6,
                      border: 'none', background: '#ef4444', color: '#fff',
                      fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Confirm Reject
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowRejectForm(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '8px 16px', borderRadius: 8,
                    border: '1px solid #ef4444', background: 'transparent',
                    color: '#ef4444', fontSize: 13, cursor: 'pointer',
                  }}
                >
                  <XCircle size={14} /> Reject
                </button>
                <button
                  onClick={onApprove}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '8px 16px', borderRadius: 8,
                    border: 'none', background: '#10b981', color: '#fff',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  <CheckCircle2 size={14} /> Approve & Activate
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Diff helpers ──────────────────────────────────────────

function parseDiffItems(changes, comparison) {
  const items = [];

  // From comparison_summary (structured diff)
  if (comparison && typeof comparison === 'object') {
    for (const [key, diff] of Object.entries(comparison)) {
      if (diff && typeof diff === 'object') {
        items.push({
          key,
          type: diff.type || 'modified',
          before: diff.before ?? diff.old ?? null,
          after: diff.after ?? diff.new ?? null,
          description: diff.description || diff.reason || null,
        });
      }
    }
  }

  // From proposed_changes (flat key-value)
  if (items.length === 0 && changes && typeof changes === 'object') {
    for (const [key, value] of Object.entries(changes)) {
      items.push({
        key,
        type: 'modified',
        before: null,
        after: value,
        description: null,
      });
    }
  }

  return items;
}

function DiffRow({ item }) {
  const [expanded, setExpanded] = useState(false);
  const changeConfig = CHANGE_ICONS[item.type] || CHANGE_ICONS.modified;
  const ChangeIcon = changeConfig.icon;
  const isComplex = (typeof item.before === 'object' && item.before !== null) ||
                    (typeof item.after === 'object' && item.after !== null);

  return (
    <div style={{
      borderRadius: 8, border: '1px solid var(--border-default)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px',
          background: changeConfig.bg,
          cursor: 'pointer',
        }}
      >
        <ChangeIcon size={12} style={{ color: changeConfig.color }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
          {item.key}
        </span>
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 6,
          background: changeConfig.color + '20', color: changeConfig.color,
        }}>
          {changeConfig.label}
        </span>
        {isComplex && (
          expanded
            ? <ChevronDown size={14} style={{ color: '#999' }} />
            : <ChevronRight size={14} style={{ color: '#999' }} />
        )}
      </div>

      {/* Description */}
      {item.description && (
        <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)' }}>
          {item.description}
        </div>
      )}

      {/* Value comparison */}
      {(!isComplex || expanded) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 0 }}>
          {/* Before */}
          <div style={{ padding: '10px 14px', background: '#fef2f2' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#ef4444', marginBottom: 4, textTransform: 'uppercase' }}>
              Current
            </div>
            <div style={{ fontSize: 11, color: '#991b1b' }}>
              {item.before != null ? (
                isComplex
                  ? <pre style={{ margin: 0, fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(item.before, null, 2)}</pre>
                  : String(item.before)
              ) : (
                <span style={{ color: '#ccc', fontStyle: 'italic' }}>empty</span>
              )}
            </div>
          </div>

          {/* Arrow */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 6px', background: '#f9fafb',
          }}>
            <ArrowRight size={14} style={{ color: '#999' }} />
          </div>

          {/* After */}
          <div style={{ padding: '10px 14px', background: '#f0fdf4' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#10b981', marginBottom: 4, textTransform: 'uppercase' }}>
              Proposed
            </div>
            <div style={{ fontSize: 11, color: '#14532d' }}>
              {item.after != null ? (
                isComplex
                  ? <pre style={{ margin: 0, fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(item.after, null, 2)}</pre>
                  : String(item.after)
              ) : (
                <span style={{ color: '#ccc', fontStyle: 'italic' }}>removed</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FallbackDiffView({ changes, comparison, candidate }) {
  const data = candidate || changes || comparison || {};
  if (!data || Object.keys(data).length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)', fontSize: 13 }}>
        No diff details available for this proposal.
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' }}>
        Proposed Profile Content
      </div>
      <pre style={{
        background: '#1e1e2e', color: '#cdd6f4',
        padding: 14, borderRadius: 8, fontSize: 11,
        overflow: 'auto', maxHeight: 400,
      }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
