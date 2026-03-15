/**
 * OpenCloudFilePicker
 *
 * Modal/drawer component that lets users browse their OpenCloud drives
 * and select files for import into the DI pipeline.
 *
 * Features:
 * - Tree-view directory navigation with breadcrumbs
 * - File type filtering (.xlsx, .csv, .json)
 * - File metadata preview (name, size, modified date)
 * - Integrates with DataImportPanel flow
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cloud, Folder, FileText, FileSpreadsheet, ChevronRight, ArrowLeft, Loader2, X, Download } from 'lucide-react';
import { Card } from '../ui';
import { browseFiles, getDefaultDriveId } from '../../services/opencloudArtifactSync';
import { getMyDrives } from '../../services/opencloudClientService';
import { isOpenCloudConfigured } from '../../config/opencloudConfig';

const FILE_FILTERS = ['.xlsx', '.csv', '.json', '.xls'];

const ICON_MAP = {
  csv: FileText,
  json: FileText,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
};

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

export default function OpenCloudFilePicker({ onSelect, onClose }) {
  const [driveId, setDriveId] = useState(null);
  const [drives, setDrives] = useState([]);
  const [items, setItems] = useState([]);
  const [breadcrumbs, setBreadcrumbs] = useState([{ id: null, name: 'Root' }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id || null;

  // Load drives on mount
  useEffect(() => {
    if (!isOpenCloudConfigured()) {
      setError('OpenCloud is not configured. Set VITE_OPENCLOUD_URL and VITE_OPENCLOUD_TOKEN.');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const allDrives = await getMyDrives();
        setDrives(allDrives);
        const defaultId = await getDefaultDriveId();
        if (defaultId) setDriveId(defaultId);
        else if (allDrives.length > 0) setDriveId(allDrives[0].id);
      } catch (err) {
        setError(`Failed to connect: ${err?.message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load items when driveId or folder changes
  useEffect(() => {
    if (!driveId) return;
    setLoading(true);
    setError(null);

    browseFiles(driveId, currentFolderId, { filter: FILE_FILTERS })
      .then((result) => {
        // Sort: folders first, then files alphabetically
        result.sort((a, b) => {
          if (a.folder && !b.folder) return -1;
          if (!a.folder && b.folder) return 1;
          return (a.name || '').localeCompare(b.name || '');
        });
        setItems(result);
      })
      .catch((err) => setError(err?.message))
      .finally(() => setLoading(false));
  }, [driveId, currentFolderId]);

  const navigateToFolder = useCallback((item) => {
    setBreadcrumbs((prev) => [...prev, { id: item.id, name: item.name }]);
  }, []);

  const navigateBack = useCallback(() => {
    setBreadcrumbs((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const navigateToBreadcrumb = useCallback((index) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  }, []);

  const handleSelect = useCallback((item) => {
    onSelect?.({
      driveId,
      itemId: item.id,
      name: item.name,
      size: item.size,
      mimeType: item.file?.mimeType,
      lastModified: item.lastModifiedDateTime,
    });
  }, [driveId, onSelect]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-blue-500" />
            <span className="font-semibold text-gray-900 dark:text-gray-100">OpenCloud Files</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Drive selector (if multiple drives) */}
        {drives.length > 1 && (
          <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800">
            <select
              value={driveId || ''}
              onChange={(e) => {
                setDriveId(e.target.value);
                setBreadcrumbs([{ id: null, name: 'Root' }]);
              }}
              className="text-sm px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent"
            >
              {drives.map((d) => (
                <option key={d.id} value={d.id}>{d.name || d.id}</option>
              ))}
            </select>
          </div>
        )}

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 px-4 py-2 text-sm text-gray-500 overflow-x-auto">
          {breadcrumbs.length > 1 && (
            <button onClick={navigateBack} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" />}
              <button
                onClick={() => navigateToBreadcrumb(i)}
                className={`truncate max-w-[120px] hover:text-blue-500 ${
                  i === breadcrumbs.length - 1 ? 'text-gray-900 dark:text-gray-100 font-medium' : ''
                }`}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loading && (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading...
            </div>
          )}

          {error && (
            <div className="text-sm text-red-500 px-4 py-4">{error}</div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="text-sm text-gray-400 text-center py-12">
              No files found in this folder
            </div>
          )}

          {!loading && !error && items.map((item) => {
            const isFolder = !!item.folder;
            const ext = (item.name || '').split('.').pop()?.toLowerCase();
            const Icon = isFolder ? Folder : (ICON_MAP[ext] || FileText);

            return (
              <button
                key={item.id}
                onClick={() => isFolder ? navigateToFolder(item) : handleSelect(item)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${isFolder ? 'text-amber-500' : 'text-blue-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {item.name}
                  </div>
                  {!isFolder && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {formatBytes(item.size)} &middot; {formatDate(item.lastModifiedDateTime)}
                    </div>
                  )}
                </div>
                {isFolder ? (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                ) : (
                  <Download className="w-4 h-4 text-gray-400" />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-400">
          Select a .xlsx, .csv, or .json file to import into Decision Intelligence
        </div>
      </Card>
    </div>
  );
}
