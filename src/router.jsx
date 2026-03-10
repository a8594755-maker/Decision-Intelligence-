import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from './layouts/AppShell';

// Route-level code splitting — each page becomes a separate chunk
const LoginPage = lazy(() => import('./pages/LoginPage'));
const CommandCenter = lazy(() => import('./pages/CommandCenter'));
const PlanStudio = lazy(() => import('./pages/PlanStudio'));
const ForecastStudio = lazy(() => import('./pages/ForecastStudio'));
const RiskCenter = lazy(() => import('./pages/RiskCenter'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DigitalTwin = lazy(() => import('./pages/DigitalTwin'));
const ScenarioStudio = lazy(() => import('./pages/ScenarioStudio'));
const OpsDashboard = lazy(() => import('./pages/OpsDashboard'));
const SyntheticERPSandbox = lazy(() => import('./pages/SyntheticERPSandbox'));
const NegotiationWorkbench = lazy(() => import('./pages/NegotiationWorkbench'));

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Suspense fallback={null}><LoginPage /></Suspense>,
  },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <CommandCenter /> },
      { path: 'plan', element: <PlanStudio /> },
      { path: 'forecast', element: <ForecastStudio /> },
      { path: 'risk', element: <RiskCenter /> },
      { path: 'digital-twin', element: <DigitalTwin /> },
      { path: 'scenarios', element: <ScenarioStudio /> },
      { path: 'negotiation', element: <NegotiationWorkbench /> },
      { path: 'ops', element: <OpsDashboard /> },
      { path: 'sandbox', element: <SyntheticERPSandbox /> },
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
