import ForecastsView from '../views/ForecastsView';
import { useAuth } from '../contexts/AuthContext';

export default function ForecastStudio() {
  const { user, addNotification } = useAuth();
  return <ForecastsView user={user} addNotification={addNotification} />;
}
