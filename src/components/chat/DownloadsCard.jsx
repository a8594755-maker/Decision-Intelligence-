import React from 'react';
import { Download } from 'lucide-react';
import { Card, Button } from '../ui';
import { loadArtifact } from '../../utils/artifactStore';

const triggerDownload = async (file) => {
  if (!file) return;

  // Direct URL download (e.g., from ML API)
  if (file.url) {
    const link = document.createElement('a');
    link.href = file.url;
    link.download = file.fileName || 'download';
    link.click();
    return;
  }

  let content = file.content;
  if ((content === undefined || content === null || content === '') && file.ref) {
    content = await loadArtifact(file.ref);
  }

  if (
    typeof file.mimeType === 'string'
    && file.mimeType.startsWith('text/csv')
    && content
    && typeof content === 'object'
    && typeof content.content === 'string'
  ) {
    content = content.content;
  }

  const mimeType = file.mimeType || 'application/json;charset=utf-8';
  const payload = typeof content === 'string'
    ? content
    : JSON.stringify(content ?? {}, null, 2);

  const blob = new Blob([payload], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName || 'artifact.json';
  link.click();
  URL.revokeObjectURL(url);
};

export default function DownloadsCard({ payload }) {
  if (!payload) return null;
  const files = Array.isArray(payload.files) ? payload.files : [];

  return (
    <Card category="system" className="w-full border border-[var(--border-default)]">
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Downloads Card</h4>
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <Button
              key={`${file.fileName}-${file.label}`}
              variant="secondary"
              className="text-xs"
              onClick={() => triggerDownload(file)}
            >
              <Download className="w-3 h-3 mr-1" />
              {file.label || file.fileName}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  );
}
