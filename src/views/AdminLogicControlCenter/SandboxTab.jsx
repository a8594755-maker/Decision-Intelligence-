// ============================================
// Sandbox & Diff Tab Component
// Test configuration changes and compare results
// ============================================

import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '../../services/supabaseClient';
import { 
  startSandboxTest, 
  fetchTestRun,
  getStatusColor,
  getStatusText 
} from '../../services/logicVersionService';

export default function SandboxTab({ draftVersion, publishedVersion, canEdit }) {
  const [testParams, setTestParams] = useState({
    plantId: '',
    timeBuckets: [],
    maxFgCount: 100,
  });
  const [testRun, setTestRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [plants, setPlants] = useState([]);

  // Load accessible plants
  useEffect(() => {
    async function loadPlants() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('accessible_plants')
        .eq('user_id', user.id)
        .single();

      if (profile?.accessible_plants) {
        const plantList = profile.accessible_plants.filter(p => p !== '*');
        setPlants(plantList);
        if (plantList.length > 0) {
          setTestParams(prev => ({ ...prev, plantId: plantList[0] }));
        }
      }
    }
    loadPlants();
  }, []);

  // Poll for test run updates
  const testRunId = testRun?.id;
  const testRunStatus = testRun?.status;
  useEffect(() => {
    if (!testRunId || testRunStatus === 'completed' || testRunStatus === 'failed') {
      setPolling(false);
      return;
    }

    setPolling(true);
    const interval = setInterval(async () => {
      const updated = await fetchTestRun(testRunId);
      if (updated) {
        setTestRun(updated);
        if (updated.status === 'completed' || updated.status === 'failed') {
          setPolling(false);
          clearInterval(interval);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [testRunId, testRunStatus]);

  async function handleStartTest() {
    if (!draftVersion) {
      alert('No draft version to test. Create a draft in the Edit tab first.');
      return;
    }

    setLoading(true);
    try {
      const run = await startSandboxTest(draftVersion.id, testParams);
      setTestRun(run);
    } catch (err) {
      alert('Failed to start test: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleTimeBucketsChange(e) {
    const value = e.target.value;
    const buckets = value.split(',').map(s => s.trim()).filter(Boolean);
    setTestParams(prev => ({ ...prev, timeBuckets: buckets }));
  }

  if (!canEdit) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
        <p className="text-sm text-yellow-700">
          You don't have permission to run sandbox tests.
        </p>
      </div>
    );
  }

  if (!draftVersion) {
    return (
      <div className="bg-gray-50 rounded-lg p-8 text-center">
        <p className="text-gray-500 mb-4">
          No draft version available for testing.
        </p>
        <p className="text-sm text-gray-400">
          Create a draft in the Edit tab first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Test Configuration */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Sandbox Test Configuration
        </h2>
        
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Plant</label>
            <select
              value={testParams.plantId}
              onChange={(e) => setTestParams(prev => ({ ...prev, plantId: e.target.value }))}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            >
              <option value="">All Plants</option>
              {plants.map(plant => (
                <option key={plant} value={plant}>{plant}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Time Buckets</label>
            <input
              type="text"
              placeholder="e.g. 2025-W01, 2025-W02"
              value={testParams.timeBuckets.join(', ')}
              onChange={handleTimeBucketsChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">Comma-separated list</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Max FG Count</label>
            <input
              type="number"
              min="1"
              max="1000"
              value={testParams.maxFgCount}
              onChange={(e) => setTestParams(prev => ({ ...prev, maxFgCount: parseInt(e.target.value) }))}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">Limit for faster testing</p>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-500">
            <p>Testing draft version: <span className="font-mono">{draftVersion.id.slice(0, 8)}</span></p>
            {publishedVersion && (
              <p>Against published: <span className="font-mono">{publishedVersion.id.slice(0, 8)}</span></p>
            )}
          </div>
          <button
            onClick={handleStartTest}
            disabled={loading || polling}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Starting...
              </>
            ) : (
              'Run Sandbox Test'
            )}
          </button>
        </div>
      </div>

      {/* Test Run Status */}
      {testRun && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Test Run Results
            </h2>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(testRun.status)}`}>
              {getStatusText(testRun.status)}
              {polling && ' (Running...)'}
            </span>
          </div>

          {/* Progress Bar */}
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
              <span>Progress</span>
              <span>{testRun.progress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div 
                className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${testRun.progress}%` }}
              />
            </div>
          </div>

          {/* Summary Stats */}
          {testRun.summary && (
            <div className="grid grid-cols-4 gap-4 mb-6">
              <div className="bg-gray-50 rounded p-3">
                <p className="text-sm text-gray-500">FG Demands</p>
                <p className="text-lg font-semibold">{testRun.summary.fg_demands_count || 0}</p>
              </div>
              <div className="bg-gray-50 rounded p-3">
                <p className="text-sm text-gray-500">Component Demand</p>
                <p className="text-lg font-semibold">{testRun.summary.component_demand_count || 0}</p>
              </div>
              <div className="bg-gray-50 rounded p-3">
                <p className="text-sm text-gray-500">Trace Records</p>
                <p className="text-lg font-semibold">{testRun.summary.trace_count || 0}</p>
              </div>
              <div className="bg-gray-50 rounded p-3">
                <p className="text-sm text-gray-500">Errors</p>
                <p className={`text-lg font-semibold ${(testRun.summary.errors_count || 0) > 0 ? 'text-red-600' : ''}`}>
                  {testRun.summary.errors_count || 0}
                </p>
              </div>
            </div>
          )}

          {/* Error Message */}
          {testRun.error_message && (
            <div className="bg-red-50 border-l-4 border-red-400 p-4 mb-6">
              <p className="text-sm text-red-700">{testRun.error_message}</p>
            </div>
          )}

          {/* Diff Report */}
          {testRun.diff_report && (
            <div className="border-t border-gray-200 pt-4">
              <h3 className="text-base font-medium text-gray-900 mb-4">
                Difference Analysis
              </h3>

              {/* Total Delta */}
              <div className="flex items-center mb-4">
                <span className="text-sm text-gray-600 mr-2">Total Demand Change:</span>
                <span className={`text-lg font-semibold ${
                  (testRun.diff_report.total_demand_delta_pct || 0) > 0 
                    ? 'text-green-600' 
                    : (testRun.diff_report.total_demand_delta_pct || 0) < 0 
                      ? 'text-red-600' 
                      : 'text-gray-600'
                }`}>
                  {(testRun.diff_report.total_demand_delta_pct || 0).toFixed(2)}%
                </span>
              </div>

              {/* Top Changes Table */}
              {testRun.diff_report.top_changes && testRun.diff_report.top_changes.length > 0 && (
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg mb-4">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="py-2 pl-4 pr-3 text-left text-xs font-medium text-gray-500 uppercase">Component</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Baseline</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Draft</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Delta</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {testRun.diff_report.top_changes.slice(0, 20).map((change, idx) => (
                        <tr key={idx}>
                          <td className="py-2 pl-4 pr-3 text-sm font-medium text-gray-900">
                            {change.component_key}
                          </td>
                          <td className="px-3 py-2 text-sm text-right text-gray-500">
                            {change.baseline_demand.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-sm text-right text-gray-900">
                            {change.draft_demand.toLocaleString()}
                          </td>
                          <td className={`px-3 py-2 text-sm text-right font-medium ${
                            change.delta > 0 ? 'text-green-600' : change.delta < 0 ? 'text-red-600' : 'text-gray-600'
                          }`}>
                            {change.delta > 0 ? '+' : ''}{change.delta.toLocaleString()}
                          </td>
                          <td className={`px-3 py-2 text-sm text-right ${
                            change.delta_pct > 0 ? 'text-green-600' : change.delta_pct < 0 ? 'text-red-600' : 'text-gray-600'
                          }`}>
                            {change.delta_pct > 0 ? '+' : ''}{change.delta_pct.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* New/Removed Components */}
              <div className="grid grid-cols-2 gap-4">
                {testRun.diff_report.new_components && testRun.diff_report.new_components.length > 0 && (
                  <div className="bg-green-50 rounded p-3">
                    <p className="text-sm font-medium text-green-900 mb-2">
                      New Components ({testRun.diff_report.new_components.length})
                    </p>
                    <ul className="text-sm text-green-800 space-y-1 max-h-32 overflow-y-auto">
                      {testRun.diff_report.new_components.map((comp, idx) => (
                        <li key={idx} className="font-mono text-xs">{comp}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {testRun.diff_report.removed_components && testRun.diff_report.removed_components.length > 0 && (
                  <div className="bg-red-50 rounded p-3">
                    <p className="text-sm font-medium text-red-900 mb-2">
                      Removed Components ({testRun.diff_report.removed_components.length})
                    </p>
                    <ul className="text-sm text-red-800 space-y-1 max-h-32 overflow-y-auto">
                      {testRun.diff_report.removed_components.map((comp, idx) => (
                        <li key={idx} className="font-mono text-xs">{comp}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
