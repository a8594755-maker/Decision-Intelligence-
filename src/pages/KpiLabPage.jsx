/**
 * KpiLabPage — Standalone test page for KPI calculation.
 * Upload any Excel → profile → AI maps columns → deterministic KPI engine.
 * Route: /kpi-lab
 */
import { lazy, Suspense } from 'react';

const KpiLabView = lazy(() => import('../views/KpiLabView'));

export default function KpiLabPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading...</div>}>
      <KpiLabView />
    </Suspense>
  );
}
