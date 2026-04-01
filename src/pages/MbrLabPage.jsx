/**
 * MbrLabPage — Standalone test page for MBR generation.
 * Upload any Excel → LLM analyzes → produces formatted MBR workbook.
 * Route: /mbr-lab
 */
import { lazy, Suspense } from 'react';

const MbrLabView = lazy(() => import('../views/MbrLabView'));

export default function MbrLabPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading...</div>}>
      <MbrLabView />
    </Suspense>
  );
}
