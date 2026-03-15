/**
 * useOpenCloudAuth — React hook for OpenCloud authentication state.
 *
 * Checks if OpenCloud is configured and reachable.
 * Provides connect/disconnect controls (Phase 1: env-var token only,
 * OIDC exchange deferred to Phase 4).
 */

import { useState, useEffect, useCallback } from 'react';
import { isOpenCloudConfigured, OPENCLOUD_URL } from '../config/opencloudConfig';
import { checkHealth, getMe } from '../services/opencloudClientService';

export default function useOpenCloudAuth() {
  const [isConnected, setIsConnected] = useState(false);
  const [userInfo, setUserInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const configured = isOpenCloudConfigured();

  // Check connection on mount
  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const healthy = await checkHealth();
        if (healthy) {
          const me = await getMe();
          setUserInfo(me);
          setIsConnected(true);
        }
      } catch (err) {
        setError(err?.message);
        setIsConnected(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [configured]);

  const connect = useCallback(async () => {
    if (!configured) {
      setError('OpenCloud not configured');
      return false;
    }
    setLoading(true);
    try {
      const healthy = await checkHealth();
      if (!healthy) throw new Error('OpenCloud server is not reachable');
      const me = await getMe();
      setUserInfo(me);
      setIsConnected(true);
      setError(null);
      return true;
    } catch (err) {
      setError(err?.message);
      setIsConnected(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, [configured]);

  const disconnect = useCallback(() => {
    setIsConnected(false);
    setUserInfo(null);
    setError(null);
  }, []);

  return {
    configured,
    isConnected,
    userInfo,
    loading,
    error,
    serverUrl: OPENCLOUD_URL,
    connect,
    disconnect,
  };
}
