import { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  startAiEmployeeRuntime,
  stopAiEmployeeRuntime,
} from '../../services/aiEmployeeRuntimeService.js';

export default function AiEmployeeRuntimeManager() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) {
      stopAiEmployeeRuntime();
      return undefined;
    }

    let cancelled = false;

    const start = async () => {
      try {
        await startAiEmployeeRuntime({ userId: user.id });
      } catch (err) {
        if (!cancelled) {
          console.warn('[AiEmployeeRuntimeManager] Failed to start runtime:', err?.message);
        }
      }
    };

    start();

    return () => {
      cancelled = true;
      stopAiEmployeeRuntime();
    };
  }, [user?.id]);

  return null;
}
