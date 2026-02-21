import { Outlet, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import TopNavBar from '../components/nav/TopNavBar';

export default function AppShell() {
  const { session, loading, notifications } = useAuth();
  const { darkMode } = useApp();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return (
    <div className={`h-screen overflow-hidden flex flex-col transition-colors duration-300 ${darkMode ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      {/* Notification toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {notifications.map(n => (
          <div
            key={n.id}
            className={`flex items-center p-4 rounded-lg shadow-lg text-white ${
              n.type === 'error' ? 'bg-red-600' : n.type === 'success' ? 'bg-emerald-600' : 'bg-blue-600'
            }`}
          >
            {n.msg}
          </div>
        ))}
      </div>

      <TopNavBar />

      <main className="flex-1 min-h-0 h-full overflow-hidden bg-gray-50 dark:bg-slate-900">
        <Outlet />
      </main>
    </div>
  );
}
