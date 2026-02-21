import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import LoginPage from './pages/LoginPage';
import CommandCenter from './pages/CommandCenter';
import PlanStudio from './pages/PlanStudio';
import ForecastStudio from './pages/ForecastStudio';
import RiskCenter from './pages/RiskCenter';
import SettingsPage from './pages/SettingsPage';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <CommandCenter /> },
      { path: 'plan', element: <PlanStudio /> },
      { path: 'forecast', element: <ForecastStudio /> },
      { path: 'risk', element: <RiskCenter /> },
      { path: 'settings', element: <SettingsPage /> },

      // Legacy redirects (previously handled by src/utils/router.js)
      { path: 'ai/decision', element: <Navigate to="/plan" replace /> },
      { path: 'planning/forecasts', element: <Navigate to="/forecast" replace /> },
      { path: 'planning/risk-dashboard', element: <Navigate to="/risk" replace /> },
      { path: 'home', element: <Navigate to="/" replace /> },
      { path: 'data/*', element: <Navigate to="/settings" replace /> },
      { path: 'analysis/*', element: <Navigate to="/" replace /> },
      { path: 'operations/*', element: <Navigate to="/" replace /> },

      // Catch-all
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
