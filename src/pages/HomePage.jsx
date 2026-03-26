// HomePage — Dashboard landing page (Digital Worker is the mainline product)
import { lazy, Suspense } from 'react';

const AIEmployeeHome = lazy(() => import('./AIEmployeeHome'));

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <AIEmployeeHome />
    </Suspense>
  );
}
