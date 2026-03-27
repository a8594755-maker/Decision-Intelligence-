/**
 * DecisionReviewPanel — Manager-facing artifact review UI
 *
 * Renders decision_brief + evidence_pack_v2 + writeback_payload for human review.
 * Produces a review resolution via reviewContract.js.
 *
 * Props:
 *   decisionBrief:    decision_brief artifact payload
 *   evidencePack:     evidence_pack_v2 artifact payload
 *   writebackPayload: writeback_payload artifact payload
 *   taskMeta:         { id, title, workflowType }
 *   onResolve:        (resolution) => void
 */

import React, { useState } from 'react';
import {
  CheckCircle2, XCircle, AlertTriangle, RotateCcw, ArrowUpRight,
  Clock, ShieldCheck, FileSearch, TrendingUp, TrendingDown,
  ChevronDown, ChevronUp, Package, Layers, Gauge,
} from 'lucide-react';
import { REVIEW_DECISIONS, createReviewResolution } from '../../contracts/reviewContract';

// ── Confidence gauge ────────────────────────────────────────────────────────

function ConfidenceGauge({ score }) {
  const pct = Math.round((score || 0) * 100);
  const color = pct >= 70 ? 'text-emerald-600' : pct >= 50 ? 'text-amber-600' : 'text-red-600';
  const bg = pct >= 70 ? 'bg-emerald-100' : pct >= 50 ? 'bg-amber-100' : 'bg-red-100';
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${color} ${bg}`}>
      <Gauge className="w-3 h-3" />
      {pct}% confidence
    </div>
  );
}

// ── Risk flag badge ─────────────────────────────────────────────────────────

function RiskBadge({ flag }) {
  const colors = {
    high: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  };
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${colors[flag.level] || colors.low}`}>
      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
      <span>{flag.description}</span>
    </div>
  );
}

// ── Mutation row ────────────────────────────────────────────────────────────

function MutationRow({ mutation, index }) {
  const fc = mutation.field_changes || {};
  return (
    <tr className="border-b border-slate-100 dark:border-slate-700 text-xs">
      <td className="py-1.5 pr-2 text-slate-400">{index + 1}</td>
      <td className="py-1.5 pr-3 font-mono">{fc.material_code || '—'}</td>
      <td className="py-1.5 pr-3">{fc.plant_id || '—'}</td>
      <td className="py-1.5 pr-3 font-medium">{mutation.action}</td>
      <td className="py-1.5 pr-3 text-right">{fc.quantity ?? '—'}</td>
      <td className="py-1.5 text-slate-500">{fc.delivery_date || '—'}</td>
    </tr>
  );
}

// ── Section wrapper ─────────────────────────────────────────────────────────

function Section({ title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const iconNode = Icon ? React.createElement(Icon, { className: 'w-4 h-4' }) : null;
  return (
    <div className="border-t border-slate-200 dark:border-slate-700">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-2 px-1 text-sm font-medium text-slate-700 dark:text-slate-200 hover:text-slate-900"
      >
        <span className="flex items-center gap-2">
          {iconNode}
          {title}
        </span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {open && <div className="pb-3 px-1">{children}</div>}
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────────

export default function DecisionReviewPanel({
  decisionBrief,
  evidencePack,
  writebackPayload,
  taskMeta = {},
  onResolve,
}) {
  const [decision, setDecision] = useState(null);
  const [notes, setNotes] = useState('');
  const [publishPerm, setPublishPerm] = useState({ export: true, writeback: false, notify: false });
  const [revisionInstructions, setRevisionInstructions] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const brief = decisionBrief || {};
  const evidence = evidencePack || {};
  const writeback = writebackPayload || {};

  const mutations = writeback.intended_mutations || [];
  const riskFlags = brief.risk_flags || [];
  const assumptions = brief.assumptions || [];
  const impact = brief.business_impact || {};

  const mutationSummary = writeback.mutation_summary || {};

  function handleSubmit() {
    if (!decision) return;
    const resolution = createReviewResolution({
      decision,
      reviewer_id: 'current_user', // replaced by caller
      task_id: taskMeta.id || 'unknown',
      review_notes: notes,
      approved_actions: decision === REVIEW_DECISIONS.APPROVED
        ? mutations.map(m => m.action) : [],
      rejected_actions: decision === REVIEW_DECISIONS.REJECTED
        ? mutations.map(m => m.action) : [],
      publish_permission: decision === REVIEW_DECISIONS.APPROVED ? publishPerm : { export: false, writeback: false, notify: false },
      revision_instructions: decision === REVIEW_DECISIONS.REVISION_REQUESTED ? revisionInstructions : null,
    });
    setSubmitted(true);
    onResolve?.(resolution);
  }

  if (submitted) {
    const label = {
      [REVIEW_DECISIONS.APPROVED]: 'Approved',
      [REVIEW_DECISIONS.REJECTED]: 'Rejected',
      [REVIEW_DECISIONS.REVISION_REQUESTED]: 'Revision Requested',
      [REVIEW_DECISIONS.ESCALATED]: 'Escalated',
      [REVIEW_DECISIONS.DEFERRED]: 'Deferred',
    }[decision] || decision;

    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-6 text-center">
        <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-medium">Review submitted: <span className="font-semibold">{label}</span></p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-[var(--brand-50)] to-white dark:from-[var(--brand-50)] dark:to-slate-900 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Decision Review
            </h3>
            {taskMeta.title && (
              <p className="text-xs text-slate-500 mt-0.5">{taskMeta.title}</p>
            )}
          </div>
          <ConfidenceGauge score={brief.confidence} />
        </div>
      </div>

      <div className="px-4 py-3 space-y-0">
        {/* Recommendation */}
        <Section title="Recommendation" icon={ShieldCheck}>
          <p className="text-sm text-slate-700 dark:text-slate-200 mb-2">{brief.summary}</p>
          {brief.recommended_action_label && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-active)] text-[var(--brand-600)] text-sm font-medium">
              <ArrowUpRight className="w-4 h-4" />
              {brief.recommended_action_label}
            </div>
          )}
        </Section>

        {/* Business Impact */}
        {Object.keys(impact).length > 0 && (
          <Section title="Business Impact" icon={TrendingUp}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {impact.total_cost !== undefined && (
                <KpiTile label="Total Cost" value={`$${Number(impact.total_cost).toLocaleString()}`} />
              )}
              {impact.total_order_qty !== undefined && (
                <KpiTile label="Order Qty" value={Number(impact.total_order_qty).toLocaleString()} />
              )}
              {impact.service_level_impact && (
                <KpiTile label="Service Level" value={impact.service_level_impact} positive={impact.service_level_impact.startsWith('+')} />
              )}
              {impact.stockouts_prevented !== undefined && (
                <KpiTile label="Stockouts Prevented" value={impact.stockouts_prevented} />
              )}
              {impact.units_affected !== undefined && (
                <KpiTile label="Units Affected" value={Number(impact.units_affected).toLocaleString()} />
              )}
            </div>
          </Section>
        )}

        {/* Risk Flags */}
        {riskFlags.length > 0 && (
          <Section title={`Risk Flags (${riskFlags.length})`} icon={AlertTriangle}>
            <div className="space-y-1.5">
              {riskFlags.map((f, i) => <RiskBadge key={i} flag={f} />)}
            </div>
          </Section>
        )}

        {/* Writeback Mutations */}
        {mutations.length > 0 && (
          <Section title={`Intended Mutations (${mutations.length})`} icon={Package} defaultOpen={mutations.length <= 10}>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-200 dark:border-slate-700">
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-3">SKU</th>
                    <th className="py-1 pr-3">Site</th>
                    <th className="py-1 pr-3">Action</th>
                    <th className="py-1 pr-3 text-right">Qty</th>
                    <th className="py-1">Delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {mutations.slice(0, 20).map((m, i) => <MutationRow key={i} mutation={m} index={i} />)}
                </tbody>
              </table>
              {mutations.length > 20 && (
                <p className="text-xs text-slate-400 mt-1">...and {mutations.length - 20} more</p>
              )}
            </div>
            <div className="mt-2 flex gap-3 text-xs text-slate-500">
              <span>{mutationSummary.unique_skus || 0} SKUs</span>
              <span>{mutationSummary.unique_sites || 0} sites</span>
              <span>{mutationSummary.total_qty || 0} total qty</span>
            </div>
          </Section>
        )}

        {/* Evidence */}
        <Section title="Evidence & Provenance" icon={FileSearch} defaultOpen={false}>
          {evidence.source_datasets?.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Source Datasets</p>
              <div className="space-y-1">
                {evidence.source_datasets.map((ds, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <Layers className="w-3 h-3 text-slate-400" />
                    <span className="font-mono">{ds.name}</span>
                    {ds.row_count && <span className="text-slate-400">({ds.row_count} rows)</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {evidence.calculation_logic && (
            <div className="mb-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Calculation Logic</p>
              <p className="text-xs text-slate-600 dark:text-slate-300">{evidence.calculation_logic}</p>
            </div>
          )}
          {evidence.engine_versions && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Engine Versions</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(evidence.engine_versions).map(([k, v]) => (
                  <span key={k} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-mono text-slate-500">
                    {k}: {v}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* Assumptions */}
        {assumptions.length > 0 && (
          <Section title="Assumptions" icon={Clock} defaultOpen={false}>
            <ul className="list-disc list-inside space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
              {assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </Section>
        )}

        {/* ── Decision controls ────────────────────────────────────── */}
        <div className="border-t border-slate-200 dark:border-slate-700 pt-3 mt-1">
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">Your Decision</p>

          {/* Decision buttons */}
          <div className="flex flex-wrap gap-2 mb-3">
            <DecisionButton
              active={decision === REVIEW_DECISIONS.APPROVED}
              onClick={() => setDecision(REVIEW_DECISIONS.APPROVED)}
              icon={CheckCircle2} label="Approve" color="emerald"
            />
            <DecisionButton
              active={decision === REVIEW_DECISIONS.REJECTED}
              onClick={() => setDecision(REVIEW_DECISIONS.REJECTED)}
              icon={XCircle} label="Reject" color="red"
            />
            <DecisionButton
              active={decision === REVIEW_DECISIONS.REVISION_REQUESTED}
              onClick={() => setDecision(REVIEW_DECISIONS.REVISION_REQUESTED)}
              icon={RotateCcw} label="Request Revision" color="amber"
            />
            <DecisionButton
              active={decision === REVIEW_DECISIONS.DEFERRED}
              onClick={() => setDecision(REVIEW_DECISIONS.DEFERRED)}
              icon={Clock} label="Defer" color="slate"
            />
          </div>

          {/* Publish permissions (only for approve) */}
          {decision === REVIEW_DECISIONS.APPROVED && (
            <div className="mb-3 p-2 rounded bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
              <p className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300 mb-1.5">
                Publish Permissions
              </p>
              <div className="flex gap-4">
                <PermToggle label="Export" checked={publishPerm.export} onChange={v => setPublishPerm(p => ({ ...p, export: v }))} />
                <PermToggle label="Writeback" checked={publishPerm.writeback} onChange={v => setPublishPerm(p => ({ ...p, writeback: v }))} />
                <PermToggle label="Notify" checked={publishPerm.notify} onChange={v => setPublishPerm(p => ({ ...p, notify: v }))} />
              </div>
            </div>
          )}

          {/* Revision instructions */}
          {decision === REVIEW_DECISIONS.REVISION_REQUESTED && (
            <textarea
              value={revisionInstructions}
              onChange={e => setRevisionInstructions(e.target.value)}
              placeholder="What should be revised?"
              className="w-full mb-3 px-2 py-1.5 border border-amber-300 dark:border-amber-700 rounded text-xs bg-amber-50 dark:bg-amber-900/20 text-slate-700 dark:text-slate-200 placeholder-slate-400"
              rows={2}
            />
          )}

          {/* Notes */}
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Review notes (optional)"
            className="w-full mb-3 px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded text-xs bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder-slate-400"
            rows={2}
          />

          {/* Submit */}
          <button
            disabled={!decision}
            onClick={handleSubmit}
            className={`w-full py-2 rounded text-sm font-medium transition-colors ${
              decision
                ? 'bg-[var(--brand-600)] text-white hover:bg-[var(--brand-700)]'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            }`}
          >
            Submit Review
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small sub-components ────────────────────────────────────────────────────

function KpiTile({ label, value, positive }) {
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <div className="p-2 rounded bg-slate-50 dark:bg-slate-800">
      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">{label}</p>
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1">
        {positive !== undefined && <Icon className={`w-3 h-3 ${positive ? 'text-emerald-500' : 'text-red-500'}`} />}
        {value}
      </p>
    </div>
  );
}

// Static Tailwind class map — dynamic `bg-${color}-100` gets purged in production
const DECISION_BUTTON_STYLES = {
  emerald: 'bg-emerald-100 dark:bg-emerald-900/40 border-emerald-400 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-400',
  red:     'bg-red-100 dark:bg-red-900/40 border-red-400 text-red-700 dark:text-red-300 ring-1 ring-red-400',
  amber:   'bg-amber-100 dark:bg-amber-900/40 border-amber-400 text-amber-700 dark:text-amber-300 ring-1 ring-amber-400',
  slate:   'bg-slate-100 dark:bg-slate-900/40 border-slate-400 text-slate-700 dark:text-slate-300 ring-1 ring-slate-400',
};

function DecisionButton({ active, onClick, icon: Icon, label, color }) {
  const base = active
    ? DECISION_BUTTON_STYLES[color] || DECISION_BUTTON_STYLES.slate
    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300';
  const iconNode = React.createElement(Icon, { className: 'w-3.5 h-3.5' });
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${base}`}>
      {iconNode}
      {label}
    </button>
  );
}

function PermToggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
      />
      {label}
    </label>
  );
}
