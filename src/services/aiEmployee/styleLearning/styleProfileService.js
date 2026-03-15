/**
 * Style Profile Service
 *
 * Aggregates multiple style fingerprints into a canonical Style Profile
 * per (employee, team, doc_type). Handles clustering, variance detection,
 * and profile CRUD with Supabase persistence.
 */
import { supabase } from '../../supabaseClient.js';

const TABLE = 'style_profiles';

// ─── Profile Compilation ─────────────────────────────────────

/**
 * Compile a style profile from an array of fingerprints.
 * Takes the mode (most common value) for each dimension.
 * Flags high-variance dimensions.
 *
 * @param {Array<StyleFingerprint>} fingerprints
 * @param {object} meta - { employee_id, team_id, doc_type, profile_name }
 * @returns {StyleProfile}
 */
export function compileProfile(fingerprints, meta) {
  if (!fingerprints.length) {
    return { ...meta, sample_count: 0, confidence: 0, canonical_structure: {}, canonical_formatting: {}, canonical_charts: {}, canonical_kpi_layout: {}, canonical_text_style: {}, high_variance_dims: [] };
  }

  const canonical_structure = aggregateStructure(fingerprints);
  const canonical_formatting = aggregateFormatting(fingerprints);
  const canonical_charts = aggregateCharts(fingerprints);
  const canonical_kpi_layout = aggregateKpiLayout(fingerprints);
  const canonical_text_style = aggregateTextStyle(fingerprints);

  const high_variance_dims = detectHighVariance(fingerprints);
  const confidence = computeConfidence(fingerprints, high_variance_dims);

  return {
    ...meta,
    sample_count: fingerprints.length,
    confidence,
    canonical_structure,
    canonical_formatting,
    canonical_charts,
    canonical_kpi_layout,
    canonical_text_style,
    high_variance_dims,
  };
}

// ─── Aggregation Functions ───────────────────────────────────

function aggregateStructure(fps) {
  const sheetCounts = fps.map(f => f.structure?.sheet_count).filter(Boolean);
  const allNames = fps.flatMap(f => f.structure?.sheet_names || []);

  return {
    typical_sheet_count: median(sheetCounts),
    common_sheet_names: topN(allNames, 10),
    has_cover_sheet: majority(fps.map(f => f.structure?.has_cover_sheet)),
    has_dashboard_sheet: majority(fps.map(f => f.structure?.has_dashboard_sheet)),
    has_data_sheet: majority(fps.map(f => f.structure?.has_data_sheet)),
  };
}

function aggregateFormatting(fps) {
  return {
    header_bg_color: mode(fps.map(f => f.formatting?.header_bg_color).filter(Boolean)),
    header_font_color: mode(fps.map(f => f.formatting?.header_font_color).filter(Boolean)),
    header_font: mode(fps.map(f => f.formatting?.header_font).filter(Boolean)),
    common_number_formats: topN(fps.flatMap(f => f.formatting?.number_formats || []), 5),
    has_alternating_rows: majority(fps.map(f => f.formatting?.has_alternating_rows)),
    has_freeze_panes: majority(fps.map(f => f.formatting?.has_freeze_panes)),
    typical_merge_count: median(fps.map(f => f.formatting?.merge_cell_count || 0)),
  };
}

function aggregateCharts(fps) {
  return {
    typical_chart_sheet_count: median(fps.map(f => f.charts?.chart_sheet_count || 0)),
    common_chart_types: topN(fps.flatMap(f => f.charts?.preferred_types || []), 5),
    common_colors: topN(fps.flatMap(f => f.charts?.color_palette || []), 8),
  };
}

function aggregateKpiLayout(fps) {
  return {
    position: mode(fps.map(f => f.kpi_layout?.position).filter(Boolean)),
    style: mode(fps.map(f => f.kpi_layout?.style).filter(Boolean)),
    common_kpi_keywords: topN(fps.flatMap(f => f.kpi_layout?.kpi_keywords_found || []), 15),
  };
}

function aggregateTextStyle(fps) {
  const styles = fps.map(f => f.text_style).filter(Boolean);
  if (!styles.length) return {};

  return {
    language: mode(styles.map(s => s.language).filter(Boolean)) || 'unknown',
    tone: mode(styles.map(s => s.tone).filter(Boolean)) || 'formal_business',
    bullet_style: mode(styles.map(s => s.bullet_style).filter(Boolean)) || 'none',
    kpi_naming: mode(styles.map(s => s.kpi_naming).filter(Boolean)) || '',
    sample_phrases: topN(styles.flatMap(s => s.sample_phrases || []), 10),
    avg_sentence_length: mode(styles.map(s => s.avg_sentence_length).filter(Boolean)) || 'medium',
    uses_headers: majority(styles.map(s => s.uses_headers)),
  };
}

// ─── Variance Detection ──────────────────────────────────────

function detectHighVariance(fps) {
  const dims = [];

  // Sheet count variance
  const sheetCounts = fps.map(f => f.structure?.sheet_count).filter(Boolean);
  if (coefficientOfVariation(sheetCounts) > 0.3) dims.push('sheet_count');

  // Chart type variance
  const chartTypes = fps.map(f => f.charts?.preferred_types?.[0]).filter(Boolean);
  if (uniqueRatio(chartTypes) > 0.5) dims.push('chart_type');

  // Header color variance
  const headerColors = fps.map(f => f.formatting?.header_bg_color).filter(Boolean);
  if (uniqueRatio(headerColors) > 0.4) dims.push('header_color');

  // Tone variance
  const tones = fps.map(f => f.text_style?.tone).filter(Boolean);
  if (uniqueRatio(tones) > 0.3) dims.push('tone');

  // KPI position variance
  const positions = fps.map(f => f.kpi_layout?.position).filter(Boolean);
  if (uniqueRatio(positions) > 0.4) dims.push('kpi_position');

  return dims;
}

function computeConfidence(fps, highVarianceDims) {
  if (fps.length <= 1) return 0.5;
  // Base confidence from sample size (log scale, caps at ~0.95)
  const sizeScore = Math.min(0.95, 0.5 + Math.log10(fps.length) * 0.25);
  // Penalty for high variance dims
  const variancePenalty = highVarianceDims.length * 0.08;
  return Math.max(0, Math.min(1, sizeScore - variancePenalty));
}

// ─── Persistence ─────────────────────────────────────────────

/**
 * Save or update a compiled style profile.
 */
export async function saveProfile(profile) {
  const row = {
    employee_id: profile.employee_id,
    team_id: profile.team_id || null,
    doc_type: profile.doc_type,
    profile_name: profile.profile_name || `${profile.doc_type}_profile`,
    sample_count: profile.sample_count,
    confidence: profile.confidence,
    canonical_structure: profile.canonical_structure,
    canonical_formatting: profile.canonical_formatting,
    canonical_charts: profile.canonical_charts,
    canonical_kpi_layout: profile.canonical_kpi_layout,
    canonical_text_style: profile.canonical_text_style,
    high_variance_dims: profile.high_variance_dims,
    exemplar_refs: profile.exemplar_refs || [],
  };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'employee_id,team_id,doc_type' })
    .select()
    .single();

  if (error) throw new Error(`saveProfile failed: ${error.message}`);
  return data;
}

/**
 * Get a style profile for a specific doc type.
 */
export async function getProfile(employeeId, docType, teamId = null) {
  let query = supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .eq('doc_type', docType);

  if (teamId) query = query.eq('team_id', teamId);
  else query = query.is('team_id', null);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`getProfile failed: ${error.message}`);
  return data;
}

/**
 * List all profiles for an employee.
 */
export async function listProfiles(employeeId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(`listProfiles failed: ${error.message}`);
  return data || [];
}

/**
 * Delete a profile.
 */
export async function deleteProfile(profileId) {
  const { error } = await supabase.from(TABLE).delete().eq('id', profileId);
  if (error) throw new Error(`deleteProfile failed: ${error.message}`);
}

/**
 * Incrementally update a profile with new fingerprints.
 * Merges new fingerprints into existing profile rather than recomputing from scratch.
 */
export async function updateProfileIncremental(employeeId, docType, newFingerprints, teamId = null) {
  const existing = await getProfile(employeeId, docType, teamId);
  if (!existing) {
    // No existing profile — compile fresh
    const compiled = compileProfile(newFingerprints, { employee_id: employeeId, team_id: teamId, doc_type: docType });
    return saveProfile(compiled);
  }

  // Weighted merge: existing profile counts as N samples, new fingerprints as their count
  // For simplicity, recompile from scratch would need all fingerprints.
  // Incremental: we increase sample_count and blend canonical values.
  const totalSamples = existing.sample_count + newFingerprints.length;
  const newCompiled = compileProfile(newFingerprints, { employee_id: employeeId, team_id: teamId, doc_type: docType });

  // Weighted blend of confidence
  const blendedConfidence = (
    existing.confidence * existing.sample_count +
    newCompiled.confidence * newFingerprints.length
  ) / totalSamples;

  const merged = {
    ...existing,
    sample_count: totalSamples,
    confidence: Math.round(blendedConfidence * 100) / 100,
    // For canonical values, prefer existing if sample count is much larger
    // Otherwise take new values if they have higher consistency
    canonical_structure: existing.sample_count > newFingerprints.length * 3
      ? existing.canonical_structure
      : newCompiled.canonical_structure,
    canonical_formatting: existing.sample_count > newFingerprints.length * 3
      ? existing.canonical_formatting
      : newCompiled.canonical_formatting,
    canonical_charts: mergeJsonb(existing.canonical_charts, newCompiled.canonical_charts),
    canonical_kpi_layout: mergeJsonb(existing.canonical_kpi_layout, newCompiled.canonical_kpi_layout),
    canonical_text_style: mergeJsonb(existing.canonical_text_style, newCompiled.canonical_text_style),
    high_variance_dims: [...new Set([...existing.high_variance_dims, ...newCompiled.high_variance_dims])],
  };

  return saveProfile(merged);
}

// ─── Helpers ─────────────────────────────────────────────────

function mode(arr) {
  if (!arr.length) return null;
  const freq = {};
  for (const v of arr) freq[v] = (freq[v] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

function topN(arr, n) {
  const freq = {};
  for (const v of arr) freq[v] = (freq[v] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([v]) => v);
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function majority(bools) {
  const trueCount = bools.filter(Boolean).length;
  return trueCount > bools.length / 2;
}

function coefficientOfVariation(nums) {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return 0;
  const variance = nums.reduce((sum, v) => sum + (v - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function uniqueRatio(arr) {
  if (!arr.length) return 0;
  return new Set(arr).size / arr.length;
}

function mergeJsonb(existing, incoming) {
  if (!existing || !Object.keys(existing).length) return incoming;
  if (!incoming || !Object.keys(incoming).length) return existing;
  return { ...existing, ...incoming };
}

export const _testExports = { compileProfile, aggregateStructure, aggregateFormatting, detectHighVariance, computeConfidence, mode, median, majority };
