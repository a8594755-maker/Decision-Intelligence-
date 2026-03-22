/**
 * FeatureGatePanel — Floating dev panel to toggle feature flags at runtime.
 *
 * Renders a small floating button (bottom-right). Click to expand the full
 * toggle panel. Changes take effect immediately — no restart needed.
 *
 * Only rendered when envConfig.enableDevTools is true.
 */

import React, { useState, useCallback, useSyncExternalStore } from 'react';
import {
  FEATURES,
  isEnabled,
  setFeature,
  enableAll,
  disableAll,
  getAllFlags,
  getEnabledFeatures,
} from '../../config/featureGateService';

// ── External store so toggles trigger re-renders ─────────────────────────────

let _version = 0;
const _listeners = new Set();

function subscribe(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function getSnapshot() {
  return _version;
}

function notify() {
  _version++;
  _listeners.forEach(cb => cb());
}

function toggle(featureId, value) {
  setFeature(featureId, value);
  notify();
}

function handleEnableAll() {
  enableAll();
  notify();
}

function handleDisableAll() {
  disableAll();
  notify();
}

// ── Feature categories for organized display ─────────────────────────────────

const CATEGORIES = [
  {
    label: 'Core Pipeline',
    features: [FEATURES.FORECAST, FEATURES.PLAN, FEATURES.WORKFLOW_A, FEATURES.WORKFLOW_B, FEATURES.TOPOLOGY],
  },
  {
    label: 'Analysis',
    features: [FEATURES.WHAT_IF, FEATURES.COMPARE_PLANS, FEATURES.DIGITAL_TWIN],
  },
  {
    label: 'Risk',
    features: [FEATURES.RISK_AWARE, FEATURES.PROACTIVE_ALERTS, FEATURES.MACRO_ORACLE],
  },
  {
    label: 'Governance',
    features: [FEATURES.NEGOTIATION, FEATURES.APPROVAL],
  },
  {
    label: 'AI Employee',
    features: [FEATURES.AI_EMPLOYEE, FEATURES.RALPH_LOOP],
  },
  {
    label: 'Intake',
    features: [FEATURES.EMAIL_INTAKE, FEATURES.TRANSCRIPT_INTAKE],
  },
  {
    label: 'Integrations',
    features: [FEATURES.EXCEL_OPS, FEATURES.OPENCLOUD],
  },
  {
    label: 'Data',
    features: [FEATURES.DATASET_REUSE, FEATURES.RETRAIN],
  },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function FeatureGatePanel() {
  const [open, setOpen] = useState(false);

  // Subscribe to flag changes so toggles re-render
  useSyncExternalStore(subscribe, getSnapshot);

  const flags = getAllFlags();
  const enabledCount = getEnabledFeatures().length;
  const totalCount = Object.keys(FEATURES).length;

  const handleToggle = useCallback((featureId) => {
    toggle(featureId, !isEnabled(featureId));
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 99999,
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: enabledCount > 0 ? '#4f46e5' : '#6b7280',
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 700,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title={`Feature Gates: ${enabledCount}/${totalCount} ON`}
      >
        {enabledCount}/{totalCount}
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 99999,
        width: 320,
        maxHeight: 'calc(100vh - 32px)',
        background: '#1e1e2e',
        color: '#cdd6f4',
        borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 13,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #313244',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>
          Feature Gates ({enabledCount}/{totalCount})
        </span>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: 'none',
            border: 'none',
            color: '#6c7086',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Bulk actions */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #313244',
        display: 'flex',
        gap: 8,
      }}>
        <button
          onClick={handleEnableAll}
          style={{
            flex: 1,
            padding: '6px 0',
            borderRadius: 6,
            border: 'none',
            background: '#4f46e5',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Enable All
        </button>
        <button
          onClick={handleDisableAll}
          style={{
            flex: 1,
            padding: '6px 0',
            borderRadius: 6,
            border: 'none',
            background: '#45475a',
            color: '#cdd6f4',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Disable All
        </button>
      </div>

      {/* Toggle list */}
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
        {CATEGORIES.map(cat => (
          <div key={cat.label}>
            <div style={{
              padding: '8px 16px 4px',
              fontSize: 11,
              fontWeight: 700,
              color: '#6c7086',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {cat.label}
            </div>
            {cat.features.map(featureId => (
              <label
                key={featureId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 16px',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#313244'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ color: flags[featureId] ? '#a6e3a1' : '#6c7086' }}>
                  {featureId}
                </span>
                <div
                  onClick={(e) => { e.preventDefault(); handleToggle(featureId); }}
                  style={{
                    width: 36,
                    height: 20,
                    borderRadius: 10,
                    background: flags[featureId] ? '#4f46e5' : '#45475a',
                    position: 'relative',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    position: 'absolute',
                    top: 2,
                    left: flags[featureId] ? 18 : 2,
                    transition: 'left 0.15s',
                  }} />
                </div>
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
