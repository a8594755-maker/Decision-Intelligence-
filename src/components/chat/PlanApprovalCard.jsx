import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, CheckCircle2, XCircle, Hourglass, Send } from 'lucide-react';
import { Card, Badge, Button } from '../ui';

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

export default function PlanApprovalCard({
  payload,
  onRequestApproval,
  onApprove,
  onReject
}) {
  const [approval, setApproval] = useState(payload?.approval || null);
  const [note, setNote] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setApproval(payload?.approval || null);
  }, [payload?.approval]);

  const status = useMemo(() => normalizeStatus(approval?.status), [approval]);
  const requiresApproval = payload?.requires_approval === true;

  if (!payload || !requiresApproval) return null;

  const runId = payload?.run_id || null;
  const summary = payload?.summary_text
    || payload?.narrative_summary
    || payload?.situation?.text
    || 'Plan requires manual approval.';

  const handleRequest = async () => {
    if (!onRequestApproval || !runId) return;
    setIsBusy(true);
    setError('');
    try {
      const record = await onRequestApproval({ runId, note, narrative: payload });
      if (record) {
        setApproval(record);
      }
    } catch (requestError) {
      setError(requestError.message || 'Failed to request approval.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!onApprove || !approval?.approval_id) return;
    setIsBusy(true);
    setError('');
    try {
      const record = await onApprove({ approvalId: approval.approval_id, note, runId, narrative: payload });
      if (record) {
        setApproval(record);
      }
    } catch (approveError) {
      setError(approveError.message || 'Failed to approve plan.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleReject = async () => {
    if (!onReject || !approval?.approval_id) return;
    setIsBusy(true);
    setError('');
    try {
      const record = await onReject({ approvalId: approval.approval_id, note, runId, narrative: payload });
      if (record) {
        setApproval(record);
      }
    } catch (rejectError) {
      setError(rejectError.message || 'Failed to reject plan.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Card className="w-full border border-amber-200 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-amber-600" />
              Plan Approval
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">Run #{runId || 'N/A'}</p>
          </div>

          {!approval ? <Badge type="warning">Approval Required</Badge> : null}
          {status === 'PENDING' ? <Badge type="warning">Pending</Badge> : null}
          {status === 'APPROVED' ? <Badge type="success">Approved</Badge> : null}
          {status === 'REJECTED' ? <Badge type="danger">Rejected</Badge> : null}
        </div>

        <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">{summary}</p>

        {approval?.approval_id ? (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono break-all">
            approval_id: {approval.approval_id}
          </p>
        ) : null}

        {status !== 'APPROVED' ? (
          <textarea
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500"
            rows={3}
            placeholder="Approval note (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={isBusy}
          />
        ) : null}

        {error ? <p className="text-xs text-red-600">{error}</p> : null}

        {!approval ? (
          <Button
            variant="secondary"
            className="text-xs"
            onClick={handleRequest}
            disabled={isBusy}
            icon={Send}
          >
            {isBusy ? 'Requesting...' : 'Request Approval'}
          </Button>
        ) : null}

        {status === 'PENDING' ? (
          <div className="flex items-center gap-2">
            <Button
              variant="success"
              className="text-xs"
              onClick={handleApprove}
              disabled={isBusy}
              icon={CheckCircle2}
            >
              {isBusy ? 'Submitting...' : 'Approve'}
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
            {isBusy ? <Hourglass className="w-4 h-4 text-slate-400" /> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
