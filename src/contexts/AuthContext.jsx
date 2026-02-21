import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../services/supabaseClient';
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

  // Bootstrap auth session
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

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

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
