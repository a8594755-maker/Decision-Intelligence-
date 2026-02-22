/**
 * usePermissions.jsx
 *
 * Frontend RBAC core hook.
 * Fetches current user's role + plant scope from Supabase org_members,
 * provides can(action) method for all UI components.
 *
 * Design principles:
 *   1. Backend RLS is the ultimate security barrier (don't trust frontend hiding)
 *   2. Frontend RBAC is UX optimization (hide buttons users can't use)
 *   3. Role cached in React Context, no repeated queries
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../services/supabaseClient';

const ORG_MEMBERS_TABLE = 'org_members';
let isOrgMembersUnavailable = false;
let hasWarnedOrgMembersUnavailable = false;

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

function markOrgMembersUnavailable(error) {
  isOrgMembersUnavailable = true;
  if (!hasWarnedOrgMembersUnavailable) {
    console.warn(
      '[usePermissions] org_members table unavailable. Run sql/migrations/organizations_schema.sql, then NOTIFY pgrst, \'reload schema\'.',
      error?.message || ''
    );
    hasWarnedOrgMembersUnavailable = true;
  }
}

// ── Action definitions (synced with backend rbac.py) ──────────────────────

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
  ]),
  admin: new Set(Object.values(ACTIONS)),  // admin gets all permissions
};

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
      setState((prev) => ({
        ...prev,
        ...buildViewerState(null),
      }));
      return;
    }

    if (isOrgMembersUnavailable) {
      setState(buildViewerState(null));
      return;
    }

    let active = true;

    supabase
      .from('org_members')
      .select('role, org_id, plant_scope, dataset_scope')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          const missingTable = isMissingTableOrSchemaCacheError(error, ORG_MEMBERS_TABLE);
          if (missingTable) markOrgMembersUnavailable(error);
          // No org_member record → fallback to viewer (safest default)
          setState(buildViewerState(missingTable ? null : error?.message || null));
          return;
        }
        setState({
          role: data.role || 'viewer',
          orgId: data.org_id,
          plantScope: data.plant_scope || null,
          datasetScope: data.dataset_scope || null,
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

export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used inside PermissionsProvider');
  return ctx;
}
