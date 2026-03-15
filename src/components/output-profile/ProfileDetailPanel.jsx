// @product: ai-employee
//
// ProfileDetailPanel.jsx — Full detail view for a Company Output Profile.
// Design reference: Writer.com style guide editor (categorized rules) + Frontify living docs portal.
// 5-layer tabbed view: Structure, Formatting, Charts, KPI Layout, Text Style.
// Plus Evidence and Governance layers.

import React, { useState } from 'react';
import {
  X, Layers, Paintbrush, BarChart3, LayoutGrid, Type,
  Shield, FileText, CheckCircle2, AlertTriangle, Info,
  ChevronDown, ChevronRight, RotateCcw, Copy, Clock,
} from 'lucide-react';

const TABS = [
  { id: 'structure',  label: 'Structure',  icon: Layers,     color: '#6366f1' },
  { id: 'formatting', label: 'Format',     icon: Paintbrush, color: '#0ea5e9' },
  { id: 'charts',     label: 'Charts',     icon: BarChart3,  color: '#10b981' },
  { id: 'kpi_layout', label: 'KPI Layout', icon: LayoutGrid, color: '#f59e0b' },
  { id: 'text_style', label: 'Text Style', icon: Type,       color: '#8b5cf6' },
  { id: 'governance', label: 'Governance', icon: Shield,     color: '#ef4444' },
  { id: 'evidence',   label: 'Evidence',   icon: FileText,   color: '#64748b' },
];

export default function ProfileDetailPanel({ profile, docTypeLabels, onClose, onRollback }) {
  const [activeTab, setActiveTab] = useState('structure');
  const p = profile;

  const getCanonicalData = (tab) => {
    if (tab === 'governance' || tab === 'evidence') return null;
    return p[`canonical_${tab}`] || {};
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
      display: 'flex', justifyContent: 'flex-end',
      zIndex: 50,
    }}>
      {/* Backdrop close */}
      <div style={{ flex: 1 }} onClick={onClose} />

      {/* Panel — like Writer's style guide editor panel */}
      <div style={{
        width: '100%', maxWidth: 680,
        background: 'var(--surface-card)',
        boxShadow: 'var(--shadow-float)',
        display: 'flex', flexDirection: 'column',
        height: '100%',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: '18px 20px', borderBottom: '1px solid var(--border-default)',
        }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              {p.profile_name || docTypeLabels[p.doc_type] || p.doc_type}
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                v{p.version || 1} · {p.status}
              </span>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: p.created_by_mode === 'learned' ? '#dbeafe' : p.created_by_mode === 'ai_proposed' ? '#ede9fe' : '#dcfce7',
                color: p.created_by_mode === 'learned' ? '#1e40af' : p.created_by_mode === 'ai_proposed' ? '#6d28d9' : '#166534',
              }}>
                {p.created_by_mode || 'learned'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {p.sample_count || 0} samples · {Math.round((p.confidence || 0) * 100)}% confidence
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {onRollback && p.status === 'active' && p.version > 1 && (
              <button
                onClick={onRollback}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 6,
                  border: '1px solid #ef444440', background: 'transparent',
                  color: '#ef4444', fontSize: 11, cursor: 'pointer',
                }}
              >
                <RotateCcw size={11} /> Rollback
              </button>
            )}
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-secondary)' }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Layer Tabs — like Writer's categorized rule tabs */}
        <div style={{
          display: 'flex', gap: 0, borderBottom: '1px solid var(--border-default)',
          overflowX: 'auto', flexShrink: 0,
        }}>
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            const TabIcon = tab.icon;
            const hasData = tab.id === 'governance' || tab.id === 'evidence' || (
              p[`canonical_${tab.id}`] && Object.keys(p[`canonical_${tab.id}`]).length > 0
            );
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '10px 14px', fontSize: 11, fontWeight: active ? 600 : 400,
                  color: active ? tab.color : hasData ? 'var(--text-secondary)' : '#ccc',
                  borderBottom: `2px solid ${active ? tab.color : 'transparent'}`,
                  background: 'none', border: 'none',
                  borderBottomStyle: 'solid', borderBottomWidth: 2,
                  borderBottomColor: active ? tab.color : 'transparent',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                <TabIcon size={12} />
                {tab.label}
                {!hasData && <span style={{ fontSize: 9, color: '#ccc' }}>(empty)</span>}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {activeTab === 'governance' ? (
            <GovernanceView profile={p} />
          ) : activeTab === 'evidence' ? (
            <EvidenceView profile={p} />
          ) : (
            <CanonicalLayerView data={getCanonicalData(activeTab)} layerName={activeTab} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Layer content views ──────────────────────────────────────

function CanonicalLayerView({ data, layerName }) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
        <Info size={24} style={{ margin: '0 auto 8px', display: 'block', color: '#ccc' }} />
        <div style={{ fontSize: 13 }}>No {layerName} rules learned yet.</div>
        <div style={{ fontSize: 11, marginTop: 4 }}>Upload more exemplars or run the learning pipeline to populate this layer.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Object.entries(data).map(([key, value]) => (
        <RuleCard key={key} ruleKey={key} ruleValue={value} />
      ))}
    </div>
  );
}

function RuleCard({ ruleKey, ruleValue }) {
  const [expanded, setExpanded] = useState(false);

  // Determine if value is complex
  const isComplex = typeof ruleValue === 'object' && ruleValue !== null;
  const displayValue = isComplex ? null : String(ruleValue);

  // Try to extract confidence/strength if present
  const confidence = isComplex ? ruleValue.confidence : null;
  const strength = isComplex ? ruleValue.strength : null;
  const isStrong = strength === 'strong' || (confidence && confidence >= 0.7);

  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8,
      border: '1px solid var(--border-default)',
      background: 'var(--surface-card)',
    }}>
      <div
        onClick={() => isComplex && setExpanded(!expanded)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          cursor: isComplex ? 'pointer' : 'default',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
            {ruleKey}
          </span>
          {strength && (
            <span style={{
              fontSize: 9, padding: '1px 6px', borderRadius: 8,
              background: isStrong ? '#dcfce7' : '#fef3c7',
              color: isStrong ? '#166534' : '#92400e',
              fontWeight: 500,
            }}>
              {strength}
            </span>
          )}
          {confidence != null && (
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {Math.round(confidence * 100)}%
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {displayValue && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayValue}
            </span>
          )}
          {isComplex && (
            expanded
              ? <ChevronDown size={14} style={{ color: '#999' }} />
              : <ChevronRight size={14} style={{ color: '#999' }} />
          )}
        </div>
      </div>

      {expanded && isComplex && (
        <pre style={{
          marginTop: 8, padding: 10, borderRadius: 6,
          background: '#1e1e2e', color: '#cdd6f4',
          fontSize: 11, overflow: 'auto', maxHeight: 200,
        }}>
          {JSON.stringify(ruleValue, null, 2)}
        </pre>
      )}
    </div>
  );
}

function GovernanceView({ profile }) {
  const p = profile;
  const rules = [
    { label: 'Status', value: p.status, type: 'status' },
    { label: 'Version', value: `v${p.version || 1}` },
    { label: 'Created by', value: p.created_by_mode || 'learned' },
    { label: 'Approved by', value: p.approved_by || '—' },
    { label: 'Approved at', value: p.approved_at ? new Date(p.approved_at).toLocaleString() : '—' },
    { label: 'Created at', value: p.created_at ? new Date(p.created_at).toLocaleString() : '—' },
    { label: 'Base profile', value: p.base_profile_id || '—' },
    { label: 'Source style profile', value: p.source_style_profile_id || '—' },
  ];

  // High variance dims
  const highVariance = p.high_variance_dims || [];

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
        {rules.map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</span>
          </div>
        ))}
      </div>

      {highVariance.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <AlertTriangle size={12} /> High Variance Dimensions
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {highVariance.map(dim => (
              <span key={dim} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 8,
                background: '#fef3c7', color: '#92400e',
              }}>
                {dim}
              </span>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
            These dimensions show inconsistency across exemplars — rules may need manual confirmation.
          </p>
        </div>
      )}
    </div>
  );
}

function EvidenceView({ profile }) {
  const p = profile;
  const exemplarIds = p.derived_from_exemplar_ids || [];

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
        <FileText size={12} /> Source Exemplars ({exemplarIds.length})
      </div>

      {exemplarIds.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '20px 0', textAlign: 'center' }}>
          No source exemplars recorded for this profile.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {exemplarIds.map((id, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 6,
              border: '1px solid var(--border-default)',
              fontSize: 11,
            }}>
              <FileText size={12} style={{ color: '#6366f1' }} />
              <span style={{ flex: 1, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                {typeof id === 'string' ? id.slice(0, 12) + '...' : JSON.stringify(id)}
              </span>
              <button
                onClick={() => navigator.clipboard?.writeText(typeof id === 'string' ? id : JSON.stringify(id))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#999' }}
                title="Copy ID"
              >
                <Copy size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Metadata */}
      <div style={{ marginTop: 16, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--text-secondary)' }}>
          <span>Sample count</span>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{p.sample_count || 0}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--text-secondary)' }}>
          <span>Overall confidence</span>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{Math.round((p.confidence || 0) * 100)}%</span>
        </div>
      </div>
    </div>
  );
}
