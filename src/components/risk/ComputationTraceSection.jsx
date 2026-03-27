/**
 * Computation Trace Section - Collapsible "How was this computed?" panel
 * Shows step-by-step computation trace with inputs, results, and formulas.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, HelpCircle, ArrowRight, Lightbulb } from 'lucide-react';

const ComputationTraceSection = ({ trace }) => {
  const [expanded, setExpanded] = useState(false);

  if (!trace || !trace.steps || trace.steps.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-2 w-full text-left"
      >
        <HelpCircle className="w-4 h-4 text-[var(--brand-600)]" />
        <h4 className="font-semibold text-slate-700 dark:text-slate-300 flex-1">
          How was this computed?
        </h4>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {expanded && (
        <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-3">
          {/* Computation Steps */}
          {trace.steps.map((step, idx) => (
            <div key={step.label} className="text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-5 h-5 flex items-center justify-center rounded-full bg-[var(--accent-active)] text-[var(--brand-600)] text-[10px] font-bold">
                  {idx + 1}
                </span>
                <span className="font-semibold text-slate-700 dark:text-slate-300">{step.label}</span>
              </div>
              <div className="ml-7 space-y-0.5">
                <div className="text-slate-500 dark:text-slate-400">
                  <span className="font-medium">Inputs:</span>{' '}
                  {Object.entries(step.inputs || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ')}
                </div>
                <div className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                  <ArrowRight className="w-3 h-3" />
                  {Object.entries(step.result || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ')}
                </div>
                {step.formula && (
                  <div className="font-mono text-[10px] text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5 inline-block mt-0.5">
                    {step.formula}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* What-if Hints */}
          {trace.what_if_hints && trace.what_if_hints.length > 0 && (
            <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-1 mb-1.5">
                <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                  To improve this row&apos;s data quality:
                </span>
              </div>
              {trace.what_if_hints.map((hint, idx) => {
                const isCritical = hint.urgency === 'critical';
                const bgClass = isCritical
                  ? 'bg-red-50 dark:bg-red-900/10'
                  : 'bg-amber-50 dark:bg-amber-900/10';
                const titleClass = isCritical
                  ? 'text-red-800 dark:text-red-200'
                  : 'text-amber-800 dark:text-amber-200';
                const bodyClass = isCritical
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400';

                return (
                  <div key={idx} className={`text-xs ${bgClass} rounded p-2 mb-1`}>
                    <div className={`font-medium ${titleClass}`}>
                      {hint.action}
                    </div>
                    <div className={`${bodyClass} mt-0.5`}>
                      {hint.currentState} &rarr; {hint.potentialState}
                    </div>
                    {hint.estimatedImpact && (
                      <div className="text-[var(--brand-600)] mt-0.5 font-medium">
                        Impact: {hint.estimatedImpact}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ComputationTraceSection;
