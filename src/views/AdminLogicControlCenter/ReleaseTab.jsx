// ============================================
// Release Tab Component
// Workflow management: submit, approve, publish, rollback
// ============================================

import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import {
  submitDraft,
  approveVersion,
  rejectVersion,
  publishVersion,
  rollbackVersion,
  fetchChangeLog,
  getStatusColor,
  getStatusText,
} from '../../services/governance/logicVersionService';
import { fetchRegressionResults, runRegressionTests, calculateRegressionSummary } from '../../services/governance/regressionTestService';
import { supabase, RPC_JSON_OPTIONS } from '../../services/infra/supabaseClient';

function getRegressionStatusColor(status) {
  switch (status) {
    case 'passed': return 'bg-green-100 text-green-800';
    case 'failed': return 'bg-red-100 text-red-800';
    default: return 'bg-gray-100 text-gray-800';
  }
}

export default function ReleaseTab({
  draftVersion,
  publishedVersion,
  onStatusChange,
  canEdit,
  canApprove,
  canPublish,
}) {
  const [changeLog, setChangeLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [showRollback, setShowRollback] = useState(false);
  const [regressionResults, setRegressionResults] = useState(null);
  const [regressionLoading, setRegressionLoading] = useState(false);

  useEffect(() => {
    if (draftVersion) {
      loadChangeLog();
      loadRegressionResults();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftVersion]);

  async function loadChangeLog() {
    if (!draftVersion) return;
    try {
      const logs = await fetchChangeLog(draftVersion.id);
      setChangeLog(logs);
    } catch (err) {
      console.error('Error loading change log:', err);
    }
  }

  async function loadRegressionResults() {
    if (!draftVersion) return;
    try {
      const results = await fetchRegressionResults(draftVersion.id);
      setRegressionResults(results);
    } catch (err) {
      console.error('Error loading regression results:', err);
    }
  }

  async function handleRunRegression() {
    if (!draftVersion) return;
    setRegressionLoading(true);
    try {
      await runRegressionTests(draftVersion.id);
      // Poll for results
      setTimeout(loadRegressionResults, 2000);
    } catch (err) {
      alert('Error running regression tests: ' + err.message);
    } finally {
      setRegressionLoading(false);
    }
  }

  const regressionSummary = calculateRegressionSummary(regressionResults);

  async function handleSubmit() {
    if (!draftVersion) return;
    setLoading(true);
    try {
      await submitDraft(draftVersion.id, comment);
      setComment('');
      onStatusChange();
    } catch (err) {
      alert('Error submitting: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove() {
    if (!draftVersion) return;
    setLoading(true);
    try {
      await approveVersion(draftVersion.id, comment);
      setComment('');
      onStatusChange();
    } catch (err) {
      alert('Error approving: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReject() {
    if (!draftVersion) return;
    setLoading(true);
    try {
      await rejectVersion(draftVersion.id, comment);
      setComment('');
      onStatusChange();
    } catch (err) {
      alert('Error rejecting: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function _checkCanPublish(versionId) {
    const { data, error } = await supabase.rpc('can_publish_version', { p_version_id: versionId }, RPC_JSON_OPTIONS);
    if (error) throw error;
    return data?.[0] || { can_publish: true };
  }

  async function handlePublish() {
    if (!draftVersion) return;
    setLoading(true);
    try {
      const effectiveFrom = effectiveDate || new Date().toISOString();
      await publishVersion(draftVersion.id, effectiveFrom, comment);
      setComment('');
      setEffectiveDate('');
      onStatusChange();
    } catch (err) {
      alert('Error publishing: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRollback(targetVersionId) {
    if (!publishedVersion) return;
    setLoading(true);
    try {
      await rollbackVersion(
        publishedVersion.logic_id,
        publishedVersion.scope_level,
        publishedVersion.scope_id,
        targetVersionId,
        comment
      );
      setComment('');
      setShowRollback(false);
      onStatusChange();
    } catch (err) {
      alert('Error rolling back: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function getWorkflowSteps() {
    const steps = [
      { id: 'draft', label: 'Draft', status: 'complete' },
      { id: 'sandbox', label: 'Sandbox Test', status: 'pending' },
      { id: 'submit', label: 'Submitted', status: 'pending' },
      { id: 'approve', label: 'Approved', status: 'pending' },
      { id: 'publish', label: 'Published', status: 'pending' },
    ];

    if (!draftVersion) return steps;

    const status = draftVersion.status;

    // Mark completed steps
    steps[0].status = 'complete'; // Draft always complete if exists

    // Sandbox — reflect actual regression test results
    if (regressionSummary.total === 0) {
      steps[1].status = status === 'draft' ? 'current' : 'pending';
    } else if (regressionSummary.overallPassed) {
      steps[1].status = 'complete';
    } else {
      steps[1].status = 'failed';
    }

    if (status === 'pending_approval') {
      steps[2].status = 'complete';
      steps[3].status = 'current';
    } else if (status === 'approved') {
      steps[2].status = 'complete';
      steps[3].status = 'complete';
      steps[4].status = 'current';
    } else if (status === 'published') {
      steps.forEach(s => s.status = 'complete');
    }

    return steps;
  }

  const workflowSteps = getWorkflowSteps();

  return (
    <div className="space-y-6">
      {/* Workflow Progress */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Release Workflow
        </h2>

        <div className="flex items-center justify-between">
          {workflowSteps.map((step, idx) => (
            <div key={step.id} className="flex items-center">
              <div className="flex flex-col items-center">
                <div className={`
                  w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                  ${step.status === 'complete' ? 'bg-green-500 text-white' : ''}
                  ${step.status === 'current' ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : ''}
                  ${step.status === 'pending' ? 'bg-gray-200 text-gray-500' : ''}
                  ${step.status === 'failed' ? 'bg-red-500 text-white ring-4 ring-red-100' : ''}
                `}>
                  {step.status === 'complete' ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : step.status === 'failed' ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    idx + 1
                  )}
                </div>
                <span className={`
                  mt-2 text-xs font-medium
                  ${step.status === 'current' ? 'text-indigo-600' : ''}
                  ${step.status === 'failed' ? 'text-red-600' : ''}
                  ${step.status !== 'current' && step.status !== 'failed' ? 'text-gray-500' : ''}
                `}>
                  {step.label}
                </span>
              </div>
              {idx < workflowSteps.length - 1 && (
                <div className={`
                  w-16 h-0.5 mx-2
                  ${step.status === 'complete' ? 'bg-green-500' : ''}
                  ${step.status === 'failed' ? 'bg-red-400' : ''}
                  ${step.status !== 'complete' && step.status !== 'failed' ? 'bg-gray-200' : ''}
                `} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Current Status & Actions */}
      {draftVersion && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Current Status
              </h2>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(draftVersion.status)}`}>
                {getStatusText(draftVersion.status)}
              </span>
            </div>
            <div className="text-sm text-gray-500">
              <p>Version: <span className="font-mono">{draftVersion.id.slice(0, 8)}</span></p>
              <p>Created: {format(new Date(draftVersion.created_at), 'PP')}</p>
            </div>
          </div>

          {/* Action Buttons based on status */}
          <div className="space-y-4">
            {draftVersion.status === 'draft' && canEdit && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Submit for Approval
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Describe the changes and why they're needed..."
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  rows={3}
                />
                <button
                  onClick={handleSubmit}
                  disabled={loading || !comment.trim()}
                  className="mt-2 inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loading ? 'Submitting...' : 'Submit for Approval'}
                </button>
              </div>
            )}

            {draftVersion.status === 'pending_approval' && canApprove && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Approval Decision
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Approval comment (optional)..."
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  rows={2}
                />
                <div className="mt-2 flex space-x-3">
                  <button
                    onClick={handleApprove}
                    disabled={loading}
                    className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={handleReject}
                    disabled={loading}
                    className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}

            {draftVersion.status === 'approved' && canPublish && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Publish Configuration
                </label>
                <div className="flex items-center space-x-4 mb-3">
                  <div>
                    <label className="block text-xs text-gray-500">Effective Date (optional)</label>
                    <input
                      type="datetime-local"
                      value={effectiveDate}
                      onChange={(e) => setEffectiveDate(e.target.value)}
                      className="mt-1 block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>
                </div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Publish comment (optional)..."
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  rows={2}
                />
                <button
                  onClick={handlePublish}
                  disabled={loading}
                  className="mt-2 inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700"
                >
                  {loading ? 'Publishing...' : 'Publish Now'}
                </button>
                <p className="mt-2 text-xs text-gray-500">
                  This will replace the current published version and take effect immediately (or at the specified effective date).
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rollback Section */}
      {publishedVersion && canPublish && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 text-red-700">
              Danger Zone: Rollback
            </h2>
            <button
              onClick={() => setShowRollback(!showRollback)}
              className="text-sm text-red-600 hover:text-red-500"
            >
              {showRollback ? 'Hide' : 'Show'} Rollback Options
            </button>
          </div>

          {showRollback && (
            <div className="bg-red-50 rounded-lg p-4">
              <p className="text-sm text-red-700 mb-4">
                Rolling back will create a new published version based on a previous version. Use with caution!
              </p>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Reason for rollback..."
                className="w-full rounded-md border-red-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm mb-3"
                rows={2}
              />
              <div className="flex space-x-3">
                <button
                  onClick={() => handleRollback(publishedVersion.id)}
                  disabled={loading || !comment.trim()}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                >
                  Rollback to Previous Version
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Regression Tests */}
      {draftVersion && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Regression Tests
            </h2>
            <div className="flex items-center space-x-2">
              {regressionSummary.total > 0 && (
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  regressionSummary.overallPassed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }}`}>
                  {regressionSummary.passed}/{regressionSummary.total} Passed
                </span>
              )}
              <button
                onClick={handleRunRegression}
                disabled={regressionLoading}
                className="inline-flex items-center px-3 py-1.5 border border-transparent rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
              >
                {regressionLoading ? 'Running...' : 'Run Tests'}
              </button>
            </div>
          </div>

          {regressionResults && regressionResults.length > 0 ? (
            <div className="space-y-2">
              {regressionResults.map((result) => (
                <div key={result.id} className={`flex items-center justify-between p-3 rounded ${
                  result.status === 'passed' ? 'bg-green-50' : 
                  result.status === 'failed' ? 'bg-red-50' : 'bg-gray-50'
                }`}>
                  <div className="flex items-center">
                    <span className={`w-2 h-2 rounded-full mr-2 ${
                      result.status === 'passed' ? 'bg-green-500' : 
                      result.status === 'failed' ? 'bg-red-500' : 'bg-gray-400'
                    }`} />
                    <span className="text-sm font-medium">{result.regression_test?.name}</span>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded ${getRegressionStatusColor(result.status)}`}>
                    {result.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No regression tests run yet.</p>
          )}

          {regressionSummary.failed > 0 && (
            <div className="mt-4 bg-red-50 border-l-4 border-red-400 p-3">
              <p className="text-sm text-red-700">
                {regressionSummary.failed} test(s) failed. Review before publishing.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Audit Trail */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Audit Trail
        </h2>

        {changeLog.length === 0 ? (
          <p className="text-gray-500 text-sm">No recorded changes yet.</p>
        ) : (
          <div className="flow-root">
            <ul className="-mb-8">
              {changeLog.map((log, idx) => (
                <li key={log.id} className="relative pb-8">
                  {idx !== changeLog.length - 1 && (
                    <span className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-gray-200" aria-hidden="true" />
                  )}
                  <div className="relative flex space-x-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 ring-8 ring-white">
                      <svg className="h-5 w-5 text-gray-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 9a2 2 0 100-4 2 2 0 000 4zm-2 4a2 2 0 100-4 2 2 0 000 4zm6 0a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="flex min-w-0 flex-1 justify-between space-x-4 pt-1.5">
                      <div>
                        <p className="text-sm text-gray-500">
                          <span className="font-medium text-gray-900 capitalize">{log.action}</span>
                          {' by '}
                          <span className="font-medium text-gray-900">{log.actor_id.slice(0, 8)}</span>
                        </p>
                        {log.comment && (
                          <p className="mt-0.5 text-sm text-gray-600">{log.comment}</p>
                        )}
                      </div>
                      <div className="whitespace-nowrap text-right text-sm text-gray-500">
                        <time dateTime={log.created_at}>
                          {format(new Date(log.created_at), 'PPp')}
                        </time>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
