// @product: ai-employee
//
// ProfileCard.jsx — Company Output Profile card component.
// Design reference: Jasper Brand Voice cards + Frontify guideline cards.
// Shows profile name, doc type, version, status badge, confidence meter, layer summary.

import React from 'react';
import {
  CheckCircle2, Clock, Archive, RotateCcw, Layers,
  Shield, BarChart3, Eye, ChevronRight,
} from 'lucide-react';

const LAYER_ICONS = {
  structure:    { icon: Layers, label: 'Structure', color: '#6366f1' },
  formatting:   { icon: Eye, label: 'Format', color: '#0ea5e9' },
  charts:       { icon: BarChart3, label: 'Charts', color: '#10b981' },
  kpi_layout:   { icon: BarChart3, label: 'KPI', color: '#f59e0b' },
  text_style:   { icon: Shield, label: 'Text', color: '#8b5cf6' },
};

export default function ProfileCard({ profile, statusConfig, docTypeLabels, onClick, onRollback }) {
  const p = profile;
  const status = statusConfig[p.status] || statusConfig.draft;
  const StatusIcon = status.icon;
  const confidence = Math.round((p.confidence || 0) * 100);

  // Count populated layers
  const layers = ['canonical_structure', 'canonical_formatting', 'canonical_charts', 'canonical_kpi_layout', 'canonical_text_style'];
  const _populatedLayers = layers.filter(l => p[l] && Object.keys(p[l]).length > 0);

  return (
    <div
      onClick={onClick}
      style={{
        padding: '16px 18px',
        borderRadius: 12,
        border: `1px solid ${p.status === 'active' ? '#10b981' + '40' : 'var(--border-default)'}`,
        background: 'var(--surface-card)',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = 'var(--shadow-elevated)';
        e.currentTarget.style.borderColor = '#6366f1' + '60';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.borderColor = p.status === 'active' ? '#10b981' + '40' : 'var(--border-default)';
      }}
    >
      {/* Active indicator bar — like Jasper's brand voice active state */}
      {p.status === 'active' && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: 'linear-gradient(90deg, #10b981, #6366f1)',
        }} />
      )}

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
            {p.profile_name || docTypeLabels[p.doc_type] || p.doc_type}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {docTypeLabels[p.doc_type] || p.doc_type} · v{p.version || 1}
            {p.team_id && ` · ${p.team_id}`}
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, padding: '2px 8px', borderRadius: 10,
          background: status.color + '14', color: status.color,
          border: `1px solid ${status.color}40`,
          fontWeight: 500,
        }}>
          <StatusIcon size={11} />
          {status.label}
        </div>
      </div>

      {/* Confidence meter — like Writer's style compliance score */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Confidence</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: confidence >= 70 ? '#10b981' : confidence >= 40 ? '#f59e0b' : '#ef4444' }}>
            {confidence}%
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: '#e5e7eb', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${confidence}%`,
            background: confidence >= 70 ? '#10b981' : confidence >= 40 ? '#f59e0b' : '#ef4444',
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Layer indicators — like Templafy's step indicators */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {Object.entries(LAYER_ICONS).map(([key, cfg]) => {
          const canonicalKey = `canonical_${key}`;
          const populated = p[canonicalKey] && Object.keys(p[canonicalKey]).length > 0;
          const LayerIcon = cfg.icon;
          return (
            <div
              key={key}
              title={`${cfg.label}: ${populated ? 'Populated' : 'Empty'}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '2px 6px', borderRadius: 6,
                background: populated ? cfg.color + '14' : '#f3f4f6',
                color: populated ? cfg.color : '#ccc',
                fontSize: 10, fontWeight: 500,
              }}
            >
              <LayerIcon size={10} />
              {cfg.label}
            </div>
          );
        })}
      </div>

      {/* Metadata row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {p.sample_count || 0} samples
          {p.created_by_mode && ` · ${p.created_by_mode}`}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {p.status === 'active' && onRollback && p.version > 1 && (
            <button
              onClick={e => { e.stopPropagation(); onRollback(); }}
              title="Rollback to previous version"
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '3px 8px', borderRadius: 6,
                border: '1px solid #ef444440', background: 'transparent',
                color: '#ef4444', fontSize: 10, cursor: 'pointer',
              }}
            >
              <RotateCcw size={10} /> Rollback
            </button>
          )}
          <ChevronRight size={14} style={{ color: 'var(--text-secondary)' }} />
        </div>
      </div>
    </div>
  );
}
