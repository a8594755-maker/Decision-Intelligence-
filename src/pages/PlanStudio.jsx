import DecisionSupportView from '../views/DecisionSupportView';
import { useAuth } from '../contexts/AuthContext';

export default function PlanStudio() {
  const { user, addNotification } = useAuth();
  return <DecisionSupportView user={user} addNotification={addNotification} />;
}
