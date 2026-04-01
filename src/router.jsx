import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from './layouts/AppShell';

// Route-level code splitting — each page becomes a separate chunk
const LoginPage = lazy(() => import('./pages/LoginPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const ForecastStudio = lazy(() => import('./pages/ForecastStudio'));
const RiskCenter = lazy(() => import('./pages/RiskCenter'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DigitalTwin = lazy(() => import('./pages/DigitalTwin'));
const ScenarioStudio = lazy(() => import('./pages/ScenarioStudio'));
const OpsDashboard = lazy(() => import('./pages/OpsDashboard'));
const SyntheticERPSandbox = lazy(() => import('./pages/SyntheticERPSandbox'));
const NegotiationWorkbench = lazy(() => import('./pages/NegotiationWorkbench'));
// @product: ai-employee — consolidated into WorkersHub
const WorkersHub = lazy(() => import('./pages/WorkersHub'));
// @product: insights-hub
const InsightsHub = lazy(() => import('./pages/InsightsHub'));
const ChartTest = lazy(() => import('./pages/ChartTest'));
// @product: unified-workspace (Canvas Architecture)
const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
// @product: mbr-lab — standalone MBR generation test page
const MbrLabPage = lazy(() => import('./pages/MbrLabPage'));
// @product: kpi-lab — standalone KPI calculation test page
const KpiLabPage = lazy(() => import('./pages/KpiLabPage'));
// @product: variance-lab — standalone variance analysis test page
const VarianceLabPage = lazy(() => import('./pages/VarianceLabPage'));
// @product: anomaly-lab — standalone anomaly detection test page
const AnomalyLabPage = lazy(() => import('./pages/AnomalyLabPage'));

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Suspense fallback={null}><LoginPage /></Suspense>,
  },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'forecast', element: <ForecastStudio /> },
      { path: 'risk', element: <RiskCenter /> },
      { path: 'digital-twin', element: <DigitalTwin /> },
      { path: 'scenarios', element: <ScenarioStudio /> },
      { path: 'negotiation', element: <NegotiationWorkbench /> },

      // @product: ai-employee — Workers Hub (consolidated)
      { path: 'employees', element: <WorkersHub /> },

      // Legacy employee/* redirects → Workers Hub with query params
      { path: 'employees/tasks',     element: <Navigate to="/employees?tab=tasks" replace /> },
      { path: 'employees/review',    element: <Navigate to="/employees?tab=review" replace /> },
      { path: 'employees/approvals', element: <Navigate to="/employees?tab=review" replace /> },
      { path: 'employees/tools',     element: <Navigate to="/employees?tab=config&section=tools" replace /> },
      { path: 'employees/profiles',  element: <Navigate to="/employees?tab=config&section=profiles" replace /> },
      { path: 'employees/templates', element: <Navigate to="/employees?tab=config&section=templates" replace /> },
      { path: 'employees/policies',  element: <Navigate to="/employees?tab=config&section=policies" replace /> },
      { path: 'employees/webhooks',  element: <Navigate to="/employees?tab=config&section=webhooks" replace /> },
      { path: 'employees/schedules', element: <Navigate to="/employees?tab=config&section=schedules" replace /> },

      // @product: insights-hub
      { path: 'insights', element: <InsightsHub /> },
      { path: 'chart-test', element: <ChartTest /> },

      // @product: unified-workspace (Canvas Architecture — Trinity Layout)
      { path: 'workspace', element: <WorkspacePage /> },
      { path: 'ops', element: <OpsDashboard /> },
      { path: 'mbr-lab', element: <MbrLabPage /> },
      { path: 'kpi-lab', element: <KpiLabPage /> },
      { path: 'variance-lab', element: <VarianceLabPage /> },
      { path: 'anomaly-lab', element: <AnomalyLabPage /> },
      { path: 'sandbox', element: <SyntheticERPSandbox /> },
      { path: 'settings', element: <SettingsPage /> },

      // Golden path convergence: /workspace is the primary entry point
      { path: 'plan', element: <Navigate to="/workspace" replace /> },
      { path: 'chat', element: <Navigate to="/workspace" replace /> },

      // Legacy redirects
      { path: 'ai/decision', element: <Navigate to="/workspace" replace /> },
      { path: 'planning/forecasts', element: <Navigate to="/workspace?widget=forecast" replace /> },
      { path: 'planning/risk-dashboard', element: <Navigate to="/workspace?widget=risk" replace /> },
      { path: 'home', element: <Navigate to="/" replace /> },
      { path: 'data/*', element: <Navigate to="/settings" replace /> },
      { path: 'analysis/*', element: <Navigate to="/" replace /> },
      { path: 'operations/*', element: <Navigate to="/" replace /> },

      // Catch-all
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
