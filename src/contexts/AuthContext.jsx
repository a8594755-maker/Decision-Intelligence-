import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../services/supabaseClient';
import { PermissionsProvider } from '../hooks/usePermissions';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState('viewer');
  const [notifications, setNotifications] = useState([]);
  const notifIdRef = useRef(0);

  const addNotification = useCallback((msg, type = 'info') => {
    const id = `n-${++notifIdRef.current}-${Date.now()}`;
    setNotifications(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 3000);
  }, []);

  const loadUserRole = useCallback(async (userId) => {
    if (!userId) {
      setRole('viewer');
      return;
    }

    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.warn('Failed to load user role:', error.message);
        setRole('viewer');
        return;
      }

      setRole(data?.role || 'viewer');
    } catch (err) {
      console.warn('Failed to load user role:', err?.message || err);
      setRole('viewer');
    }
  }, []);

  // Bootstrap auth session
  // We rely on onAuthStateChange as the primary session source because it fires
  // immediately with the current session and does NOT acquire navigator.locks.
  // getSession() uses navigator.locks with infinite timeout, which deadlocks under
  // React 18 Strict Mode (doubleInvokeEffectsInDEV) and Vite HMR reloads.
  useEffect(() => {
    // Mock mode: bypass Supabase auth entirely
    if (import.meta.env?.VITE_DI_MOCK_MODE === 'true') {
      console.info('[Auth] Mock mode — using fake user');
      setSession({
        user: { id: 'mock-user-001', email: 'dev@localhost', user_metadata: {} },
        access_token: 'mock-token',
      });
      setRole('admin');
      setLoading(false);
      return;
    }

    if (!isSupabaseConfigured) {
      queueMicrotask(() => setLoading(false));
      return;
    }

    const t0 = performance.now();
    let resolved = false;

    // Safety timeout — if onAuthStateChange never fires, unblock UI
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn(`[Auth] bootstrap timed out after ${Math.round(performance.now() - t0)}ms, proceeding without session`);
        setLoading(false);
      }
    }, 8000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      const elapsed = Math.round(performance.now() - t0);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.info(`[Auth] onAuthStateChange initial event in ${elapsed}ms — session: ${s ? 'yes' : 'none'}, event: ${_event}`);
      }
      setSession(s);
      // Unblock UI immediately — load role in background (don't let it block rendering)
      setLoading(false);
      loadUserRole(s?.user?.id ?? null).catch(() => {});
    });

    return () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, [loadUserRole]);

  const handleLogin = useCallback(async (email, password, selectedRole) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      addNotification(error.message, 'error');
      return false;
    }
    // Upsert user role
    try {
      await supabase
        .from('user_profiles')
        .upsert({
          user_id: data.user.id,
          role: selectedRole || role,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
    } catch (err) {
      console.error('Role update error:', err);
    }
    setRole(selectedRole || role);
    addNotification(`Login Successful (Role: ${selectedRole || role})`, 'success');
    return true;
  }, [role, addNotification]);

  const handleSignUp = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) {
      addNotification(error.message, 'error');
      return false;
    }
    addNotification('Signup success! Please login.', 'info');
    return true;
  }, [addNotification]);

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut();
    addNotification('Logged out', 'info');
  }, [addNotification]);

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    role,
    setRole,
    notifications,
    addNotification,
    handleLogin,
    handleSignUp,
    handleLogout,
  };

  return (
    <AuthContext.Provider value={value}>
      <PermissionsProvider userId={session?.user?.id ?? null}>
        {children}
      </PermissionsProvider>
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
