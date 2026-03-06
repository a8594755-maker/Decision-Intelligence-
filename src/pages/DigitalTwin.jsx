import DigitalTwinView from '../views/DigitalTwinView';
import { useAuth } from '../contexts/AuthContext';

export default function DigitalTwin() {
  const { user, addNotification } = useAuth();
  return <DigitalTwinView user={user} addNotification={addNotification} />;
}
