import { supabase } from './supabaseClient';

export const diRunsService = {
  async createRun({ user_id, dataset_profile_id, workflow, stage }) {
    const payload = {
      user_id,
      dataset_profile_id,
      workflow,
      stage,
      status: 'queued'
    };

    const { data, error } = await supabase
      .from('di_runs')
      .insert([payload])
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async updateRunStatus({ run_id, status, stage, started_at, finished_at, error: runError }) {
    const updates = { status };
    if (stage !== undefined) updates.stage = stage;
    if (started_at !== undefined) updates.started_at = started_at;
    if (finished_at !== undefined) updates.finished_at = finished_at;
    if (runError !== undefined) updates.error = runError;

    const { data, error } = await supabase
      .from('di_runs')
      .update(updates)
      .eq('id', run_id)
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async saveArtifact({ run_id, artifact_type, artifact_json }) {
    const { data, error } = await supabase
      .from('di_run_artifacts')
      .insert([{ run_id, artifact_type, artifact_json }])
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async getLatestRuns(user_id, limit = 10) {
    const { data, error } = await supabase
      .from('di_runs')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  },

  async getRunById(user_id, run_id) {
    const { data, error } = await supabase
      .from('di_runs')
      .select('*')
      .eq('user_id', user_id)
      .eq('id', run_id)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async getLatestRunByStage(user_id, { stage, status = null, dataset_profile_id = null, limit = 20 } = {}) {
    if (!stage) throw new Error('stage is required');

    let query = supabase
      .from('di_runs')
      .select('*')
      .eq('user_id', user_id)
      .eq('stage', stage)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    if (dataset_profile_id !== null && dataset_profile_id !== undefined) {
      query = query.eq('dataset_profile_id', dataset_profile_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data && data.length > 0) ? data[0] : null;
  },

  async getLatestRunByStageForDatasetProfiles(
    user_id,
    {
      stage,
      status = null,
      dataset_profile_ids = [],
      limit = 50
    } = {}
  ) {
    if (!stage) throw new Error('stage is required');
    const ids = (Array.isArray(dataset_profile_ids) ? dataset_profile_ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) return null;

    let query = supabase
      .from('di_runs')
      .select('*')
      .eq('user_id', user_id)
      .eq('stage', stage)
      .in('dataset_profile_id', ids)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data && data.length > 0) ? data[0] : null;
  },

  async getRun(run_id) {
    const { data, error } = await supabase
      .from('di_runs')
      .select('*')
      .eq('id', run_id)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async getArtifactsForRun(run_id) {
    const { data, error } = await supabase
      .from('di_run_artifacts')
      .select('*')
      .eq('run_id', run_id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  async getArtifactById(artifact_id) {
    const { data, error } = await supabase
      .from('di_run_artifacts')
      .select('*')
      .eq('id', artifact_id)
      .maybeSingle();

    if (error) throw error;
    return data || null;
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

    const { data, error } = await supabase
      .from('di_run_steps')
      .upsert(rows, { onConflict: 'run_id,step' })
      .select('*');

    if (error) throw error;
    return data || [];
  },

  async getRunSteps(run_id) {
    const { data, error } = await supabase
      .from('di_run_steps')
      .select('*')
      .eq('run_id', run_id)
      .order('id', { ascending: true });

    if (error) throw error;
    return data || [];
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

    const { data, error } = await supabase
      .from('di_run_steps')
      .upsert([payload], { onConflict: 'run_id,step' })
      .select('*')
      .single();

    if (error) throw error;
    return data;
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

    const { data, error } = await supabase
      .from('di_run_steps')
      .update(updates)
      .eq('run_id', run_id)
      .eq('step', step)
      .select('*')
      .single();

    if (error) throw error;
    return data;
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
