// ============================================
// AI Employee Home — Chat-first Agent-as-UI homepage
// Main screen = DecisionSupportView
// ============================================

import DecisionSupportView from '../views/DecisionSupportView';
import { useAuth } from '../contexts/AuthContext';

export default function AIEmployeeHome() {
  const { user, addNotification } = useAuth();

  return (
    <div className="h-full min-w-0 overflow-hidden">
      <div className="h-full min-w-0">
        <DecisionSupportView user={user} addNotification={addNotification} mode="ai_employee" />
      </div>
    </div>
  );
}
