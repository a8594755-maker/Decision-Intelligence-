// ============================================
// Job Control Center - Main Page
// Phase 5: Operations monitoring and job management
// ============================================

import { useState, useEffect } from 'react';
import { supabase } from "../../services/infra/supabaseClient";
import { formatDistanceToNow, format } from 'date-fns';

const JOB_STATUS_COLORS = {
  pending: 'bg-gray-100 text-gray-800',
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-orange-100 text-orange-800',
};

const JOB_TYPE_ICONS = {
  bom_explosion: '📋',
  file_import: '📁',
  risk_calc: '⚠️',
};

export default function AdminJobControlCenter({ setView }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    status: '',
    jobType: '',
    plant: '',
  });
  const [selectedJob, setSelectedJob] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (user) {
      loadJobs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filters]);

  async function checkAuth() {
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (!currentUser) {
      setView('login');
      return;
    }
    setUser(currentUser);
  }

  async function loadJobs() {
    setLoading(true);
    try {
      let query = supabase
        .from('import_batches')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filters.status) {
        query = query.eq('status', filters.status);
      }
      if (filters.jobType) {
        query = query.eq('job_type', filters.jobType);
      }

      const { data, error } = await query;

      if (error) throw error;
      setJobs(data || []);
    } catch (err) {
      console.error('Error loading jobs:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelJob(jobId) {
    if (!confirm('Are you sure you want to cancel this job?')) return;
    
    try {
      await supabase
        .from('import_batches')
        .update({ status: 'cancelled' })
        .eq('id', jobId);
      
      loadJobs();
    } catch (err) {
      alert('Error cancelling job: ' + err.message);
    }
  }

  async function handleRetryJob(job) {
    // Navigate to the relevant page with retry parameters
    if (job.job_type === 'bom_explosion') {
      setView('bom-data'); // Navigate to BOM data view for retry
    }
  }

  function formatDuration(startedAt, completedAt) {
    if (!startedAt) return 'N/A';
    const end = completedAt ? new Date(completedAt) : new Date();
    const start = new Date(startedAt);
    const seconds = Math.floor((end - start) / 1000);
    
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Job Control Center</h1>
              <p className="text-sm text-gray-500 mt-1">
                Monitor and manage background jobs
              </p>
            </div>
            <button
              onClick={loadJobs}
              className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center space-x-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Status</label>
              <select
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                className="mt-1 block w-32 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Job Type</label>
              <select
                value={filters.jobType}
                onChange={(e) => setFilters({ ...filters, jobType: e.target.value })}
                className="mt-1 block w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="">All</option>
                <option value="bom_explosion">BOM Explosion</option>
                <option value="file_import">File Import</option>
              </select>
            </div>

            <div className="flex-1" />

            <div className="text-sm text-gray-500">
              Showing {jobs.length} jobs
            </div>
          </div>
        </div>
      </div>

      {/* Job List */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
          </div>
        ) : jobs.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <p className="text-gray-500">No jobs found matching the filters.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Job
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Progress
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Started
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {jobs.map((job) => (
                  <tr 
                    key={job.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => setSelectedJob(job)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <span className="text-lg mr-2">
                          {JOB_TYPE_ICONS[job.job_type] || '📄'}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {job.filename || job.job_type}
                          </p>
                          <p className="text-xs text-gray-500 font-mono">
                            {job.id.slice(0, 8)}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${JOB_STATUS_COLORS[job.status] || 'bg-gray-100'}`}>
                        {job.status}
                      </span>
                      {job.metadata?.zombie_detected && (
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                          Zombie
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="w-16 bg-gray-200 rounded-full h-2 mr-2">
                          <div
                            className="bg-indigo-600 h-2 rounded-full"
                            style={{ width: `${job.progress || 0}%` }}
                          />
                        </div>
                        <span className="text-sm text-gray-600">{job.progress || 0}%</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {formatDuration(job.started_at, job.completed_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {job.started_at ? formatDistanceToNow(new Date(job.started_at), { addSuffix: true }) : 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {job.status === 'running' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelJob(job.id);
                          }}
                          className="text-red-600 hover:text-red-900 mr-3"
                        >
                          Cancel
                        </button>
                      )}
                      {['failed', 'cancelled'].includes(job.status) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRetryJob(job);
                          }}
                          className="text-indigo-600 hover:text-indigo-900"
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Job Detail Modal */}
      {selectedJob && (
        <JobDetailModal
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onCancel={() => handleCancelJob(selectedJob.id)}
          onRetry={() => handleRetryJob(selectedJob)}
        />
      )}
    </div>
  );
}

// Job Detail Modal Component
function JobDetailModal({ job, onClose, onCancel, onRetry }) {
  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              Job Details
            </h3>
            <p className="text-sm text-gray-500 font-mono">{job.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Status */}
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded">
            <span className="text-sm font-medium text-gray-700">Status</span>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${JOB_STATUS_COLORS[job.status]}`}>
              {job.status}
            </span>
          </div>

          {/* Progress */}
          <div>
            <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
              <span>Progress</span>
              <span>{job.progress || 0}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-indigo-600 h-2 rounded-full"
                style={{ width: `${job.progress || 0}%` }}
              />
            </div>
          </div>

          {/* Job Key */}
          {job.job_key && (
            <div className="p-3 bg-gray-50 rounded">
              <p className="text-sm font-medium text-gray-700">Job Key</p>
              <p className="text-sm font-mono text-gray-600 break-all">{job.job_key}</p>
            </div>
          )}

          {/* Error Message */}
          {job.error_message && (
            <div className="p-3 bg-red-50 border-l-4 border-red-400 rounded">
              <p className="text-sm font-medium text-red-700">Error</p>
              <p className="text-sm text-red-600">{job.error_message}</p>
            </div>
          )}

          {/* Result Summary */}
          {job.result_summary && (
            <div className="p-3 bg-gray-50 rounded">
              <p className="text-sm font-medium text-gray-700 mb-2">Result Summary</p>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(job.result_summary).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-gray-500 capitalize">{key.replace(/_/g, ' ')}:</span>
                    <span className="font-medium">{typeof value === 'number' ? value.toLocaleString() : String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Created</p>
              <p className="font-medium">{job.created_at ? format(new Date(job.created_at), 'PPp') : 'N/A'}</p>
            </div>
            <div>
              <p className="text-gray-500">Started</p>
              <p className="font-medium">{job.started_at ? format(new Date(job.started_at), 'PPp') : 'N/A'}</p>
            </div>
            <div>
              <p className="text-gray-500">Completed</p>
              <p className="font-medium">{job.completed_at ? format(new Date(job.completed_at), 'PPp') : 'N/A'}</p>
            </div>
            {job.heartbeat_at && (
              <div>
                <p className="text-gray-500">Last Heartbeat</p>
                <p className="font-medium">{formatDistanceToNow(new Date(job.heartbeat_at), { addSuffix: true })}</p>
              </div>
            )}
          </div>

          {/* Metadata */}
          {job.metadata && Object.keys(job.metadata).length > 0 && (
            <div className="p-3 bg-gray-50 rounded">
              <p className="text-sm font-medium text-gray-700 mb-2">Metadata</p>
              <pre className="text-xs text-gray-600 overflow-x-auto">
                {JSON.stringify(job.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
          {job.status === 'running' && (
            <button
              onClick={onCancel}
              className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700"
            >
              Cancel Job
            </button>
          )}
          {['failed', 'cancelled'].includes(job.status) && (
            <button
              onClick={onRetry}
              className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
            >
              Retry Job
            </button>
          )}
          <button
            onClick={onClose}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
