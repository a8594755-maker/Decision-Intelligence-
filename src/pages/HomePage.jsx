// HomePage — Thin wrapper that renders the correct home based on active workspace.
import { lazy, Suspense } from 'react';
import { useApp } from '../contexts/AppContext';

const CommandCenter = lazy(() => import('./CommandCenter'));
const AIEmployeeHome = lazy(() => import('./AIEmployeeHome'));

export default function HomePage() {
  const { activeWorkspace } = useApp();

  if (activeWorkspace === 'di') {
    return (
      <Suspense fallback={null}>
        <CommandCenter />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={null}>
      <AIEmployeeHome />
    </Suspense>
  );
}
