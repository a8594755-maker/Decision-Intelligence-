import { lazy, Suspense } from 'react';
import { useAuth } from '../contexts/AuthContext';

const DecisionSupportView = lazy(() => import('../views/DecisionSupportView'));

export default function PlanStudio() {
  const { user, addNotification } = useAuth();
  return (
    <Suspense fallback={null}>
      <DecisionSupportView user={user} addNotification={addNotification} />
    </Suspense>
  );
}
