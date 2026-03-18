/**
 * ApprovalWidget — Pure canvas widget for review/approval flows.
 * Receives a decision_bundle or review_result artifact and renders
 * an actionable approval card on the canvas.
 */

import React, { useState } from 'react';
import { CheckCircle, XCircle, MessageSquare, AlertTriangle, FileText } from 'lucide-react';

function Section({ title, icon: Icon, children }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-1.5 mb-2">
        {Icon && <Icon size={14} style={{ color: 'var(--text-muted)' }} />}
        <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{title}</h4>
      </div>
      {children}
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.data
 * @param {string} [props.data.task_id]
 * @param {string} [props.data.summary]
 * @param {string} [props.data.recommendation]
 * @param {Array}  [props.data.drivers] - [{ label, impact, direction }]
 * @param {Array}  [props.data.kpi_impacts] - [{ kpi, before, after }]
 * @param {Array}  [props.data.blockers]
 * @param {Array}  [props.data.next_actions]
 * @param {Function} [props.onApprove]
 * @param {Function} [props.onReject]
 * @param {Function} [props.onRequestChanges]
 */
export default function ApprovalWidget({ data = {}, onApprove, onReject, onRequestChanges }) {
  const [feedback, setFeedback] = useState('');
  const [status, setStatus] = useState('pending'); // pending | approved | rejected | changes_requested

  const handleApprove = () => {
    setStatus('approved');
    onApprove?.({ task_id: data.task_id, feedback });
  };

  const handleReject = () => {
    setStatus('rejected');
    onReject?.({ task_id: data.task_id, feedback });
  };

  const handleRequestChanges = () => {
    setStatus('changes_requested');
    onRequestChanges?.({ task_id: data.task_id, feedback });
  };

  const isResolved = status !== 'pending';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-indigo-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Review & Approve</h3>
        </div>
        {isResolved && (
          <span className={`flex items-center gap-1 text-xs font-semibold ${
            status === 'approved' ? 'text-emerald-600' : status === 'rejected' ? 'text-red-600' : 'text-amber-600'
          }`}>
            {status === 'approved' && <><CheckCircle size={14} /> Approved</>}
            {status === 'rejected' && <><XCircle size={14} /> Rejected</>}
            {status === 'changes_requested' && <><MessageSquare size={14} /> Changes Requested</>}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
        {/* Summary */}
        {data.summary && (
          <Section title="Summary" icon={FileText}>
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{data.summary}</p>
          </Section>
        )}

        {/* Recommendation */}
        {data.recommendation && (
          <div className="p-3 rounded-lg border-l-4 border-indigo-500" style={{ backgroundColor: 'var(--surface-raised)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Recommendation</span>
            <p className="text-sm mt-1 font-medium" style={{ color: 'var(--text-primary)' }}>{data.recommendation}</p>
          </div>
        )}

        {/* Drivers */}
        {data.drivers?.length > 0 && (
          <Section title="Key Drivers">
            <div className="space-y-1">
              {data.drivers.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-1">
                  <span>{d.label || d}</span>
                  {d.impact && (
                    <span className={`text-xs font-mono ${d.direction === 'positive' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {d.direction === 'positive' ? '+' : ''}{d.impact}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* KPI Impacts */}
        {data.kpi_impacts?.length > 0 && (
          <Section title="KPI Impact">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left pb-1 font-medium text-xs">KPI</th>
                  <th className="text-right pb-1 font-medium text-xs">Before</th>
                  <th className="text-right pb-1 font-medium text-xs">After</th>
                </tr>
              </thead>
              <tbody>
                {data.kpi_impacts.map((k, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-1">{k.kpi}</td>
                    <td className="py-1 text-right font-mono">{k.before}</td>
                    <td className="py-1 text-right font-mono font-medium">{k.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* Blockers */}
        {data.blockers?.length > 0 && (
          <Section title="Blockers" icon={AlertTriangle}>
            <ul className="space-y-1">
              {data.blockers.map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-amber-700">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>{typeof b === 'string' ? b : b.description || b.label}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Feedback textarea */}
        {!isResolved && (
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Feedback (optional)</label>
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              rows={3}
              className="w-full text-sm rounded-lg border p-2 resize-none"
              style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}
              placeholder="Add comments or feedback..."
            />
          </div>
        )}
      </div>

      {/* Action Bar */}
      {!isResolved && (
        <div className="flex items-center gap-2 px-4 py-3 border-t" style={{ borderColor: 'var(--border-default)' }}>
          {onApprove && (
            <button
              onClick={handleApprove}
              className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
            >
              <CheckCircle size={14} /> Approve
            </button>
          )}
          {onRequestChanges && (
            <button
              onClick={handleRequestChanges}
              className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 transition-colors"
            >
              <MessageSquare size={14} /> Request Changes
            </button>
          )}
          {onReject && (
            <button
              onClick={handleReject}
              className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 transition-colors"
            >
              <XCircle size={14} /> Reject
            </button>
          )}
        </div>
      )}
    </div>
  );
}
