/**
 * FirstRunGuide
 *
 * Modal shown on first login. Walks users through the core workflow:
 * 1. Upload data → 2. Review mapping → 3. Run plan → 4. Interpret results
 */

import React, { useState, useEffect } from 'react';
import { Upload, CheckCircle, Calculator, BarChart3, ArrowRight, X } from 'lucide-react';
import { Button } from '../ui';

const STORAGE_KEY = 'di_first_run_completed';

const STEPS = [
  {
    icon: Upload,
    title: 'Upload Your Data',
    description: 'Upload an Excel file with demand forecast, inventory, and optionally open POs, financials, or BOM data. The system auto-detects each sheet\'s data type.',
    color: 'text-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
  },
  {
    icon: CheckCircle,
    title: 'Review & Confirm Mapping',
    description: 'The system maps your Excel columns to standard fields. Review low-confidence mappings, confirm or correct them, and the system remembers your mapping for next time.',
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
  },
  {
    icon: Calculator,
    title: 'Run a Plan',
    description: 'Click "Run Workflow A" to generate a replenishment plan. The system calculates optimal order quantities, considering inventory, demand forecasts, and lead times.',
    color: 'text-indigo-600',
    bg: 'bg-indigo-50 dark:bg-indigo-900/20',
  },
  {
    icon: BarChart3,
    title: 'Interpret Results',
    description: 'See your plan table, risk assessment, data quality report, and recommended actions. Each result shows its data confidence — fields marked "estimated" used system defaults.',
    color: 'text-purple-600',
    bg: 'bg-purple-50 dark:bg-purple-900/20',
  },
];

export default function FirstRunGuide() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setVisible(true);
      }
    } catch {
      // Private browsing — show anyway
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // Ignore
    }
  };

  if (!visible) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Getting Started</span>
            <span className="text-xs text-slate-300">{step + 1} / {STEPS.length}</span>
          </div>
          <button onClick={dismiss} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-6 text-center">
          <div className={`w-14 h-14 mx-auto mb-4 rounded-xl ${current.bg} flex items-center justify-center`}>
            <Icon className={`w-7 h-7 ${current.color}`} />
          </div>
          <h2 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            {current.title}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            {current.description}
          </p>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5 pb-4">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === step ? 'bg-indigo-600' : i < step ? 'bg-indigo-300' : 'bg-slate-200 dark:bg-slate-700'
              }`}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-6 pb-5">
          <button
            onClick={dismiss}
            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            Skip tour
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep(s => s - 1)}>
                Back
              </Button>
            )}
            {isLast ? (
              <Button variant="primary" size="sm" onClick={dismiss}>
                Get Started
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setStep(s => s + 1)}>
                Next <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
