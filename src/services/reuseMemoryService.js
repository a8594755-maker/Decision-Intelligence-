import { supabase } from './supabaseClient';
import { datasetFingerprintInternals } from '../utils/datasetFingerprint';

const { stableStringify } = datasetFingerprintInternals;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));

const canonicalizeJson = (value) => {
  try {
    return JSON.parse(stableStringify(value || {}));
  } catch {
    return value || {};
  }
};

const normalizeWorkflow = (value) => {
  const normalized = String(value || '').trim();
  return normalized || 'workflow_A_replenishment';
};

const resolveQuality = (previousScore, delta) => {
  const prev = clamp01(previousScore);
  const d = Number(delta);
  if (!Number.isFinite(d)) return prev;
  return clamp01(prev + d);
};

export const reuseMemoryService = {
  async getContractTemplates(userId, workflow = 'workflow_A_replenishment', limit = 40) {
    let query = supabase
      .from('di_contract_templates')
      .select('*')
      .eq('user_id', userId)
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (workflow) {
      query = query.eq('workflow', normalizeWorkflow(workflow));
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getContractTemplateByFingerprint(userId, workflow, fingerprint) {
    const { data, error } = await supabase
      .from('di_contract_templates')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow', normalizeWorkflow(workflow))
      .eq('fingerprint', String(fingerprint || ''))
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async getContractTemplateById(userId, templateId) {
    const { data, error } = await supabase
      .from('di_contract_templates')
      .select('*')
      .eq('user_id', userId)
      .eq('id', templateId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async upsertContractTemplate({
    user_id,
    fingerprint,
    workflow = 'workflow_A_replenishment',
    contract_json = {},
    quality_delta = 0
  }) {
    const normalizedWorkflow = normalizeWorkflow(workflow);
    const canonicalContract = canonicalizeJson(contract_json);
    const now = new Date().toISOString();

    const existing = await this.getContractTemplateByFingerprint(user_id, normalizedWorkflow, fingerprint);
    if (existing) {
      const { data, error } = await supabase
        .from('di_contract_templates')
        .update({
          contract_json: canonicalContract,
          usage_count: Number(existing.usage_count || 0) + 1,
          quality_score: resolveQuality(existing.quality_score, quality_delta),
          last_used_at: now
        })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    }

    const { data, error } = await supabase
      .from('di_contract_templates')
      .insert([{
        user_id,
        fingerprint: String(fingerprint || ''),
        workflow: normalizedWorkflow,
        contract_json: canonicalContract,
        quality_score: resolveQuality(0, quality_delta),
        usage_count: 1,
        last_used_at: now
      }])
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async getRunSettingsTemplates(userId, workflow = 'workflow_A_replenishment', limit = 40) {
    let query = supabase
      .from('di_run_settings_templates')
      .select('*')
      .eq('user_id', userId)
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (workflow) {
      query = query.eq('workflow', normalizeWorkflow(workflow));
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getRunSettingsTemplateByFingerprint(userId, workflow, fingerprint) {
    const { data, error } = await supabase
      .from('di_run_settings_templates')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow', normalizeWorkflow(workflow))
      .eq('fingerprint', String(fingerprint || ''))
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async getRunSettingsTemplateById(userId, templateId) {
    const { data, error } = await supabase
      .from('di_run_settings_templates')
      .select('*')
      .eq('user_id', userId)
      .eq('id', templateId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async upsertRunSettingsTemplate({
    user_id,
    fingerprint,
    workflow = 'workflow_A_replenishment',
    settings_json = {},
    quality_delta = 0
  }) {
    const normalizedWorkflow = normalizeWorkflow(workflow);
    const canonicalSettings = canonicalizeJson(settings_json);
    const now = new Date().toISOString();

    const existing = await this.getRunSettingsTemplateByFingerprint(user_id, normalizedWorkflow, fingerprint);
    if (existing) {
      const { data, error } = await supabase
        .from('di_run_settings_templates')
        .update({
          settings_json: canonicalSettings,
          usage_count: Number(existing.usage_count || 0) + 1,
          quality_score: resolveQuality(existing.quality_score, quality_delta),
          last_used_at: now
        })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    }

    const { data, error } = await supabase
      .from('di_run_settings_templates')
      .insert([{
        user_id,
        fingerprint: String(fingerprint || ''),
        workflow: normalizedWorkflow,
        settings_json: canonicalSettings,
        quality_score: resolveQuality(0, quality_delta),
        usage_count: 1,
        last_used_at: now
      }])
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async upsertDatasetSimilarityIndex({
    user_id,
    dataset_profile_id,
    fingerprint,
    signature_json
  }) {
    const payload = {
      user_id,
      dataset_profile_id,
      fingerprint: String(fingerprint || ''),
      signature_json: canonicalizeJson(signature_json || {})
    };

    const { data, error } = await supabase
      .from('di_dataset_similarity_index')
      .upsert([payload], { onConflict: 'user_id,dataset_profile_id' })
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async getRecentSimilarityIndex(userId, limit = 80) {
    const { data, error } = await supabase
      .from('di_dataset_similarity_index')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }
};

export default reuseMemoryService;
