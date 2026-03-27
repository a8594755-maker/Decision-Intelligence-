import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Zap
} from 'lucide-react';
import { Card, Badge } from '../ui';
import { translateConstraintTag } from '../../utils/proofFormatter';

const categoryMeta = (category) => {
  const map = {
    capacity: {
      color: 'text-red-700 dark:text-red-300',
      bg: 'bg-red-100 dark:bg-red-900/20',
      label: 'Capacity'
    },
    budget: {
      color: 'text-orange-700 dark:text-orange-300',
      bg: 'bg-orange-100 dark:bg-orange-900/20',
      label: 'Budget'
    },
    moq_pack: {
      color: 'text-amber-700 dark:text-amber-300',
      bg: 'bg-amber-100 dark:bg-amber-900/20',
      label: 'Lot-Sizing'
    },
    demand_infeasible: {
      color: 'text-rose-700 dark:text-rose-300',
      bg: 'bg-rose-100 dark:bg-rose-900/20',
      label: 'Demand'
    },
    bom_shortage: {
      color: 'text-fuchsia-700 dark:text-fuchsia-300',
      bg: 'bg-fuchsia-100 dark:bg-fuchsia-900/20',
      label: 'BOM'
    },
    lead_time: {
      color: 'text-blue-700 dark:text-blue-300',
      bg: 'bg-blue-100 dark:bg-blue-900/20',
      label: 'Lead Time'
    }
  };

  return map[category] || {
    color: 'text-[var(--text-secondary)]',
    bg: 'bg-[var(--surface-subtle)]',
    label: category || 'Unknown'
  };
};

const toBusinessConstraintLabel = (constraint) => (
  translateConstraintTag(constraint?.tag, constraint?.sku)
  || constraint?.description
  || constraint?.name
  || 'Unknown constraint'
);

const formatObjectiveValue = (name, value) => {
  if (value == null) return 'n/a';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);

  if (/cost|penalty|budget/i.test(String(name || ''))) {
    return `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  if (/level|rate|pct/i.test(String(name || '')) && numeric <= 1) {
    return `${(numeric * 100).toFixed(1)}%`;
  }
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const formatGap = (gap) => {
  const numeric = Number(gap);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === 0) return 'Optimal (0%)';
  const pct = numeric <= 1 ? numeric * 100 : numeric;
  return `${pct.toFixed(2)}%`;
};

function ConstraintRow({ constraint, isBinding }) {
  const [expanded, setExpanded] = useState(false);
  const label = toBusinessConstraintLabel(constraint);

  return (
    <li className="border border-[var(--border-default)] rounded-md overflow-hidden">
      <button
        type="button"
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--accent-hover)] transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        {isBinding ? (
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-red-500 shrink-0" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
        )}
        <span className="flex-1 text-xs font-medium text-[var(--text-secondary)] leading-tight">
          {label}
        </span>
        {constraint?.severity && isBinding && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${constraint.severity === 'hard'
            ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}`}
          >
            {String(constraint.severity)}
          </span>
        )}
        {constraint?.tag && (
          <span className="text-[10px] font-mono text-[var(--text-muted)] ml-1 shrink-0">
            {String(constraint.tag).length > 24 ? `${String(constraint.tag).slice(0, 24)}...` : String(constraint.tag)}
          </span>
        )}
        <span className="ml-1 text-[var(--text-muted)]">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-[var(--surface-subtle)] border-t border-[var(--border-default)] space-y-1.5 text-[11px] text-[var(--text-secondary)]">
          {constraint?.details && (
            <p><span className="font-medium text-[var(--text-secondary)]">Details:</span> {String(constraint.details)}</p>
          )}
          {constraint?.description && constraint.description !== label && (
            <p><span className="font-medium text-[var(--text-secondary)]">Description:</span> {String(constraint.description)}</p>
          )}
          {constraint?.sku && (
            <p><span className="font-medium text-[var(--text-secondary)]">SKU:</span> {String(constraint.sku)}</p>
          )}
          {constraint?.period && (
            <p><span className="font-medium text-[var(--text-secondary)]">Period:</span> {String(constraint.period)}</p>
          )}
          {constraint?.scope && constraint.scope !== 'global' && (
            <p><span className="font-medium text-[var(--text-secondary)]">Scope:</span> {String(constraint.scope)}</p>
          )}
        </div>
      )}
    </li>
  );
}

function ObjectiveTermsPanel({ terms }) {
  if (!Array.isArray(terms) || terms.length === 0) return null;

  return (
    <div>
      <p className="font-medium text-[var(--text-secondary)] mb-1.5 text-xs flex items-center gap-1.5">
        <Zap className="w-3.5 h-3.5 text-blue-500" />
        Objective Breakdown
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {terms.map((term, index) => (
          <div
            key={`${term?.name || 'term'}-${index}`}
            className="flex justify-between items-center rounded bg-[var(--surface-subtle)] px-2.5 py-1.5 gap-2"
          >
            <span className="text-[11px] text-[var(--text-muted)] capitalize truncate max-w-[65%]">
              {String(term?.name || 'term').replace(/_/g, ' ')}
            </span>
            <span className="text-[11px] font-semibold text-[var(--text-secondary)] shrink-0">
              {formatObjectiveValue(term?.name, term?.value)}
            </span>
          </div>
        ))}
      </div>
      {terms.some((term) => term?.note) && (
        <p className="text-[10px] text-[var(--text-muted)] mt-1 italic">
          {String(terms.find((term) => term?.note)?.note || '')}
        </p>
      )}
    </div>
  );
}

function SuggestedActionsPanel({ actions }) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  return (
    <div>
      <p className="font-medium text-[var(--text-secondary)] mb-1.5 text-xs flex items-center gap-1.5">
        <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
        Solver Suggestions
      </p>
      <ul className="space-y-1">
        {actions.map((action, index) => (
          <li
            key={`action-${index}`}
            className="flex items-start gap-1.5 text-[11px] text-[var(--text-secondary)]"
          >
            <span className="shrink-0 w-4 h-4 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[9px] font-bold flex items-center justify-center mt-0.5">
              {index + 1}
            </span>
            <span>{String(action)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PlanExceptionsCard({ payload }) {
  const [showPassing, setShowPassing] = useState(false);

  if (!payload) return null;

  const infeasibleReasons = Array.isArray(payload.infeasible_reasons) ? payload.infeasible_reasons : [];
  const violations = Array.isArray(payload.constraint_violations) ? payload.constraint_violations : [];
  const roundingNotes = Array.isArray(payload.rounding_notes) ? payload.rounding_notes : [];
  const bomBottlenecks = Array.isArray(payload.bom_bottlenecks) ? payload.bom_bottlenecks : [];
  const bindingConstraints = Array.isArray(payload.binding_constraints) ? payload.binding_constraints : [];
  const passingConstraints = Array.isArray(payload.passing_constraints) ? payload.passing_constraints : [];
  const objectiveTerms = Array.isArray(payload.objective_terms) ? payload.objective_terms : [];
  const suggestedActions = Array.isArray(payload.suggested_actions) ? payload.suggested_actions : [];
  const infeasibilityCategories = Array.isArray(payload.infeasibility_categories) ? payload.infeasibility_categories : [];
  const solverGap = payload.solver_gap ?? null;
  const solverEngine = payload.solver_engine || null;
  const solveTimeMs = payload.solve_time_ms ?? null;
  const issueCount = bindingConstraints.length + violations.length;

  const allClear = infeasibleReasons.length === 0
    && violations.length === 0
    && roundingNotes.length === 0
    && bomBottlenecks.length === 0
    && bindingConstraints.length === 0;

  return (
    <Card category="plan" className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Exceptions &amp; Proof
          </h4>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {infeasibilityCategories.map((category) => {
              const meta = categoryMeta(category);
              return (
                <span
                  key={category}
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${meta.color} ${meta.bg}`}
                >
                  {meta.label}
                </span>
              );
            })}
            <Badge type={allClear ? 'success' : 'warning'}>
              {allClear ? 'Clear' : `${issueCount} issue${issueCount === 1 ? '' : 's'}`}
            </Badge>
          </div>
        </div>

        {(solverGap !== null || solveTimeMs !== null || solverEngine) && (
          <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)] border-b border-amber-100 dark:border-amber-800/40 pb-2">
            {solverEngine && (
              <span>
                Engine: <span className="font-mono text-[var(--text-secondary)]">{String(solverEngine)}</span>
              </span>
            )}
            {solveTimeMs !== null && (
              <span>
                Solve time: <span className="font-semibold text-[var(--text-secondary)]">{String(solveTimeMs)}ms</span>
              </span>
            )}
            {solverGap !== null && (
              <span>
                Optimality gap: <span className={`font-semibold ${Number(solverGap) === 0 ? 'text-emerald-600' : 'text-orange-600'}`}>
                  {formatGap(solverGap) || 'n/a'}
                </span>
              </span>
            )}
          </div>
        )}

        {allClear ? (
          <p className="text-xs text-[var(--text-secondary)]">No infeasible reasons or constraint violations reported.</p>
        ) : (
          <div className="space-y-4 text-xs">
            {bindingConstraints.length > 0 && (
              <div>
                <p className="font-semibold text-red-700 dark:text-red-400 mb-1.5 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Binding Constraints ({bindingConstraints.length})
                </p>
                <ul className="space-y-1.5">
                  {bindingConstraints.map((constraint, index) => (
                    <ConstraintRow
                      key={`binding-${constraint?.name || 'constraint'}-${constraint?.tag || 'untagged'}-${index}`}
                      constraint={constraint}
                      isBinding
                    />
                  ))}
                </ul>
              </div>
            )}

            {infeasibleReasons.length > 0 && (
              <div>
                <p className="font-medium text-[var(--text-secondary)] mb-1">Solver reasons</p>
                <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-1">
                  {infeasibleReasons.slice(0, 8).map((reason, idx) => (
                    <li key={`${reason}-${idx}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {violations.length > 0 && (
              <div>
                <p className="font-medium text-[var(--text-secondary)] mb-1">Constraint violations</p>
                <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-1">
                  {violations.slice(0, 8).map((violation, idx) => (
                    <li key={`${violation.rule}-${idx}`}>
                      <strong>{violation.rule}</strong>: {violation.details}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {roundingNotes.length > 0 && (
              <div>
                <p className="font-medium text-[var(--text-secondary)] mb-1">Rounding adjustments</p>
                <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-1">
                  {roundingNotes.slice(0, 8).map((note, idx) => (
                    <li key={`${note}-${idx}`}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {bomBottlenecks.length > 0 && (
              <div>
                <p className="font-medium text-[var(--text-secondary)] mb-1">Top BOM bottlenecks</p>
                <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-1">
                  {bomBottlenecks.slice(0, 5).map((row, idx) => (
                    <li key={`${row.component_sku}-${idx}`}>
                      <strong>{row.component_sku}</strong>: missing {Number(row.missing_qty || 0).toFixed(2)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {objectiveTerms.length > 0 && (
          <div className="border-t border-amber-100 dark:border-amber-800/40 pt-3">
            <ObjectiveTermsPanel terms={objectiveTerms} />
          </div>
        )}

        {suggestedActions.length > 0 && !allClear && (
          <div className="border-t border-amber-100 dark:border-amber-800/40 pt-3">
            <SuggestedActionsPanel actions={suggestedActions} />
          </div>
        )}

        {passingConstraints.length > 0 && (
          <div className="border-t border-amber-100 dark:border-amber-800/40 pt-2">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              onClick={() => setShowPassing((prev) => !prev)}
            >
              {showPassing ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showPassing ? 'Hide' : 'Show'} passing constraints ({passingConstraints.length})
            </button>
            {showPassing && (
              <ul className="mt-2 space-y-1.5">
                {passingConstraints.map((constraint, index) => (
                  <ConstraintRow
                    key={`passing-${constraint?.name || 'constraint'}-${constraint?.tag || 'untagged'}-${index}`}
                    constraint={constraint}
                    isBinding={false}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
