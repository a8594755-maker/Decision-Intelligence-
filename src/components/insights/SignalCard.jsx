// SignalCard.jsx — Individual signal card for the Signal Radar
// Displays detected anomalies, contradictions, concentration risks, and stale insights.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, GitCompare, PieChart, Clock,
  ArrowRight, X, ExternalLink,
} from 'lucide-react';

const TYPE_ICONS = {
  anomaly: AlertTriangle,
  contradiction: GitCompare,
  concentration: PieChart,
  stale_insight: Clock,
};

const TYPE_LABELS = {
  anomaly: 'Anomaly',
  contradiction: 'Contradiction',
  concentration: 'Concentration',
  stale_insight: 'Stale Insight',
};

const SEVERITY_STYLES = {
  critical: {
    card: 'border-l-4 border-l-red-600 bg-red-50 dark:bg-red-900/10',
    badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  high: {
    card: 'border-l-4 border-l-orange-500 bg-orange-50 dark:bg-orange-900/10',
    badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  },
  medium: {
    card: 'border-l-4 border-l-amber-400 bg-amber-50 dark:bg-amber-900/10',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
  low: {
    card: 'border-l-4 border-l-slate-300 bg-[var(--surface-subtle)]',
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  },
};

export default function SignalCard({ signal, onDismiss }) {
  const navigate = useNavigate();
  const [hovering, setHovering] = useState(false);

  const { type, severity, confidence, title, description, evidence, suggested_question } = signal;
  const Icon = TYPE_ICONS[type] || AlertTriangle;
  const styles = SEVERITY_STYLES[severity] || SEVERITY_STYLES.low;

  const handleAskInWorkspace = () => {
    if (suggested_question) {
      navigate('/workspace', { state: { insightQuery: suggested_question } });
    }
  };

  const handleViewEvidence = (ev) => {
    if (ev.snapshot_id) {
      // Jump to the snapshot's original conversation (if available)
      navigate(`/insights`);
    }
  };

  return (
    <div
      className={`relative rounded-xl p-4 transition-all duration-200 ${styles.card}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Icon className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">{title}</h3>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${styles.badge}`}>
            {severity}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-tertiary)]">
            {TYPE_LABELS[type]}
          </span>
          {confidence > 0 && (
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {Math.round(confidence * 100)}%
            </span>
          )}
          {/* Dismiss button */}
          {hovering && onDismiss && (
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(signal.id); }}
              className="p-0.5 rounded hover:bg-black/10 text-[var(--text-tertiary)]"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-[var(--text-secondary)] mb-2 line-clamp-2">{description}</p>

      {/* Evidence chips */}
      {evidence?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {evidence.map((ev, i) => (
            <button
              key={i}
              onClick={() => handleViewEvidence(ev)}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-white/60 dark:bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title={ev.headline}
            >
              {ev.metric && <span className="font-medium">{ev.metric}:</span>}
              <span>{ev.value}</span>
              {ev.date && <span className="text-[var(--text-tertiary)]">{ev.date}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Suggested question + action */}
      {suggested_question && (
        <button
          onClick={handleAskInWorkspace}
          className="flex items-center gap-1.5 text-xs text-[var(--brand-600)] hover:text-[var(--brand-700)] hover:underline mt-1"
        >
          <ArrowRight className="w-3 h-3 shrink-0" />
          <span className="italic text-left line-clamp-1">{suggested_question}</span>
        </button>
      )}
    </div>
  );
}
