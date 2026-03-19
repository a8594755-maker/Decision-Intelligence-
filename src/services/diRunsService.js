import { supabase } from './supabaseClient';

// ── In-memory fallback store (survives Supabase failures) ────────────────────
let _localIdCounter = 1000;
const _localRuns = new Map();       // run_id → run object
const _localSteps = new Map();      // run_id → Map<step, step object>
const _localArtifacts = new Map();  // run_id → artifact[]

const LOCAL_MAP_MAX_SIZE = 100;

/** Evict the oldest entry (first key) if map exceeds max size. */
function _evictIfFull(map) {
  while (map.size > LOCAL_MAP_MAX_SIZE) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

/** Set a key on a capped map, evicting oldest if full. */
function _cappedSet(map, key, value) {
  map.set(key, value);
  _evictIfFull(map);
}

function nextLocalId() {
  return `local-run-${++_localIdCounter}-${Date.now()}`;
}

function isLocalId(id) {
  return typeof id === 'string' && id.startsWith('local-');
}

function warnFallback(method, err) {
  console.warn(`[diRunsService] ${method} Supabase failed, using local fallback:`, err?.message || err);
}

export const diRunsService = {
  async createRun({ user_id, dataset_profile_id, workflow, stage }) {
    const payload = {
      user_id,
      dataset_profile_id,
      workflow,
      stage,
      status: 'queued'
    };

    // If profile ID is local, skip Supabase (bigint column rejects string IDs)
    if (isLocalId(dataset_profile_id)) {
      const localRun = {
        ...payload,
        id: nextLocalId(),
        created_at: new Date().toISOString(),
        started_at: null, finished_at: null, error: null,
        _local: true
      };
      _cappedSet(_localRuns,localRun.id, localRun);
      return localRun;
    }

    try {
      const { data, error } = await supabase
        .from('di_runs')
        .insert([payload])
        .select('*')
        .single();

      if (error) throw error;
      _cappedSet(_localRuns,data.id, data);
      return data;
    } catch (err) {
      warnFallback('createRun', err);
      const localRun = {
        ...payload,
        id: nextLocalId(),
        created_at: new Date().toISOString(),
        started_at: null, finished_at: null, error: null,
        _local: true
      };
      _cappedSet(_localRuns,localRun.id, localRun);
      return localRun;
    }
  },

  async updateRunStatus({ run_id, status, stage, started_at, finished_at, error: runError }) {
    const updates = { status };
    if (stage !== undefined) updates.stage = stage;
    if (started_at !== undefined) updates.started_at = started_at;
    if (finished_at !== undefined) updates.finished_at = finished_at;
    if (runError !== undefined) updates.error = runError;

    if (isLocalId(run_id)) {
      const existing = _localRuns.get(run_id) || { id: run_id };
      const updated = { ...existing, ...updates };
      _cappedSet(_localRuns,run_id, updated);
      return updated;
    }

    try {
      const { data, error } = await supabase
        .from('di_runs')
        .update(updates)
        .eq('id', run_id)
        .select('*')
        .single();

      if (error) throw error;
      _cappedSet(_localRuns,data.id, data);
      return data;
    } catch (err) {
      warnFallback('updateRunStatus', err);
      const existing = _localRuns.get(run_id) || { id: run_id };
      const updated = { ...existing, ...updates };
      _cappedSet(_localRuns,run_id, updated);
      return updated;
    }
  },

  async saveArtifact({ run_id, artifact_type, artifact_json }) {
    if (isLocalId(run_id)) {
      const localArtifact = {
        id: `local-art-${++_localIdCounter}`,
        run_id,
        artifact_type,
        artifact_json,
        created_at: new Date().toISOString(),
        _local: true
      };
      if (!_localArtifacts.has(run_id)) _cappedSet(_localArtifacts, run_id,[]);
      _localArtifacts.get(run_id).push(localArtifact);
      return localArtifact;
    }

    try {
      const { data, error } = await supabase
        .from('di_run_artifacts')
        .insert([{ run_id, artifact_type, artifact_json }])
        .select('*')
        .single();

      if (error) throw error;
      if (!_localArtifacts.has(run_id)) _cappedSet(_localArtifacts, run_id,[]);
      _localArtifacts.get(run_id).push(data);
      return data;
    } catch (err) {
      warnFallback('saveArtifact', err);
      const localArtifact = {
        id: `local-art-${++_localIdCounter}`,
        run_id,
        artifact_type,
        artifact_json,
        created_at: new Date().toISOString(),
        _local: true
      };
      if (!_localArtifacts.has(run_id)) _cappedSet(_localArtifacts, run_id,[]);
      _localArtifacts.get(run_id).push(localArtifact);
      return localArtifact;
    }
  },

  async getLatestRuns(user_id, limit = 10) {
    try {
      const { data, error } = await supabase
        .from('di_runs')
        .select('*')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (err) {
      warnFallback('getLatestRuns', err);
      return Array.from(_localRuns.values())
        .filter((r) => r.user_id === user_id)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, limit);
    }
  },

  async getRunById(user_id, run_id) {
    if (isLocalId(run_id)) {
      const local = _localRuns.get(run_id);
      return (local && local.user_id === user_id) ? local : null;
    }

    try {
      const { data, error } = await supabase
        .from('di_runs')
        .select('*')
        .eq('user_id', user_id)
        .eq('id', run_id)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    } catch (err) {
      warnFallback('getRunById', err);
      const local = _localRuns.get(run_id);
      return (local && local.user_id === user_id) ? local : null;
    }
  },

  async getLatestRunByStage(user_id, { stage, status = null, dataset_profile_id = null, workflow = null, limit = 20 } = {}) {
    if (!stage) throw new Error('stage is required');

    try {
      let query = supabase
        .from('di_runs')
        .select('*')
        .eq('user_id', user_id)
        .eq('stage', stage)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);
      if (dataset_profile_id !== null && dataset_profile_id !== undefined) query = query.eq('dataset_profile_id', dataset_profile_id);
      if (workflow !== null && workflow !== undefined) query = query.eq('workflow', workflow);

      const { data, error } = await query;
      if (error) throw error;
      return (data && data.length > 0) ? data[0] : null;
    } catch (err) {
      warnFallback('getLatestRunByStage', err);
      return null; // No cached history available offline
    }
  },

  async getLatestRunByStageForDatasetProfiles(
    user_id,
    { stage, status = null, dataset_profile_ids = [], limit = 50 } = {}
  ) {
    if (!stage) throw new Error('stage is required');
    const ids = (Array.isArray(dataset_profile_ids) ? dataset_profile_ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) return null;

    try {
      let query = supabase
        .from('di_runs')
        .select('*')
        .eq('user_id', user_id)
        .eq('stage', stage)
        .in('dataset_profile_id', ids)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;
      return (data && data.length > 0) ? data[0] : null;
    } catch (err) {
      warnFallback('getLatestRunByStageForDatasetProfiles', err);
      return null;
    }
  },

  async getRecentRunsForDatasetProfiles(
    user_id,
    { dataset_profile_ids = [], status = null, workflow = null, limit = 50 } = {}
  ) {
    const ids = (Array.isArray(dataset_profile_ids) ? dataset_profile_ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) return [];

    try {
      let query = supabase
        .from('di_runs')
        .select('*')
        .eq('user_id', user_id)
        .in('dataset_profile_id', ids)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);
      if (workflow) query = query.eq('workflow', workflow);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (err) {
      warnFallback('getRecentRunsForDatasetProfiles', err);
      return [];
    }
  },

  async getRun(run_id) {
    if (isLocalId(run_id)) {
      return _localRuns.get(run_id) || null;
    }

    try {
      const { data, error } = await supabase
        .from('di_runs')
        .select('*')
        .eq('id', run_id)
        .maybeSingle();

      if (error) throw error;
      if (data) _cappedSet(_localRuns,data.id, data);
      return data || _localRuns.get(run_id) || null;
    } catch (err) {
      warnFallback('getRun', err);
      return _localRuns.get(run_id) || null;
    }
  },

  async getArtifactsForRun(run_id) {
    if (isLocalId(run_id)) {
      return _localArtifacts.get(run_id) || [];
    }

    try {
      const { data, error } = await supabase
        .from('di_run_artifacts')
        .select('*')
        .eq('run_id', run_id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      if (data?.length > 0) _cappedSet(_localArtifacts, run_id,data);
      return data || _localArtifacts.get(run_id) || [];
    } catch (err) {
      warnFallback('getArtifactsForRun', err);
      return _localArtifacts.get(run_id) || [];
    }
  },

  async getArtifactById(artifact_id) {
    if (isLocalId(artifact_id)) {
      for (const arts of _localArtifacts.values()) {
        const found = arts.find((a) => a.id === artifact_id);
        if (found) return found;
      }
      return null;
    }

    try {
      const { data, error } = await supabase
        .from('di_run_artifacts')
        .select('*')
        .eq('id', artifact_id)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    } catch (err) {
      warnFallback('getArtifactById', err);
      for (const arts of _localArtifacts.values()) {
        const found = arts.find((a) => a.id === artifact_id);
        if (found) return found;
      }
      return null;
    }
  },

  async createRunSteps(run_id, steps = []) {
    const rows = (Array.isArray(steps) ? steps : [])
      .map((step) => String(step || '').trim())
      .filter(Boolean)
      .map((step) => ({
        run_id,
        step,
        status: 'queued'
      }));

    if (rows.length === 0) return [];

    if (isLocalId(run_id)) {
      const localStepResults = rows.map((r, i) => ({
        ...r,
        id: `local-step-${++_localIdCounter}-${i}`,
        created_at: new Date().toISOString(),
        started_at: null, finished_at: null,
        error_code: null, error_message: null,
        input_ref: null, output_ref: null,
        _local: true
      }));
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      const stepMap = _localSteps.get(run_id);
      localStepResults.forEach((s) => stepMap.set(s.step, s));
      return localStepResults;
    }

    try {
      const { data, error } = await supabase
        .from('di_run_steps')
        .upsert(rows, { onConflict: 'run_id,step' })
        .select('*');

      if (error) throw error;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      const stepMap = _localSteps.get(run_id);
      (data || []).forEach((s) => stepMap.set(s.step, s));
      return data || [];
    } catch (err) {
      warnFallback('createRunSteps', err);
      const localStepResults = rows.map((r, i) => ({
        ...r,
        id: `local-step-${++_localIdCounter}-${i}`,
        created_at: new Date().toISOString(),
        started_at: null, finished_at: null,
        error_code: null, error_message: null,
        input_ref: null, output_ref: null,
        _local: true
      }));
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      const stepMap = _localSteps.get(run_id);
      localStepResults.forEach((s) => stepMap.set(s.step, s));
      return localStepResults;
    }
  },

  async getRunSteps(run_id) {
    if (isLocalId(run_id)) {
      const stepMap = _localSteps.get(run_id);
      return stepMap ? Array.from(stepMap.values()) : [];
    }

    try {
      const { data, error } = await supabase
        .from('di_run_steps')
        .select('*')
        .eq('run_id', run_id)
        .order('id', { ascending: true });

      if (error) throw error;
      if (data?.length > 0) {
        if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
        const stepMap = _localSteps.get(run_id);
        data.forEach((s) => stepMap.set(s.step, s));
      }
      return data || [];
    } catch (err) {
      warnFallback('getRunSteps', err);
      const stepMap = _localSteps.get(run_id);
      return stepMap ? Array.from(stepMap.values()) : [];
    }
  },

  async upsertRunStep({
    run_id,
    step,
    status = 'queued',
    started_at,
    finished_at,
    error_code = null,
    error_message = null,
    input_ref = null,
    output_ref = null
  }) {
    const payload = {
      run_id,
      step,
      status,
      started_at: started_at === undefined ? null : started_at,
      finished_at: finished_at === undefined ? null : finished_at,
      error_code,
      error_message,
      input_ref,
      output_ref
    };

    if (isLocalId(run_id)) {
      const existing = _localSteps.get(run_id)?.get(step) || {};
      const merged = { ...existing, ...payload, _local: true };
      if (!merged.id) merged.id = `local-step-${++_localIdCounter}`;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      _localSteps.get(run_id).set(step, merged);
      return merged;
    }

    try {
      const { data, error } = await supabase
        .from('di_run_steps')
        .upsert([payload], { onConflict: 'run_id,step' })
        .select('*')
        .single();

      if (error) throw error;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      _localSteps.get(run_id).set(step, data);
      return data;
    } catch (err) {
      warnFallback('upsertRunStep', err);
      const existing = _localSteps.get(run_id)?.get(step) || {};
      const merged = { ...existing, ...payload, _local: true };
      if (!merged.id) merged.id = `local-step-${++_localIdCounter}`;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      _localSteps.get(run_id).set(step, merged);
      return merged;
    }
  },

  async updateRunStep({
    run_id,
    step,
    status,
    started_at,
    finished_at,
    error_code,
    error_message,
    input_ref,
    output_ref
  }) {
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (started_at !== undefined) updates.started_at = started_at;
    if (finished_at !== undefined) updates.finished_at = finished_at;
    if (error_code !== undefined) updates.error_code = error_code;
    if (error_message !== undefined) updates.error_message = error_message;
    if (input_ref !== undefined) updates.input_ref = input_ref;
    if (output_ref !== undefined) updates.output_ref = output_ref;

    if (isLocalId(run_id)) {
      const existing = _localSteps.get(run_id)?.get(step) || { run_id, step };
      const merged = { ...existing, ...updates, _local: true };
      if (!merged.id) merged.id = `local-step-${++_localIdCounter}`;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      _localSteps.get(run_id).set(step, merged);
      return merged;
    }

    try {
      const { data, error } = await supabase
        .from('di_run_steps')
        .update(updates)
        .eq('run_id', run_id)
        .eq('step', step)
        .select('*')
        .single();

      if (error) throw error;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      _localSteps.get(run_id).set(step, data);
      return data;
    } catch (err) {
      warnFallback('updateRunStep', err);
      const existing = _localSteps.get(run_id)?.get(step) || { run_id, step };
      const merged = { ...existing, ...updates, _local: true };
      if (!merged.id) merged.id = `local-step-${++_localIdCounter}`;
      if (!_localSteps.has(run_id)) _cappedSet(_localSteps, run_id, new Map());
      _localSteps.get(run_id).set(step, merged);
      return merged;
    }
  },

  async getRunSnapshot(run_id) {
    const [run, steps, artifacts] = await Promise.all([
      this.getRun(run_id),
      this.getRunSteps(run_id),
      this.getArtifactsForRun(run_id)
    ]);

    return { run, steps, artifacts };
  }
};

export default diRunsService;
