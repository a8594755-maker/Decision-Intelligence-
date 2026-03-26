import React, { useState } from 'react';
import { RefreshCw, CheckCircle2, XCircle, Hourglass, AlertTriangle, TrendingDown } from 'lucide-react';
import { Card, Badge, Button } from '../ui';

/**
 * RetrainApprovalCard — displays a retrain trigger with approval controls.
 *
 * Expected payload shape:
 * {
 *   series_id: string,
 *   trigger_type: 'coverage_drop' | 'mape_degradation' | 'residual_drift' | 'data_drift',
 *   trigger_details: { metric, threshold, current_value, baseline_value },
 *   model_name: string,
 *   champion_version: string,
 *   requires_approval: boolean,
 *   status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_APPROVED',
 *   retrain_job_id?: string,
 *   triggered_at: string,
 * }
 */

const TRIGGER_LABELS = {
  coverage_drop: 'Coverage Drop',
  mape_degradation: 'MAPE Degradation',
  residual_drift: 'Residual Drift',
  data_drift: 'Data Drift',
};

const TRIGGER_COLORS = {
  coverage_drop: 'text-amber-600',
  mape_degradation: 'text-red-600',
  residual_drift: 'text-orange-600',
  data_drift: 'text-purple-600',
};

export default function RetrainApprovalCard({ payload, onApprove, onReject }) {
  const [status, setStatus] = useState(payload?.status || 'PENDING');
  const [note, setNote] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  if (!payload) return null;

  const {
    series_id,
    trigger_type,
    trigger_details = {},
    model_name,
    champion_version,
    retrain_job_id,
    triggered_at,
  } = payload;

  const triggerLabel = TRIGGER_LABELS[trigger_type] || trigger_type;
  const triggerColor = TRIGGER_COLORS[trigger_type] || 'text-slate-600';
  const isResolved = status === 'APPROVED' || status === 'REJECTED' || status === 'AUTO_APPROVED';

  const handleApprove = async () => {
    if (!onApprove) return;
    setIsBusy(true);
    setError('');
    try {
      await onApprove({ series_id, trigger_type, note, retrain_job_id });
      setStatus('APPROVED');
    } catch (e) {
      setError(e.message || 'Failed to approve retrain.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleReject = async () => {
    if (!onReject) return;
    setIsBusy(true);
    setError('');
    try {
      await onReject({ series_id, trigger_type, note, retrain_job_id });
      setStatus('REJECTED');
    } catch (e) {
      setError(e.message || 'Failed to reject retrain.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Card category="system" className="w-full border border-orange-200 dark:border-orange-700 bg-orange-50/60 dark:bg-orange-900/10">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-orange-600" />
              Model Retrain Approval
            </h4>
            <p className="text-xs text-[var(--text-secondary)]">
              {model_name || 'Unknown Model'} &middot; Series: {series_id || 'N/A'}
            </p>
          </div>
          {status === 'PENDING' && <Badge type="warning">Pending Approval</Badge>}
          {status === 'APPROVED' && <Badge type="success">Approved</Badge>}
          {status === 'REJECTED' && <Badge type="danger">Rejected</Badge>}
          {status === 'AUTO_APPROVED' && <Badge type="info">Auto-Approved</Badge>}
        </div>

        {/* Trigger Details */}
        <div className="bg-[var(--surface-card)] rounded-lg p-3 border border-[var(--border-default)]">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className={`w-4 h-4 ${triggerColor}`} />
            <span className={`text-xs font-semibold ${triggerColor}`}>{triggerLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {trigger_details.metric && (
              <div>
                <span className="text-slate-500">Metric:</span>{' '}
                <span className="font-medium text-[var(--text-secondary)]">{trigger_details.metric}</span>
              </div>
            )}
            {trigger_details.current_value !== undefined && (
              <div>
                <span className="text-slate-500">Current:</span>{' '}
                <span className="font-medium text-red-600">
                  {typeof trigger_details.current_value === 'number'
                    ? trigger_details.current_value.toFixed(3)
                    : trigger_details.current_value}
                </span>
              </div>
            )}
            {trigger_details.threshold !== undefined && (
              <div>
                <span className="text-slate-500">Threshold:</span>{' '}
                <span className="font-medium text-[var(--text-secondary)]">
                  {typeof trigger_details.threshold === 'number'
                    ? trigger_details.threshold.toFixed(3)
                    : trigger_details.threshold}
                </span>
              </div>
            )}
            {trigger_details.baseline_value !== undefined && (
              <div>
                <span className="text-slate-500">Baseline:</span>{' '}
                <span className="font-medium text-[var(--text-secondary)]">
                  {typeof trigger_details.baseline_value === 'number'
                    ? trigger_details.baseline_value.toFixed(3)
                    : trigger_details.baseline_value}
                </span>
              </div>
            )}
          </div>
          {champion_version && (
            <p className="text-[11px] text-slate-400 mt-2">Champion: v{champion_version}</p>
          )}
          {triggered_at && (
            <p className="text-[11px] text-[var(--text-muted)]">
              Triggered: {new Date(triggered_at).toLocaleString()}
            </p>
          )}
        </div>

        {/* Note input */}
        {!isResolved && (
          <textarea
            className="w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-card)] text-xs px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
            rows={2}
            placeholder="Approval note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={isBusy}
          />
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}

        {/* Action buttons */}
        {status === 'PENDING' && (
          <div className="flex items-center gap-2">
            <Button
              variant="success"
              className="text-xs"
              onClick={handleApprove}
              disabled={isBusy}
              icon={CheckCircle2}
            >
              {isBusy ? 'Submitting...' : 'Approve Retrain'}
            </Button>
            <Button
              variant="danger"
              className="text-xs"
              onClick={handleReject}
              disabled={isBusy}
              icon={XCircle}
            >
              {isBusy ? 'Submitting...' : 'Reject'}
            </Button>
            {isBusy && <Hourglass className="w-4 h-4 text-[var(--text-muted)]" />}
          </div>
        )}

        {retrain_job_id && status === 'APPROVED' && (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">
            Retrain job started: {retrain_job_id}
          </p>
        )}
      </div>
    </Card>
  );
}
