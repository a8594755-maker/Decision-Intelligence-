import { useNavigate } from 'react-router-dom';
import RiskDashboardView from '../views/RiskDashboardView';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';

export default function RiskCenter() {
  const { user, addNotification } = useAuth();
  const { globalDataSource, setGlobalDataSource } = useApp();
  const navigate = useNavigate();

  return (
    <RiskDashboardView
      user={user}
      addNotification={addNotification}
      setView={(v) => navigate(`/${v === 'decision' ? 'plan' : v}`)}
      globalDataSource={globalDataSource}
      setGlobalDataSource={setGlobalDataSource}
    />
  );
}
