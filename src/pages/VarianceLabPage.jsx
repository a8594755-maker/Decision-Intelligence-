/**
 * VarianceLabPage — Standalone variance analysis test page.
 * Route: /variance-lab
 */
import { lazy, Suspense } from 'react';

const VarianceLabView = lazy(() => import('../views/VarianceLabView'));

export default function VarianceLabPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading...</div>}>
      <VarianceLabView />
    </Suspense>
  );
}
