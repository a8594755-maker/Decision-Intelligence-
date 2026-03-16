import { Suspense, lazy } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import Sidebar from '../components/nav/TopNavBar';
import ErrorBoundary from '../components/ErrorBoundary';
import NetworkStatusBanner from '../components/NetworkStatusBanner';

const AiEmployeeRuntimeManager = lazy(() => import('../components/ai-employee/AiEmployeeRuntimeManager'));

export default function AppShell() {
  const { session, loading, notifications } = useAuth();
  const { darkMode } = useApp();

  if (loading) {
    return (
      <div
        className="h-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--surface-base)' }}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 animate-pulse" />
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</span>
        </div>
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return (
    <div
      className={`h-screen flex overflow-hidden transition-colors duration-300 ${
        darkMode ? 'dark' : ''
      }`}
      style={{ backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}
    >
      <Sidebar />
      <Suspense fallback={null}>
        <AiEmployeeRuntimeManager />
      </Suspense>

      {/* Notification toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {notifications.map(n => (
          <div
            key={n.id}
            className={`flex items-center px-4 py-3 rounded-xl text-white text-sm font-medium animate-slide-up ${
              n.type === 'error'
                ? 'bg-red-600'
                : n.type === 'success'
                  ? 'bg-emerald-600'
                  : 'bg-indigo-600'
            }`}
            style={{ boxShadow: 'var(--shadow-float)' }}
          >
            {n.msg}
          </div>
        ))}
      </div>

      <main
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden flex flex-col"
        style={{ backgroundColor: 'var(--surface-base)' }}
      >
        <NetworkStatusBanner />
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 animate-pulse" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
