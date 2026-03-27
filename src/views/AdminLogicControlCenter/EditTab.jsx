// ============================================
// Edit Tab Component
// Forms for editing limits, rules, sharding, staging
// ============================================

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  createDraftVersion,
  updateDraftConfig,
  DEFAULT_LOGIC_CONFIG,
} from '../../services/governance/logicVersionService';

export default function EditTab({
  logicId,
  scopeLevel,
  scopeId,
  draftVersion,
  publishedVersion,
  onDraftCreated,
  canEdit,
}) {
  const [config, setConfig] = useState(DEFAULT_LOGIC_CONFIG);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [error, setError] = useState(null);

  // Load existing draft or published config
  useEffect(() => {
    if (draftVersion) {
      setConfig(draftVersion.config_json);
    } else if (publishedVersion) {
      setConfig(publishedVersion.config_json);
    } else {
      setConfig(DEFAULT_LOGIC_CONFIG);
    }
  }, [draftVersion, publishedVersion]);

  // Auto-save draft changes
  const saveDraftTimerRef = useRef(null);
  const saveDraft = useCallback(
    (newConfig) => {
      if (saveDraftTimerRef.current) clearTimeout(saveDraftTimerRef.current);
      saveDraftTimerRef.current = setTimeout(async () => {
        if (!canEdit) return;
        
        try {
          setSaving(true);
          
          if (draftVersion) {
            // Update existing draft
            await updateDraftConfig(draftVersion.id, newConfig);
          } else {
            // Create new draft
            await createDraftVersion(logicId, scopeLevel, scopeId, newConfig, publishedVersion?.id);
            onDraftCreated();
          }
          
          setLastSaved(new Date());
          setError(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setSaving(false);
        }
      }, 2000);
    },
    [draftVersion, logicId, scopeLevel, scopeId, publishedVersion, canEdit, onDraftCreated]
  );

  function handleConfigChange(path, value) {
    const newConfig = { ...config };
    const keys = path.split('.');
    let current = newConfig;
    
    for (let i = 0; i < keys.length - 1; i++) {
      current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
    setConfig(newConfig);
    saveDraft(newConfig);
  }

  if (!canEdit) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <p className="text-sm text-yellow-700">
              You don't have permission to edit logic configuration. Contact an administrator for access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with save status */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Edit Configuration</h2>
          <p className="text-sm text-gray-500">
            Changes are auto-saved to draft
          </p>
        </div>
        <div className="flex items-center space-x-2">
          {saving && (
            <span className="text-sm text-gray-500 flex items-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Saving...
            </span>
          )}
          {lastSaved && !saving && (
            <span className="text-sm text-green-600">
              Saved {lastSaved.toLocaleTimeString()}
            </span>
          )}
          {error && (
            <span className="text-sm text-red-600">
              Error: {error}
            </span>
          )}
        </div>
      </div>

      {/* Limits Panel */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-medium text-gray-900 flex items-center">
            <svg className="w-5 h-5 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Safety Limits
          </h3>
          <p className="mt-1 text-sm text-gray-500">Hard guardrails to prevent system overload</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                MAX BOM Depth
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={config.limits.MAX_BOM_DEPTH}
                onChange={(e) => handleConfigChange('limits.MAX_BOM_DEPTH', parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              />
              <p className="mt-1 text-xs text-gray-500">Maximum recursion depth (1-100)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                MAX Trace Rows
              </label>
              <input
                type="number"
                min="1000"
                max="2000000"
                step="1000"
                value={config.limits.MAX_TRACE_ROWS_PER_RUN}
                onChange={(e) => handleConfigChange('limits.MAX_TRACE_ROWS_PER_RUN', parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              />
              <p className="mt-1 text-xs text-gray-500">Explosion protection (1K-2M)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                MAX FG Demand Rows
              </label>
              <input
                type="number"
                min="100"
                max="50000"
                step="100"
                value={config.limits.MAX_FG_DEMAND_ROWS}
                onChange={(e) => handleConfigChange('limits.MAX_FG_DEMAND_ROWS', parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                MAX BOM Edges
              </label>
              <input
                type="number"
                min="100"
                max="100000"
                step="100"
                value={config.limits.MAX_BOM_EDGES_ROWS}
                onChange={(e) => handleConfigChange('limits.MAX_BOM_EDGES_ROWS', parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Zombie Timeout (seconds)
              </label>
              <input
                type="number"
                min="30"
                max="600"
                step="10"
                value={config.limits.ZOMBIE_AFTER_SECONDS}
                onChange={(e) => handleConfigChange('limits.ZOMBIE_AFTER_SECONDS', parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              />
              <p className="mt-1 text-xs text-gray-500">Job heartbeat threshold (30-600s)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Concurrent Jobs / User
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={config.limits.MAX_CONCURRENT_JOBS_PER_USER}
                onChange={(e) => handleConfigChange('limits.MAX_CONCURRENT_JOBS_PER_USER', parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              />
            </div>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Insert Chunk Sizes</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600">Demand Chunk Size</label>
                <input
                  type="number"
                  min="100"
                  max="5000"
                  step="100"
                  value={config.limits.INSERT_CHUNK_SIZE_DEMAND}
                  onChange={(e) => handleConfigChange('limits.INSERT_CHUNK_SIZE_DEMAND', parseInt(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">Trace Chunk Size</label>
                <input
                  type="number"
                  min="100"
                  max="10000"
                  step="500"
                  value={config.limits.INSERT_CHUNK_SIZE_TRACE}
                  onChange={(e) => handleConfigChange('limits.INSERT_CHUNK_SIZE_TRACE', parseInt(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Rules Panel */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-medium text-gray-900 flex items-center">
            <svg className="w-5 h-5 mr-2 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Policy Rules
          </h3>
          <p className="mt-1 text-sm text-gray-500">BOM edge selection and calculation policies</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Cycle Policy</label>
              <select
                value={config.rules.cycle_policy}
                onChange={(e) => handleConfigChange('rules.cycle_policy', e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              >
                <option value="warn_and_cut">Warn and Cut</option>
                <option value="fail">Fail Job</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">How to handle circular BOM references</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Max Depth Policy</label>
              <select
                value={config.rules.max_depth_policy}
                onChange={(e) => handleConfigChange('rules.max_depth_policy', e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              >
                <option value="warn_and_cut">Warn and Cut</option>
                <option value="fail">Fail Job</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">Behavior when exceeding MAX_BOM_DEPTH</p>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Edge Selection Strategy</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600">Plant Match</label>
                <select
                  value={config.rules.edge_selection.plant_match_strategy}
                  onChange={(e) => handleConfigChange('rules.edge_selection.plant_match_strategy', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                >
                  <option value="exact_first_then_null">Exact First, Then Null</option>
                  <option value="exact_only">Exact Only</option>
                  <option value="null_only">Null (Generic) Only</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-600">Priority Strategy</label>
                <select
                  value={config.rules.edge_selection.priority_strategy}
                  onChange={(e) => handleConfigChange('rules.edge_selection.priority_strategy', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                >
                  <option value="min_priority">Min Priority First</option>
                  <option value="max_priority">Max Priority First</option>
                  <option value="first_match">First Match</option>
                </select>
              </div>
            </div>

            <div className="mt-3 flex items-center">
              <input
                type="checkbox"
                id="validity_enforced"
                checked={config.rules.edge_selection.validity_enforced}
                onChange={(e) => handleConfigChange('rules.edge_selection.validity_enforced', e.target.checked)}
                className="h-4 w-4 text-[var(--brand-600)] focus:ring-[var(--brand-500)] border-gray-300 rounded"
              />
              <label htmlFor="validity_enforced" className="ml-2 block text-sm text-gray-700">
                Enforce valid_from / valid_to dates
              </label>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Scrap/Yield Ranges</h4>
            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className="block text-sm text-gray-600">Default Scrap</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={config.rules.scrap_yield.default_scrap_rate}
                  onChange={(e) => handleConfigChange('rules.scrap_yield.default_scrap_rate', parseFloat(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">Default Yield</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={config.rules.scrap_yield.default_yield_rate}
                  onChange={(e) => handleConfigChange('rules.scrap_yield.default_yield_rate', parseFloat(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">Max Scrap</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={config.rules.scrap_yield.max_scrap_rate}
                  onChange={(e) => handleConfigChange('rules.scrap_yield.max_scrap_rate', parseFloat(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">Min Yield</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={config.rules.scrap_yield.min_yield_rate}
                  onChange={(e) => handleConfigChange('rules.scrap_yield.min_yield_rate', parseFloat(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sharding Panel */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-medium text-gray-900 flex items-center">
            <svg className="w-5 h-5 mr-2 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
            Sharding Strategy
          </h3>
          <p className="mt-1 text-sm text-gray-500">How to split large jobs into smaller shards</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Strategy</label>
              <select
                value={config.sharding.strategy}
                onChange={(e) => handleConfigChange('sharding.strategy', e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              >
                <option value="none">No Sharding</option>
                <option value="by_time_bucket">By Time Bucket</option>
                <option value="by_fg_batch">By FG Batch</option>
              </select>
            </div>

            {config.sharding.strategy !== 'none' && (
              <div>
                <label className="block text-sm font-medium text-gray-700">Shard Size (weeks)</label>
                <input
                  type="number"
                  min="1"
                  max="52"
                  value={config.sharding.shard_size_weeks}
                  onChange={(e) => handleConfigChange('sharding.shard_size_weeks', parseInt(e.target.value))}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
                />
              </div>
            )}
          </div>

          {config.sharding.strategy !== 'none' && (
            <div>
              <label className="block text-sm font-medium text-gray-700">Merge Policy</label>
              <select
                value={config.sharding.merge_policy}
                onChange={(e) => handleConfigChange('sharding.merge_policy', e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              >
                <option value="sum">Sum</option>
                <option value="dedupe">Deduplicate</option>
                <option value="sum_and_dedupe">Sum + Deduplicate</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Staging Panel */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-medium text-gray-900 flex items-center">
            <svg className="w-5 h-5 mr-2 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
            </svg>
            Staging Settings
          </h3>
          <p className="mt-1 text-sm text-gray-500">Data persistence and cleanup behavior</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Commit Mode</label>
              <select
                value={config.staging.commit_mode}
                onChange={(e) => handleConfigChange('staging.commit_mode', e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-[var(--brand-500)] focus:ring-[var(--brand-500)] sm:text-sm"
              >
                <option value="all_or_nothing">All or Nothing</option>
                <option value="best_effort">Best Effort</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">Transaction behavior on errors</p>
            </div>

            <div className="flex items-center pt-6">
              <input
                type="checkbox"
                id="auto_cleanup"
                checked={config.staging.auto_cleanup_on_fail}
                onChange={(e) => handleConfigChange('staging.auto_cleanup_on_fail', e.target.checked)}
                className="h-4 w-4 text-[var(--brand-600)] focus:ring-[var(--brand-500)] border-gray-300 rounded"
              />
              <label htmlFor="auto_cleanup" className="ml-2 block text-sm text-gray-700">
                Auto-cleanup on failure
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
