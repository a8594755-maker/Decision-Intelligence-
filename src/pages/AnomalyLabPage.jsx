/**
 * AnomalyLabPage — Standalone anomaly detection test page.
 * Route: /anomaly-lab
 */
import { lazy, Suspense } from 'react';

const AnomalyLabView = lazy(() => import('../views/AnomalyLabView'));

export default function AnomalyLabPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading...</div>}>
      <AnomalyLabView />
    </Suspense>
  );
}
