/**
 * OpenCloudPublishCard
 *
 * Chat card that renders after artifacts are published to OpenCloud.
 * Shows file list with sharing links, copy-to-clipboard, and open-in-OpenCloud actions.
 *
 * Renders the `opencloud_file_ref` artifact type.
 */

import React, { useState } from 'react';
import { Cloud, ExternalLink, Copy, CheckCircle, FileText, Share2 } from 'lucide-react';
import { Card, Badge } from '../ui';

function FileRow({ file }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e) => {
    e.stopPropagation();
    const url = file.sharingLink || file.webUrl || '';
    if (url) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const handleOpen = (e) => {
    e.stopPropagation();
    const url = file.webUrl || file.sharingLink;
    if (url) window.open(url, '_blank', 'noopener');
  };

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
      <FileText className="w-4 h-4 text-blue-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900 dark:text-gray-100 truncate">{file.filename}</div>
        <div className="text-xs text-gray-400">{file.artifact_type || 'file'}</div>
      </div>
      <div className="flex items-center gap-1">
        {(file.sharingLink || file.webUrl) && (
          <>
            <button
              onClick={handleCopy}
              className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Copy link"
            >
              {copied
                ? <CheckCircle className="w-4 h-4 text-emerald-500" />
                : <Copy className="w-4 h-4 text-gray-400" />
              }
            </button>
            <button
              onClick={handleOpen}
              className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Open in OpenCloud"
            >
              <ExternalLink className="w-4 h-4 text-gray-400" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function OpenCloudPublishCard({ artifact }) {
  const payload = artifact?.payload || artifact?.data || artifact || {};
  const files = payload.files || [];
  const totalFiles = payload.total_files || files.length;
  const syncedAt = payload.synced_at;

  return (
    <Card className="border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/20 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-blue-100 dark:border-blue-800">
        <Cloud className="w-5 h-5 text-blue-500" />
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          Published to OpenCloud
        </span>
        <Badge type="info" className="ml-auto">{totalFiles} file{totalFiles !== 1 ? 's' : ''}</Badge>
      </div>

      {/* File list */}
      <div className="px-1 py-1">
        {files.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-4">No files published</div>
        ) : (
          files.map((file, i) => <FileRow key={i} file={file} />)
        )}
      </div>

      {/* Footer */}
      {syncedAt && (
        <div className="px-4 py-2 border-t border-blue-100 dark:border-blue-800 text-xs text-gray-400 flex items-center gap-2">
          <Share2 className="w-3 h-3" />
          Synced at {new Date(syncedAt).toLocaleString()}
        </div>
      )}
    </Card>
  );
}
