/**
 * MappingProfileManager
 *
 * Lightweight panel for viewing and managing saved mapping profiles.
 * Users can see which profiles exist, view their column mappings, and delete them.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Trash2, Database, ArrowRight, RefreshCw } from 'lucide-react';
import { Badge, Button } from './ui';
import { listMappingProfiles, deleteMappingProfileById } from '../services/data-prep/mappingProfileService';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';

const UPLOAD_TYPE_LABELS = Object.fromEntries(
  Object.entries(UPLOAD_SCHEMAS).map(([key, schema]) => [key, schema.label || key])
);

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

function ProfileCard({ profile, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mapping = profile.column_mapping || {};
  const mappingEntries = Object.entries(mapping);
  const headerCount = profile.header_list?.length || mappingEntries.length;

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete mapping profile for "${UPLOAD_TYPE_LABELS[profile.upload_type] || profile.upload_type}"?`)) return;
    setDeleting(true);
    try {
      await onDelete(profile);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      {/* Header row — clickable to expand */}
      <button
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
          : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
        }
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {UPLOAD_TYPE_LABELS[profile.upload_type] || profile.upload_type}
            </span>
            <Badge type="info">{headerCount} cols</Badge>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-slate-400">
              Last used: {formatDate(profile.last_used_at)}
            </span>
            <span className="text-xs text-slate-400">
              Used {profile.use_count || 1}x
            </span>
          </div>
        </div>
        <button
          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
          onClick={handleDelete}
          disabled={deleting}
          title="Delete profile"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </button>

      {/* Expanded: show mapping table */}
      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-700 p-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="text-left font-medium pb-1.5">Source Column</th>
                <th className="w-6"></th>
                <th className="text-left font-medium pb-1.5">Target Field</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {mappingEntries.map(([src, target]) => (
                <tr key={src}>
                  <td className="py-1 font-mono text-slate-600 dark:text-slate-300 truncate max-w-[160px]">{src}</td>
                  <td className="py-1 text-center"><ArrowRight className="w-3 h-3 text-slate-300" /></td>
                  <td className="py-1 font-mono text-blue-600 dark:text-blue-400 truncate max-w-[160px]">{target}</td>
                </tr>
              ))}
              {mappingEntries.length === 0 && (
                <tr><td colSpan={3} className="py-2 text-slate-400 text-center">No mappings recorded</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function MappingProfileManager({ userId }) {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadProfiles = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await listMappingProfiles({ userId });
      setProfiles(data || []);
    } catch {
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const handleDelete = useCallback(async (profile) => {
    await deleteMappingProfileById({
      userId,
      id: profile.id,
      fingerprint: profile.source_fingerprint,
      uploadType: profile.upload_type,
    });
    setProfiles(prev => prev.filter(p => p.id !== profile.id && p.source_fingerprint !== profile.source_fingerprint));
  }, [userId]);

  // Group by upload_type
  const grouped = profiles.reduce((acc, p) => {
    const key = p.upload_type || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-slate-400">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading saved profiles...
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-slate-400">
        <Database className="w-4 h-4" />
        No saved mapping profiles yet. Profiles are created automatically after a successful import.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">{profiles.length} profile(s) saved</p>
        <button
          className="text-xs text-blue-500 hover:text-blue-600 flex items-center gap-1"
          onClick={loadProfiles}
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      {Object.entries(grouped).map(([uploadType, items]) => (
        <div key={uploadType} className="space-y-1.5">
          {Object.keys(grouped).length > 1 && (
            <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              {UPLOAD_TYPE_LABELS[uploadType] || uploadType}
            </h4>
          )}
          {items.map((profile, i) => (
            <ProfileCard key={profile.id || i} profile={profile} onDelete={handleDelete} />
          ))}
        </div>
      ))}
    </div>
  );
}
