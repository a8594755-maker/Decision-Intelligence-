/**
 * planWritebackService.js
 *
 * Writes approved plan results (orders + inventory targets) back to
 * dedicated Supabase baseline tables. Follows the same graceful-degradation
 * pattern as planAuditService.js — silently no-ops if the tables or RPC
 * have not been deployed yet.
 */

import { supabase, RPC_JSON_OPTIONS } from '../infra/supabaseClient';
import { diRunsService } from './diRunsService';
import { loadArtifact } from '../../utils/artifactStore';

const RPC_NAME = 'write_approved_plan_baseline';
let isWritebackUnavailable = false;
let hasWarned = false;

// ── Error detection (mirrors planAuditService) ────────────────────────────

function isMissingRpcOrTableError(error) {
  if (!error) return false;
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const blob = [error?.message, error?.details, error?.hint, error?.error_description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === '42883' ||          // function does not exist
    status === 404 ||
    blob.includes('does not exist') ||
    blob.includes('could not find') ||
    blob.includes('schema cache')
  );
}

function markUnavailable(error) {
  isWritebackUnavailable = true;
  if (!hasWarned) {
    console.warn(
      '[planWritebackService] RPC/tables unavailable. Run database/di_approved_plan_writeback.sql.',
      error?.message || ''
    );
    hasWarned = true;
  }
}

// ── Main write-back ───────────────────────────────────────────────────────

/**
 * Write an approved plan's orders and inventory targets to baseline tables.
 * Loads plan_table + inventory_projection artifacts, then calls the
 * transactional RPC that atomically supersedes prior baselines.
 *
 * @param {{ userId: string, runId: number, approvalId: string, datasetProfileId?: number }} opts
 * @returns {Promise<object|null>} RPC result or null if unavailable
 */
export async function writeApprovedPlanBaseline({
  userId,
  runId,
  approvalId,
  datasetProfileId = null
}) {
  if (!userId || !runId || !approvalId) {
    throw new Error('userId, runId, and approvalId are required');
  }
  if (isWritebackUnavailable) return null;

  try {
    // 1. Load artifacts for the run
    const artifacts = await diRunsService.getArtifactsForRun(runId);

    const planArt = artifacts.find((a) => a.artifact_type === 'plan_table');
    const projArt = artifacts.find((a) => a.artifact_type === 'inventory_projection');

    if (!planArt) {
      console.warn(`[planWritebackService] No plan_table artifact for run ${runId}. Skipping.`);
      return null;
    }

    // 2. Resolve full artifact payloads (handles inline vs user_files)
    const planPayload = planArt.artifact_json?.storage === 'user_files'
      ? await loadArtifact({ artifact_id: planArt.id, storage: 'user_files', file_id: planArt.artifact_json.file_id })
      : planArt.artifact_json;

    const projPayload = projArt
      ? (projArt.artifact_json?.storage === 'user_files'
        ? await loadArtifact({ artifact_id: projArt.id, storage: 'user_files', file_id: projArt.artifact_json.file_id })
        : projArt.artifact_json)
      : null;

    const planOrders = planPayload?.rows || [];
    const inventoryTargets = projPayload?.rows || [];

    if (planOrders.length === 0) {
      console.warn(`[planWritebackService] plan_table has 0 rows for run ${runId}. Skipping.`);
      return null;
    }

    // 3. Resolve dataset_profile_id from run record if not provided
    let profileId = datasetProfileId;
    if (!profileId) {
      const run = await diRunsService.getRun(runId);
      profileId = run?.dataset_profile_id || null;
    }

    // 4. Call transactional RPC
    const { data, error } = await supabase.rpc(RPC_NAME, {
      p_run_id: runId,
      p_approval_id: approvalId,
      p_dataset_profile_id: profileId,
      p_plan_orders: planOrders,
      p_inventory_targets: inventoryTargets
    }, RPC_JSON_OPTIONS);

    if (error) {
      if (isMissingRpcOrTableError(error)) {
        markUnavailable(error);
        return null;
      }
      throw error;
    }

    return data;
  } catch (error) {
    if (isMissingRpcOrTableError(error)) {
      markUnavailable(error);
      return null;
    }
    console.warn('[planWritebackService] writeApprovedPlanBaseline failed:', error.message);
    return null;
  }
}

// ── Query helpers for baseline resolution ─────────────────────────────────

/**
 * Get the latest active approved plan orders for a dataset profile.
 */
export async function getActiveApprovedOrders({ userId, datasetProfileId }) {
  if (!userId || !datasetProfileId || isWritebackUnavailable) return [];

  try {
    const { data, error } = await supabase
      .from('approved_plan_orders')
      .select('*')
      .eq('user_id', userId)
      .eq('dataset_profile_id', datasetProfileId)
      .eq('is_active', true)
      .order('order_date', { ascending: true });

    if (error) {
      if (isMissingRpcOrTableError(error)) { markUnavailable(error); return []; }
      throw error;
    }
    return data || [];
  } catch (error) {
    console.warn('[planWritebackService] getActiveApprovedOrders failed:', error.message);
    return [];
  }
}

/**
 * Get the latest active inventory targets for a dataset profile.
 */
export async function getActiveInventoryTargets({ userId, datasetProfileId }) {
  if (!userId || !datasetProfileId || isWritebackUnavailable) return [];

  try {
    const { data, error } = await supabase
      .from('inventory_targets')
      .select('*')
      .eq('user_id', userId)
      .eq('dataset_profile_id', datasetProfileId)
      .eq('is_active', true)
      .order('target_date', { ascending: true });

    if (error) {
      if (isMissingRpcOrTableError(error)) { markUnavailable(error); return []; }
      throw error;
    }
    return data || [];
  } catch (error) {
    console.warn('[planWritebackService] getActiveInventoryTargets failed:', error.message);
    return [];
  }
}

/**
 * Get the latest approved baseline metadata (run_id, approval_id, approved_at)
 * for a dataset profile. Used by basePlanResolver to prefer approved baselines.
 */
export async function getLatestApprovedBaseline({ userId, datasetProfileId }) {
  if (!userId || !datasetProfileId || isWritebackUnavailable) return null;

  try {
    const { data, error } = await supabase
      .from('approved_plan_orders')
      .select('run_id, approval_id, approved_at, dataset_profile_id')
      .eq('user_id', userId)
      .eq('dataset_profile_id', datasetProfileId)
      .eq('is_active', true)
      .order('approved_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (isMissingRpcOrTableError(error)) { markUnavailable(error); return null; }
      throw error;
    }
    return data || null;
  } catch (error) {
    console.warn('[planWritebackService] getLatestApprovedBaseline failed:', error.message);
    return null;
  }
}
