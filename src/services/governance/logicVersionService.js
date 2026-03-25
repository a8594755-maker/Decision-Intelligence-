// ============================================
// Logic Version Service
// Phase 1: Frontend - Data layer for Logic Control Center
// ============================================

import { supabase } from '../infra/supabaseClient';

// Default configuration template
export const DEFAULT_LOGIC_CONFIG = {
  schema_version: '1.0',
  limits: {
    MAX_FG_DEMAND_ROWS: 10000,
    MAX_BOM_EDGES_ROWS: 50000,
    MAX_BOM_DEPTH: 50,
    MAX_TRACE_ROWS_PER_RUN: 500000,
    INSERT_CHUNK_SIZE_DEMAND: 1000,
    INSERT_CHUNK_SIZE_TRACE: 5000,
    ZOMBIE_AFTER_SECONDS: 120,
    MAX_CONCURRENT_JOBS_PER_USER: 3,
  },
  rules: {
    edge_selection: {
      plant_match_strategy: 'exact_first_then_null',
      validity_enforced: true,
      priority_strategy: 'min_priority',
      tie_breaker: 'latest_created_at',
    },
    scrap_yield: {
      default_scrap_rate: 0,
      default_yield_rate: 1,
      min_scrap_rate: 0,
      max_scrap_rate: 0.99,
      min_yield_rate: 0.01,
      max_yield_rate: 1,
    },
    rounding: {
      decimal_places: 4,
    },
    cycle_policy: 'warn_and_cut',
    max_depth_policy: 'fail',
  },
  sharding: {
    strategy: 'none',
    shard_size_weeks: 4,
    merge_policy: 'sum_and_dedupe',
  },
  staging: {
    commit_mode: 'all_or_nothing',
    auto_cleanup_on_fail: true,
  },
};

/**
 * Fetch published logic version for a scope
 */
export async function fetchPublishedLogicVersion(logicId, scopeLevel, scopeId) {
  const { data, error } = await supabase
    .from('logic_versions')
    .select('*')
    .eq('logic_id', logicId)
    .eq('scope_level', scopeLevel)
    .eq('status', 'published')
    .lte('effective_from', new Date().toISOString())
    .or('effective_to.is.null,effective_to.gt.' + new Date().toISOString())
    .order('effective_from', { ascending: false })
    .limit(1);

  if (error) {
    console.error('Error fetching published logic:', error);
    return null;
  }

  if (scopeLevel === 'PLANT' && scopeId) {
    const plantVersion = data?.find(v => v.scope_id === scopeId);
    if (plantVersion) {
      return plantVersion;
    }
    return fetchPublishedLogicVersion(logicId, 'GLOBAL');
  }

  return data?.[0] || null;
}

/**
 * Fetch all logic versions for a logic type
 */
export async function fetchLogicVersions(logicId) {
  const { data, error } = await supabase
    .from('logic_versions')
    .select('*')
    .eq('logic_id', logicId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching logic versions:', error);
    throw error;
  }

  return data || [];
}

/**
 * Fetch draft versions for current user
 */
export async function fetchDraftVersions(logicId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('logic_versions')
    .select('*')
    .eq('logic_id', logicId)
    .eq('status', 'draft')
    .eq('created_by', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching draft versions:', error);
    throw error;
  }

  return data || [];
}

/**
 * Fetch a specific version by ID
 */
export async function fetchLogicVersionById(versionId) {
  const { data, error } = await supabase
    .from('logic_versions')
    .select('*')
    .eq('id', versionId)
    .single();

  if (error) {
    console.error('Error fetching logic version:', error);
    return null;
  }

  return data;
}

/**
 * Create a new draft version
 */
export async function createDraftVersion(logicId, scopeLevel, scopeId, config, baseVersionId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  let initialConfig = config;
  if (baseVersionId) {
    const baseVersion = await fetchLogicVersionById(baseVersionId);
    if (baseVersion) {
      initialConfig = { ...baseVersion.config_json, ...config };
    }
  }

  const { data, error } = await supabase
    .from('logic_versions')
    .insert({
      logic_id: logicId,
      scope_level: scopeLevel,
      scope_id: scopeId,
      status: 'draft',
      effective_from: new Date().toISOString(),
      config_json: initialConfig,
      schema_version: '1.0',
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating draft version:', error);
    throw error;
  }

  return data;
}

/**
 * Update draft version configuration
 */
export async function updateDraftConfig(versionId, config) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const current = await fetchLogicVersionById(versionId);
  if (!current) throw new Error('Version not found');
  if (current.status !== 'draft') throw new Error('Can only edit draft versions');

  const mergedConfig = {
    ...current.config_json,
    ...config,
  };

  const { data, error } = await supabase
    .from('logic_versions')
    .update({
      config_json: mergedConfig,
    })
    .eq('id', versionId)
    .eq('status', 'draft')
    .select()
    .single();

  if (error) {
    console.error('Error updating draft config:', error);
    throw error;
  }

  return data;
}

/**
 * Submit draft for approval
 */
export async function submitDraft(versionId, comment) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('logic_versions')
    .update({
      status: 'pending_approval',
      submitted_by: user.id,
      submitted_at: new Date().toISOString(),
      submit_comment: comment || null,
    })
    .eq('id', versionId)
    .eq('status', 'draft')
    .select()
    .single();

  if (error) {
    console.error('Error submitting draft:', error);
    throw error;
  }

  return data;
}

/**
 * Approve a pending version
 */
export async function approveVersion(versionId, comment) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('logic_versions')
    .update({
      status: 'approved',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      approval_comment: comment || null,
    })
    .eq('id', versionId)
    .eq('status', 'pending_approval')
    .select()
    .single();

  if (error) {
    console.error('Error approving version:', error);
    throw error;
  }

  return data;
}

/**
 * Reject a pending version
 */
export async function rejectVersion(versionId, comment) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('logic_versions')
    .update({
      status: 'draft',
      approved_by: null,
      approved_at: null,
      approval_comment: comment || 'Rejected',
    })
    .eq('id', versionId)
    .eq('status', 'pending_approval')
    .select()
    .single();

  if (error) {
    console.error('Error rejecting version:', error);
    throw error;
  }

  return data;
}

/**
 * Publish an approved version
 */
export async function publishVersion(versionId, effectiveFrom, comment) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const updates = {
    status: 'published',
    published_by: user.id,
    published_at: new Date().toISOString(),
    publish_comment: comment || null,
  };

  if (effectiveFrom) {
    updates.effective_from = effectiveFrom;
  }

  const { data, error } = await supabase
    .from('logic_versions')
    .update(updates)
    .eq('id', versionId)
    .in('status', ['approved', 'draft'])
    .select()
    .single();

  if (error) {
    console.error('Error publishing version:', error);
    throw error;
  }

  return data;
}

/**
 * Rollback to a previous published version
 */
export async function rollbackVersion(logicId, scopeLevel, scopeId, targetVersionId, comment) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  await supabase
    .from('logic_versions')
    .update({
      status: 'archived',
      effective_to: new Date().toISOString(),
    })
    .eq('logic_id', logicId)
    .eq('scope_level', scopeLevel)
    .eq('status', 'published')
    .eq('scope_id', scopeId || null);

  const target = await fetchLogicVersionById(targetVersionId);
  if (!target) throw new Error('Target version not found');

  const { data, error } = await supabase
    .from('logic_versions')
    .insert({
      logic_id: logicId,
      scope_level: scopeLevel,
      scope_id: scopeId,
      status: 'published',
      effective_from: new Date().toISOString(),
      config_json: target.config_json,
      schema_version: target.schema_version,
      created_by: user.id,
      published_by: user.id,
      published_at: new Date().toISOString(),
      publish_comment: `Rollback to version ${targetVersionId}. ${comment || ''}`,
    })
    .select()
    .single();

  if (error) {
    console.error('Error rolling back version:', error);
    throw error;
  }

  return data;
}

/**
 * Fetch change log for a version
 */
export async function fetchChangeLog(versionId) {
  const { data, error } = await supabase
    .from('logic_change_log')
    .select('*')
    .eq('logic_version_id', versionId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching change log:', error);
    throw error;
  }

  return data || [];
}

/**
 * Start a sandbox test run
 */
export async function startSandboxTest(versionId, testParams) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const version = await fetchLogicVersionById(versionId);
  if (!version) throw new Error('Version not found');

  const baseline = await fetchPublishedLogicVersion(
    version.logic_id,
    version.scope_level,
    version.scope_id || undefined
  );

  const { data, error } = await supabase
    .from('logic_test_runs')
    .insert({
      logic_version_id: versionId,
      baseline_logic_version_id: baseline?.id || null,
      user_id: user.id,
      request_params: testParams,
      status: 'pending',
      progress: 0,
    })
    .select()
    .single();

  if (error) {
    console.error('Error starting sandbox test:', error);
    throw error;
  }

  return data;
}

/**
 * Fetch test run by ID
 */
export async function fetchTestRun(testRunId) {
  const { data, error } = await supabase
    .from('logic_test_runs')
    .select('*')
    .eq('id', testRunId)
    .single();

  if (error) {
    console.error('Error fetching test run:', error);
    return null;
  }

  return data;
}

/**
 * Compare two configurations and return differences
 */
export function compareConfigs(baseline, draft) {
  const changes = [];

  function compareObjects(obj1, obj2, path) {
    const keys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);
    
    for (const key of keys) {
      const currentPath = path ? `${path}.${key}` : key;
      const val1 = obj1?.[key];
      const val2 = obj2?.[key];

      if (typeof val1 === 'object' && typeof val2 === 'object' && val1 !== null && val2 !== null) {
        compareObjects(val1, val2, currentPath);
      } else if (val1 !== val2) {
        changes.push({
          path: currentPath,
          before: val1,
          after: val2,
        });
      }
    }
  }

  compareObjects(baseline, draft, '');

  return {
    hasChanges: changes.length > 0,
    changes,
  };
}

/**
 * Get status badge color
 */
export function getStatusColor(status) {
  const colors = {
    draft: 'bg-gray-100 text-gray-800',
    pending_approval: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-blue-100 text-blue-800',
    published: 'bg-green-100 text-green-800',
    archived: 'bg-red-100 text-red-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

/**
 * Get status display text
 */
export function getStatusText(status) {
  const texts = {
    draft: 'Draft',
    pending_approval: 'Pending Approval',
    approved: 'Approved',
    published: 'Published',
    archived: 'Archived',
  };
  return texts[status] || status;
}
