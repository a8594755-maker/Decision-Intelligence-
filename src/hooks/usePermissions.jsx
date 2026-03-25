/**
 * usePermissions.jsx
 *
 * Frontend RBAC core hook.
 * Fetches current user's role + plant scope from Supabase user_profiles,
 * provides can(action) method for all UI components.
 *
 * Design principles:
 *   1. Backend RLS is the ultimate security barrier (don't trust frontend hiding)
 *   2. Frontend RBAC is UX optimization (hide buttons users can't use)
 *   3. Role cached in React Context, no repeated queries
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../services/infra/supabaseClient';

const USER_PROFILES_TABLE = 'user_profiles';
let isUserProfilesUnavailable = false;
let hasWarnedUserProfilesUnavailable = false;

function isMissingTableOrSchemaCacheError(error, tableName) {
  if (!error) return false;

  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const blob = [
    error?.message,
    error?.details,
    error?.hint,
    error?.error_description
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const normalizedTable = String(tableName || '').toLowerCase();
  const tableReferenced = normalizedTable ? blob.includes(normalizedTable) : false;
  const missingSignal =
    blob.includes('schema cache') ||
    blob.includes('does not exist') ||
    blob.includes('relation') ||
    blob.includes('not found') ||
    blob.includes('could not find the table');

  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    status === 404 ||
    (tableReferenced && missingSignal)
  );
}

function buildViewerState(errorMessage = null) {
  return {
    role: 'viewer',
    orgId: null,
    plantScope: null,
    datasetScope: null,
    isLoaded: true,
    error: errorMessage,
  };
}

function markUserProfilesUnavailable(error) {
  isUserProfilesUnavailable = true;
  if (!hasWarnedUserProfilesUnavailable) {
    console.warn(
      '[usePermissions] user_profiles table unavailable. Run sql/migrations/logic_control_center_schema.sql, then NOTIFY pgrst, \'reload schema\'.',
      error?.message || ''
    );
    hasWarnedUserProfilesUnavailable = true;
  }
}

// ── Action definitions (synced with backend rbac.py) ──────────────────────

// eslint-disable-next-line react-refresh/only-export-components -- ACTIONS is a static constant, not a component
export const ACTIONS = {
  // Plan Studio
  RUN_PLAN:              'run_plan',
  RUN_WHATIF:            'run_whatif',
  REQUEST_PLAN_APPROVAL: 'request_plan_approval',
  APPROVE_PLAN:          'approve_plan',
  DELETE_RUN:            'delete_run',

  // Forecast Studio
  RUN_FORECAST:          'run_forecast',
  EDIT_FORECAST_SETTINGS:'edit_forecast_settings',

  // Risk Center
  RUN_RISK_WORKFLOW:     'run_risk_workflow',
  APPROVE_RISK_TRIGGER:  'approve_risk_trigger',
  SET_CLOSED_LOOP_MODE:  'set_closed_loop_mode',

  // Data
  UPLOAD_DATA:           'upload_data',
  MANAGE_MASTER_DATA:    'manage_master_data',

  // Admin
  MANAGE_USERS:          'manage_users',
  VIEW_SETTINGS:         'view_settings',
  MANAGE_LOGIC_CONTROL:  'manage_logic_control',
};

// ── Role → allowed actions mapping (keep in sync with backend rbac.py) ────

const ROLE_PERMISSIONS = {
  viewer: new Set([
    // viewer: read-only, no action permissions
  ]),
  analyst: new Set([
    ACTIONS.RUN_FORECAST,
    ACTIONS.RUN_WHATIF,
  ]),
  planner: new Set([
    ACTIONS.RUN_FORECAST,
    ACTIONS.RUN_PLAN,
    ACTIONS.RUN_WHATIF,
    ACTIONS.REQUEST_PLAN_APPROVAL,
    ACTIONS.RUN_RISK_WORKFLOW,
    ACTIONS.UPLOAD_DATA,
    ACTIONS.EDIT_FORECAST_SETTINGS,
    ACTIONS.MANAGE_MASTER_DATA,
  ]),
  approver: new Set([
    ACTIONS.RUN_FORECAST,
    ACTIONS.RUN_PLAN,
    ACTIONS.RUN_WHATIF,
    ACTIONS.REQUEST_PLAN_APPROVAL,
    ACTIONS.APPROVE_PLAN,
    ACTIONS.RUN_RISK_WORKFLOW,
    ACTIONS.APPROVE_RISK_TRIGGER,
    ACTIONS.SET_CLOSED_LOOP_MODE,
    ACTIONS.UPLOAD_DATA,
    ACTIONS.EDIT_FORECAST_SETTINGS,
    ACTIONS.MANAGE_LOGIC_CONTROL,
    ACTIONS.MANAGE_MASTER_DATA,
  ]),
  admin: new Set(Object.values(ACTIONS)),  // admin gets all permissions
};

const ROLE_ALIASES = {
  logic_editor: 'planner',
  logic_approver: 'approver',
  logic_publisher: 'approver',
};

function normalizeRole(rawRole) {
  const role = String(rawRole || '').trim().toLowerCase();
  if (ROLE_PERMISSIONS[role]) return role;
  return ROLE_ALIASES[role] || 'viewer';
}

// ── Context ──────────────────────────────────────────────────────────────────

const PermissionsContext = createContext(null);

export function PermissionsProvider({ userId, children }) {
  const [state, setState] = useState({
    role: 'viewer',
    orgId: null,
    plantScope: null,     // null = all plants, string[] = restricted
    datasetScope: null,   // null = all, number[] = restricted
    isLoaded: false,
    error: null,
  });

  useEffect(() => {
    if (!userId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- bail-out guard prevents cascading renders
      setState((prev) => {
        const next = { ...prev, ...buildViewerState(null) };
        if (prev.role === next.role && prev.isLoaded === next.isLoaded && prev.error === next.error) return prev;
        return next;
      });
      return;
    }

    if (isUserProfilesUnavailable) {
      setState((prev) => {
        const next = buildViewerState(null);
        if (prev.role === next.role && prev.isLoaded === next.isLoaded && prev.error === next.error) return prev;
        return next;
      });
      return;
    }

    let active = true;

    supabase
      .from('user_profiles')
      .select('role, accessible_plants')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          const missingTable = isMissingTableOrSchemaCacheError(error, USER_PROFILES_TABLE);
          if (missingTable) markUserProfilesUnavailable(error);
          setState(buildViewerState(missingTable ? null : error?.message || null));
          return;
        }
        if (!data) {
          setState(buildViewerState(null));
          return;
        }
        const plantScope = Array.isArray(data.accessible_plants)
          ? data.accessible_plants.filter((plant) => plant !== '*')
          : null;
        setState({
          role: normalizeRole(data.role),
          orgId: null,
          plantScope: plantScope && plantScope.length > 0 ? plantScope : null,
          datasetScope: null,
          isLoaded: true,
          error: null,
        });
      });

    return () => { active = false; };
  }, [userId]);

  // ── can(action) ────────────────────────────────────────────────────────────

  const can = useCallback((action) => {
    const permissions = ROLE_PERMISSIONS[state.role] || ROLE_PERMISSIONS.viewer;
    return permissions.has(action);
  }, [state.role]);

  // ── canAccessPlant(plantId) ────────────────────────────────────────────────

  const canAccessPlant = useCallback((plantId) => {
    if (!state.plantScope) return true;          // null = all plants
    return state.plantScope.includes(plantId);
  }, [state.plantScope]);

  // ── canAccessDataset(datasetProfileId) ─────────────────────────────────────

  const canAccessDataset = useCallback((datasetProfileId) => {
    if (!state.datasetScope) return true;         // null = all
    return state.datasetScope.includes(Number(datasetProfileId));
  }, [state.datasetScope]);

  return (
    <PermissionsContext.Provider value={{
      ...state,
      can,
      canAccessPlant,
      canAccessDataset,
    }}>
      {children}
    </PermissionsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- custom hook, not a component
export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used inside PermissionsProvider');
  return ctx;
}
