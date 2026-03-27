// ============================================
// Overview Tab Component
// Displays published version info and draft changes summary
// ============================================

import { formatDistanceToNow, format } from 'date-fns';
import { 
  getStatusColor, 
  getStatusText,
  compareConfigs,
  DEFAULT_LOGIC_CONFIG 
} from '../../services/governance/logicVersionService';

export default function OverviewTab({ 
  publishedVersion, 
  draftVersion, 
  _selectedScope,
  onCreateDraft,
  canEdit 
}) {
  // Calculate diff between published and draft
  const diff = publishedVersion && draftVersion 
    ? compareConfigs(publishedVersion.config_json, draftVersion.config_json)
    : { hasChanges: false, changes: [] };

  // Group changes by section
  const changesBySection = diff.changes.reduce((acc, change) => {
    const section = change.path.split('.')[0];
    if (!acc[section]) acc[section] = [];
    acc[section].push(change);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Current Published Version */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Current Published Version
          </h2>
          {publishedVersion ? (
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor('published')}`}>
              Published
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
              No Published Version
            </span>
          )}
        </div>

        {publishedVersion ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500">Version ID</p>
                <p className="text-sm font-mono text-gray-900">{publishedVersion.id.slice(0, 8)}...</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Schema Version</p>
                <p className="text-sm text-gray-900">{publishedVersion.schema_version}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Effective From</p>
                <p className="text-sm text-gray-900">
                  {format(new Date(publishedVersion.effective_from), 'PPP')}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Published</p>
                <p className="text-sm text-gray-900">
                  {publishedVersion.published_at 
                    ? `${formatDistanceToNow(new Date(publishedVersion.published_at))} ago`
                    : 'N/A'
                  }
                </p>
              </div>
            </div>

            {/* Config Summary */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <h3 className="text-sm font-medium text-gray-900 mb-3">Configuration Summary</h3>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="bg-gray-50 rounded p-3">
                  <p className="text-gray-500">Limits</p>
                  <p className="font-medium">MAX_DEPTH: {publishedVersion.config_json?.limits?.MAX_BOM_DEPTH}</p>
                  <p className="text-gray-600">ZOMBIE: {publishedVersion.config_json?.limits?.ZOMBIE_AFTER_SECONDS}s</p>
                </div>
                <div className="bg-gray-50 rounded p-3">
                  <p className="text-gray-500">Rules</p>
                  <p className="font-medium">Cycle: {publishedVersion.config_json?.rules?.cycle_policy}</p>
                  <p className="text-gray-600">Depth: {publishedVersion.config_json?.rules?.max_depth_policy}</p>
                </div>
                <div className="bg-gray-50 rounded p-3">
                  <p className="text-gray-500">Sharding</p>
                  <p className="font-medium">Strategy: {publishedVersion.config_json?.sharding?.strategy}</p>
                  <p className="text-gray-600">Size: {publishedVersion.config_json?.sharding?.shard_size_weeks} weeks</p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-8">
            <p className="text-gray-500 mb-4">No published version exists for this scope.</p>
            {canEdit && (
              <button
                onClick={onCreateDraft}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--brand-600)] hover:bg-[var(--brand-700)]"
              >
                Create First Version
              </button>
            )}
          </div>
        )}
      </div>

      {/* Draft Changes */}
      {draftVersion && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Draft Changes
            </h2>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(draftVersion.status)}`}>
              {getStatusText(draftVersion.status)}
            </span>
          </div>

          {diff.hasChanges ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {diff.changes.length} changes from published version:
              </p>

              {Object.entries(changesBySection).map(([section, changes]) => (
                <div key={section} className="border-l-4 border-[var(--brand-500)] pl-4">
                  <h4 className="text-sm font-medium text-gray-900 capitalize mb-2">
                    {section}
                  </h4>
                  <ul className="space-y-2">
                    {changes.map((change, idx) => (
                      <li key={idx} className="text-sm flex items-center justify-between bg-gray-50 rounded p-2">
                        <span className="text-gray-700">{change.path}</span>
                        <div className="flex items-center space-x-2">
                          <span className="text-red-600 line-through">{String(change.before)}</span>
                          <span className="text-gray-400">→</span>
                          <span className="text-green-600 font-medium">{String(change.after)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              {draftVersion.submit_comment && (
                <div className="mt-4 p-3 bg-blue-50 rounded">
                  <p className="text-sm font-medium text-blue-900">Change Reason:</p>
                  <p className="text-sm text-blue-800">{draftVersion.submit_comment}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-gray-500">No changes from published version.</p>
          )}
        </div>
      )}

      {/* Impact Assessment Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Impact Assessment
        </h2>
        
        {draftVersion ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-yellow-50 rounded">
              <div className="flex items-center">
                <svg className="w-5 h-5 text-yellow-400 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span className="text-sm font-medium text-yellow-800">
                  Sandbox test required before publishing
                </span>
              </div>
              <button
                onClick={onCreateDraft}
                className="text-sm text-[var(--brand-600)] hover:text-[var(--brand-600)] font-medium"
              >
                Go to Sandbox →
              </button>
            </div>

            {diff.changes.some(c => c.path.includes('MAX_BOM_DEPTH') || c.path.includes('MAX_TRACE')) && (
              <div className="flex items-center p-3 bg-red-50 rounded">
                <svg className="w-5 h-5 text-red-400 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span className="text-sm text-red-800">
                  Limit changes detected - may affect job execution boundaries
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-gray-500">Create a draft to see impact assessment.</p>
        )}
      </div>
    </div>
  );
}
