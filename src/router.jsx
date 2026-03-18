import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from './layouts/AppShell';

// Route-level code splitting — each page becomes a separate chunk
const LoginPage = lazy(() => import('./pages/LoginPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const PlanStudio = lazy(() => import('./pages/PlanStudio'));
const ForecastStudio = lazy(() => import('./pages/ForecastStudio'));
const RiskCenter = lazy(() => import('./pages/RiskCenter'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DigitalTwin = lazy(() => import('./pages/DigitalTwin'));
const ScenarioStudio = lazy(() => import('./pages/ScenarioStudio'));
const OpsDashboard = lazy(() => import('./pages/OpsDashboard'));
const SyntheticERPSandbox = lazy(() => import('./pages/SyntheticERPSandbox'));
const NegotiationWorkbench = lazy(() => import('./pages/NegotiationWorkbench'));
// @product: ai-employee
const EmployeesPage       = lazy(() => import('./pages/EmployeesPage'));
const EmployeeTasksPage   = lazy(() => import('./pages/EmployeeTasksPage'));
const EmployeeReviewPage  = lazy(() => import('./pages/EmployeeReviewPage'));
const ToolRegistryPage    = lazy(() => import('./pages/ToolRegistryPage'));
const OutputProfilesPage  = lazy(() => import('./pages/OutputProfilesPage'));
const WorkerTemplatesPage = lazy(() => import('./pages/WorkerTemplatesPage'));
const PolicyRulesPage     = lazy(() => import('./pages/PolicyRulesPage'));
const WebhookConfigPage   = lazy(() => import('./pages/WebhookConfigPage'));
const ScheduleManagerPage = lazy(() => import('./pages/ScheduleManagerPage'));
const ApprovalQueuePage  = lazy(() => import('./pages/ApprovalQueuePage'));
// @product: unified-workspace (Canvas Architecture)
const WorkspacePage      = lazy(() => import('./pages/WorkspacePage'));

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
      { path: 'plan', element: <PlanStudio /> },
      { path: 'forecast', element: <ForecastStudio /> },
      { path: 'risk', element: <RiskCenter /> },
      { path: 'digital-twin', element: <DigitalTwin /> },
      { path: 'scenarios', element: <ScenarioStudio /> },
      { path: 'negotiation', element: <NegotiationWorkbench /> },
      // @product: ai-employee
      { path: 'employees',        element: <EmployeesPage /> },
      { path: 'employees/tasks',  element: <EmployeeTasksPage /> },
      { path: 'employees/review', element: <EmployeeReviewPage /> },
      { path: 'employees/tools',  element: <ToolRegistryPage /> },
      { path: 'employees/profiles', element: <OutputProfilesPage /> },
      { path: 'employees/templates', element: <WorkerTemplatesPage /> },
      { path: 'employees/policies',  element: <PolicyRulesPage /> },
      { path: 'employees/webhooks',  element: <WebhookConfigPage /> },
      { path: 'employees/schedules', element: <ScheduleManagerPage /> },
      { path: 'employees/approvals', element: <ApprovalQueuePage /> },
      // @product: unified-workspace (Canvas Architecture — Trinity Layout)
      { path: 'workspace', element: <WorkspacePage /> },
      { path: 'ops', element: <OpsDashboard /> },
      { path: 'sandbox', element: <SyntheticERPSandbox /> },
      { path: 'settings', element: <SettingsPage /> },

      // Legacy redirects (previously handled by src/utils/router.js)
      { path: 'ai/decision', element: <Navigate to="/plan" replace /> },
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
