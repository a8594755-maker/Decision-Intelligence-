import { lazy, Suspense } from 'react';
const EvalLabView = lazy(() => import('../views/EvalLabView'));
export default function EvalLabPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading...</div>}>
      <EvalLabView />
    </Suspense>
  );
}
