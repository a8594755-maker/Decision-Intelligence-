/**
 * Exemplar Service
 *
 * Manages approved output examples (exemplars) that the Digital Worker
 * uses as few-shot references when generating new outputs.
 *
 * Exemplars can come from:
 *   - Manual upload (manager uploads a "good" report)
 *   - Task output promotion (a completed task output gets marked as exemplar)
 *   - Batch ingestion (bulk upload of historical reports)
 *
 * Each exemplar stores:
 *   - Full style fingerprint (same as styleExtractionService output)
 *   - Skeleton (structure without data — for few-shot injection)
 */
import { supabase } from '../../supabaseClient.js';
import { extractStyleFromExcel } from './styleExtractionService.js';

const TABLE = 'style_exemplars';

// ─── Create / Upload ─────────────────────────────────────────

/**
 * Create an exemplar from an uploaded Excel file.
 * Extracts style fingerprint and skeleton automatically.
 */
export async function createExemplarFromFile({ employeeId, teamId, docType, title, description, filename, fileBuffer, approvedBy }) {
  // Extract style fingerprint
  const fingerprint = extractStyleFromExcel(fileBuffer, filename);

  // Build skeleton (structure without actual data values)
  const skeleton = buildSkeleton(fingerprint);

  const row = {
    employee_id: employeeId,
    team_id: teamId || null,
    doc_type: docType,
    source_type: 'upload',
    title: title || filename,
    description: description || '',
    source_file: filename,
    structure_fingerprint: fingerprint.structure,
    formatting_fingerprint: fingerprint.formatting,
    charts_fingerprint: fingerprint.charts,
    kpi_layout_fingerprint: fingerprint.kpi_layout,
    text_style_fingerprint: fingerprint.text_style || {},
    skeleton,
    approved_by: approvedBy || null,
    approved_at: approvedBy ? new Date().toISOString() : null,
    quality_score: approvedBy ? 0.80 : 0.50,
  };

  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) throw new Error(`createExemplarFromFile failed: ${error.message}`);
  return data;
}

/**
 * Promote a task output to an exemplar.
 */
export async function promoteTaskOutput({ employeeId, teamId, docType, taskId, title, description, fingerprint, approvedBy }) {
  const skeleton = buildSkeleton(fingerprint);

  const row = {
    employee_id: employeeId,
    team_id: teamId || null,
    doc_type: docType,
    source_type: 'task_output',
    title,
    description: description || '',
    source_task_id: taskId,
    structure_fingerprint: fingerprint.structure || {},
    formatting_fingerprint: fingerprint.formatting || {},
    charts_fingerprint: fingerprint.charts || {},
    kpi_layout_fingerprint: fingerprint.kpi_layout || {},
    text_style_fingerprint: fingerprint.text_style || {},
    skeleton,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    quality_score: 0.85, // promoted outputs start higher
  };

  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) throw new Error(`promoteTaskOutput failed: ${error.message}`);
  return data;
}

/**
 * Manually create an exemplar with pre-extracted fingerprint.
 */
export async function createExemplar({ employeeId, teamId, docType, title, description, fingerprint, skeleton, approvedBy }) {
  const row = {
    employee_id: employeeId,
    team_id: teamId || null,
    doc_type: docType,
    source_type: 'manual',
    title,
    description: description || '',
    structure_fingerprint: fingerprint?.structure || {},
    formatting_fingerprint: fingerprint?.formatting || {},
    charts_fingerprint: fingerprint?.charts || {},
    kpi_layout_fingerprint: fingerprint?.kpi_layout || {},
    text_style_fingerprint: fingerprint?.text_style || {},
    skeleton: skeleton || {},
    approved_by: approvedBy || null,
    approved_at: approvedBy ? new Date().toISOString() : null,
  };

  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) throw new Error(`createExemplar failed: ${error.message}`);
  return data;
}

// ─── Retrieval ───────────────────────────────────────────────

/**
 * Get the best exemplars for a given doc type, sorted by quality.
 * @param {string} employeeId
 * @param {string} docType
 * @param {object} [opts]
 * @param {number} [opts.limit=3] - max exemplars to return
 * @param {string} [opts.teamId]
 * @returns {Array<Exemplar>}
 */
export async function getBestExemplars(employeeId, docType, { limit = 3, teamId } = {}) {
  let query = supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .eq('doc_type', docType)
    .not('approved_by', 'is', null)  // only approved exemplars
    .order('quality_score', { ascending: false })
    .order('usage_count', { ascending: false })
    .limit(limit);

  if (teamId) query = query.eq('team_id', teamId);

  const { data, error } = await query;
  if (error) throw new Error(`getBestExemplars failed: ${error.message}`);
  return data || [];
}

/**
 * Get all exemplars for an employee.
 */
export async function listExemplars(employeeId, { docType, limit = 50 } = {}) {
  let query = supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .order('quality_score', { ascending: false })
    .limit(limit);

  if (docType) query = query.eq('doc_type', docType);

  const { data, error } = await query;
  if (error) throw new Error(`listExemplars failed: ${error.message}`);
  return data || [];
}

/**
 * Record that an exemplar was used in generation.
 */
export async function recordUsage(exemplarId) {
  const { error } = await supabase.rpc('increment_exemplar_usage', { exemplar_id: exemplarId });
  if (error) {
    // Fallback: read current value then increment
    const { data: current } = await supabase.from(TABLE).select('usage_count').eq('id', exemplarId).single();
    if (current) {
      await supabase.from(TABLE).update({ usage_count: (current.usage_count || 0) + 1 }).eq('id', exemplarId);
    }
  }
  // Best-effort — ignore remaining errors
}

/**
 * Update quality score (e.g. after manager feedback).
 */
export async function updateQualityScore(exemplarId, delta) {
  const { data: current } = await supabase.from(TABLE).select('quality_score').eq('id', exemplarId).single();
  if (!current) return;

  const newScore = Math.max(0, Math.min(1, (current.quality_score || 0.5) + delta));
  const { data, error } = await supabase
    .from(TABLE)
    .update({ quality_score: newScore })
    .eq('id', exemplarId)
    .select()
    .single();
  if (error) throw new Error(`updateQualityScore failed: ${error.message}`);
  return data;
}

/**
 * Approve an exemplar.
 */
export async function approveExemplar(exemplarId, userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ approved_by: userId, approved_at: new Date().toISOString(), quality_score: 0.80 })
    .eq('id', exemplarId)
    .select()
    .single();
  if (error) throw new Error(`approveExemplar failed: ${error.message}`);
  return data;
}

/**
 * Delete an exemplar.
 */
export async function deleteExemplar(exemplarId) {
  const { error } = await supabase.from(TABLE).delete().eq('id', exemplarId);
  if (error) throw new Error(`deleteExemplar failed: ${error.message}`);
}

// ─── Skeleton Builder ────────────────────────────────────────

/**
 * Build a skeleton from a style fingerprint.
 * The skeleton captures structure (sheet names, headers, layout) without data.
 * Used for few-shot context injection.
 */
function buildSkeleton(fingerprint) {
  return {
    sheet_layout: (fingerprint.structure?.sheet_names || []).map(name => ({
      name,
      row_count: fingerprint.structure?.sheet_row_counts?.[name] || 0,
    })),
    kpi_keywords: fingerprint.kpi_layout?.kpi_keywords_found || [],
    formatting_hints: {
      header_bg: fingerprint.formatting?.header_bg_color,
      number_formats: fingerprint.formatting?.number_formats?.slice(0, 3),
      has_alternating_rows: fingerprint.formatting?.has_alternating_rows,
      has_freeze_panes: fingerprint.formatting?.has_freeze_panes,
    },
    text_hints: {
      language: fingerprint.text_style?.language,
      tone: fingerprint.text_style?.tone,
      sample_phrases: fingerprint.text_style?.sample_phrases?.slice(0, 3),
    },
  };
}

/**
 * Build a concise exemplar summary for LLM context injection.
 * @param {Array<Exemplar>} exemplars
 * @returns {string}
 */
export function buildExemplarSummary(exemplars) {
  if (!exemplars.length) return '';

  const lines = ['=== Approved Exemplars (reference style) ==='];
  for (const ex of exemplars) {
    lines.push(`\n### ${ex.title} (quality: ${ex.quality_score})`);
    if (ex.description) lines.push(ex.description);

    const sk = ex.skeleton || {};
    if (sk.sheet_layout?.length) {
      lines.push(`Sheets: ${sk.sheet_layout.map(s => s.name).join(', ')}`);
    }
    if (sk.kpi_keywords?.length) {
      lines.push(`KPIs: ${sk.kpi_keywords.join(', ')}`);
    }
    if (sk.text_hints?.sample_phrases?.length) {
      lines.push(`Style phrases: "${sk.text_hints.sample_phrases.join('", "')}"`);
    }
    if (sk.formatting_hints?.header_bg) {
      lines.push(`Header color: ${sk.formatting_hints.header_bg}`);
    }
  }

  return lines.join('\n');
}

export const _testExports = { buildSkeleton };
