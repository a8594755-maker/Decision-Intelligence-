/**
 * NegotiationWidget — Pure canvas widget for negotiation artifacts.
 * Renders CFR strategy, negotiation options, and evaluation results.
 *
 * Supports: negotiation_report, cfr_negotiation_strategy, negotiation_evaluation
 */

import React from 'react';
import { Handshake, Target, TrendingUp, AlertTriangle } from 'lucide-react';

function StrategyBar({ label, probability, color }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-24 text-right" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <div className="flex-1 h-5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-raised)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(probability * 100, 100)}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-mono w-12 text-right">{(probability * 100).toFixed(1)}%</span>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.data
 * @param {object} [props.data.strategy] - CFR strategy probabilities
 * @param {Array}  [props.data.options] - negotiation options
 * @param {object} [props.data.evaluation] - option evaluation scores
 * @param {object} [props.data.recommendation] - recommended action
 */
export default function NegotiationWidget({ data = {} }) {
  const strategy = data.strategy || data.cfr_strategy || {};
  const options = data.options || [];
  const recommendation = data.recommendation || data.recommended_action;

  const strategyEntries = Object.entries(strategy).filter(([k]) => typeof strategy[k] === 'number');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <Handshake size={18} className="text-orange-500" />
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Negotiation Analysis</h3>
      </div>

      <div className="flex-1 overflow-auto px-4 py-4 space-y-6">
        {/* Strategy Distribution */}
        {strategyEntries.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>
              Strategy Distribution (CFR)
            </h4>
            <div className="space-y-2">
              {strategyEntries.map(([label, prob]) => (
                <StrategyBar
                  key={label}
                  label={label}
                  probability={prob}
                  color={label.toLowerCase().includes('aggressive') ? '#ef4444' : label.toLowerCase().includes('cooperative') ? '#22c55e' : '#6366f1'}
                />
              ))}
            </div>
          </div>
        )}

        {/* Recommendation */}
        {recommendation && (
          <div className="p-3 rounded-lg border-l-4 border-orange-500" style={{ backgroundColor: 'var(--surface-raised)' }}>
            <div className="flex items-center gap-1.5 mb-1">
              <Target size={14} className="text-orange-500" />
              <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Recommendation</span>
            </div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {typeof recommendation === 'string' ? recommendation : recommendation.summary || recommendation.action}
            </p>
          </div>
        )}

        {/* Options */}
        {options.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>
              Negotiation Options ({options.length})
            </h4>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="p-3 rounded-lg border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">{opt.name || opt.label || `Option ${i + 1}`}</span>
                    {opt.score != null && (
                      <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                        Score: {opt.score.toFixed(2)}
                      </span>
                    )}
                  </div>
                  {opt.description && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{opt.description}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {strategyEntries.length === 0 && options.length === 0 && (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No negotiation data available
          </div>
        )}
      </div>
    </div>
  );
}
