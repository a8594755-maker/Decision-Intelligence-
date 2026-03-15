import { supabase } from '../../supabaseClient.js';

const PROFILE_TABLE = 'company_output_profiles';
const PROPOSAL_TABLE = 'company_output_profile_proposals';

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
}

function firstJson(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }
  return {};
}

function defaultNow() {
  return new Date().toISOString();
}

function applyScope(query, { employeeId, docType, teamId = null }) {
  let scoped = query
    .eq('employee_id', employeeId)
    .eq('doc_type', docType);

  if (teamId) {
    scoped = scoped.eq('team_id', teamId);
  } else {
    scoped = scoped.is('team_id', null);
  }

  return scoped;
}

async function resolveActorUserId(db, actorUserId) {
  if (actorUserId) return actorUserId;
  const { data, error } = await db.auth.getUser();
  if (error) throw error;
  if (!data?.user?.id) throw new Error('Not authenticated');
  return data.user.id;
}

function normalizeCanonical(candidateProfile = {}, defaults = {}) {
  const canonical = candidateProfile.canonical || {};
  const fallbackCanonical = defaults.canonical || {};
  return {
    canonical_structure: firstJson(
      candidateProfile.canonical_structure,
      candidateProfile.canonicalStructure,
      canonical.structure,
      defaults.canonical_structure,
      defaults.canonicalStructure,
      fallbackCanonical.structure
    ),
    canonical_formatting: firstJson(
      candidateProfile.canonical_formatting,
      candidateProfile.canonicalFormatting,
      canonical.formatting,
      defaults.canonical_formatting,
      defaults.canonicalFormatting,
      fallbackCanonical.formatting
    ),
    canonical_charts: firstJson(
      candidateProfile.canonical_charts,
      candidateProfile.canonicalCharts,
      canonical.charts,
      defaults.canonical_charts,
      defaults.canonicalCharts,
      fallbackCanonical.charts
    ),
    canonical_kpi_layout: firstJson(
      candidateProfile.canonical_kpi_layout,
      candidateProfile.canonicalKpiLayout,
      canonical.kpiLayout,
      defaults.canonical_kpi_layout,
      defaults.canonicalKpiLayout,
      fallbackCanonical.kpiLayout
    ),
    canonical_text_style: firstJson(
      candidateProfile.canonical_text_style,
      candidateProfile.canonicalTextStyle,
      canonical.textStyle,
      defaults.canonical_text_style,
      defaults.canonicalTextStyle,
      fallbackCanonical.textStyle
    ),
  };
}

function normalizeCandidateProfile(candidateProfile = {}, defaults = {}) {
  const canonical = normalizeCanonical(candidateProfile, defaults);
  return {
    profile_name: firstDefined(candidateProfile.profile_name, candidateProfile.profileName, defaults.profileName, defaults.docType ? `${defaults.docType}_baseline` : null) || 'baseline_profile',
    deliverable_type: firstDefined(candidateProfile.deliverable_type, candidateProfile.deliverableType, defaults.deliverableType),
    audience: firstDefined(candidateProfile.audience, defaults.audience),
    format: firstDefined(candidateProfile.format, defaults.format),
    channel: firstDefined(candidateProfile.channel, defaults.channel),
    sample_count: Number(candidateProfile.sample_count ?? candidateProfile.sampleCount ?? defaults.sampleCount ?? 0),
    confidence: Number(candidateProfile.confidence ?? defaults.confidence ?? 0),
    high_variance_dims: candidateProfile.high_variance_dims || candidateProfile.highVarianceDims || defaults.highVarianceDims || [],
    ...canonical,
  };
}

async function fetchProfileById(profileId, db = supabase) {
  const { data, error } = await db
    .from(PROFILE_TABLE)
    .select('*')
    .eq('id', profileId)
    .maybeSingle();

  if (error) throw new Error(`fetchProfileById failed: ${error.message}`);
  return data || null;
}

async function fetchProposalById(proposalId, db = supabase) {
  const { data, error } = await db
    .from(PROPOSAL_TABLE)
    .select('*')
    .eq('id', proposalId)
    .maybeSingle();

  if (error) throw new Error(`fetchProposalById failed: ${error.message}`);
  return data || null;
}

async function fetchLegacyStyleProfile({ employeeId, docType, teamId = null, legacyProfileId = null, db = supabase }) {
  let query = db.from('style_profiles').select('*');
  if (legacyProfileId) {
    query = query.eq('id', legacyProfileId);
  } else {
    query = query.eq('employee_id', employeeId).eq('doc_type', docType);
    if (teamId) query = query.eq('team_id', teamId);
    else query = query.is('team_id', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`fetchLegacyStyleProfile failed: ${error.message}`);
  return data || null;
}

async function getNextVersion({ employeeId, docType, teamId = null, db = supabase }) {
  let query = applyScope(
    db.from(PROFILE_TABLE).select('version'),
    { employeeId, docType, teamId }
  )
    .order('version', { ascending: false })
    .limit(1);

  const { data, error } = await query;
  if (error) throw new Error(`getNextVersion failed: ${error.message}`);

  const currentVersion = Array.isArray(data) && data.length ? Number(data[0].version || 0) : 0;
  return currentVersion + 1;
}

async function supersedeActiveProfiles({ employeeId, docType, teamId = null, db = supabase }) {
  let query = applyScope(
    db.from(PROFILE_TABLE).update({ status: 'superseded' }),
    { employeeId, docType, teamId }
  ).eq('status', 'active');

  const { error } = await query;
  if (error) throw new Error(`supersedeActiveProfiles failed: ${error.message}`);
}

function buildProfileInsert({
  scope,
  version,
  status = 'active',
  candidateProfile = {},
  baseProfileId = null,
  sourceStyleProfileId = null,
  changeSummary = null,
  approvedBy = null,
  approvedAt = null,
  activatedAt = null,
  createdBy = null,
}) {
  const normalized = normalizeCandidateProfile(candidateProfile, scope);

  return {
    employee_id: scope.employeeId,
    team_id: scope.teamId,
    doc_type: scope.docType,
    profile_name: normalized.profile_name,
    version,
    status,
    base_profile_id: baseProfileId,
    source_style_profile_id: sourceStyleProfileId,
    deliverable_type: normalized.deliverable_type,
    audience: normalized.audience,
    format: normalized.format,
    channel: normalized.channel,
    sample_count: normalized.sample_count,
    confidence: normalized.confidence,
    high_variance_dims: normalized.high_variance_dims,
    canonical_structure: normalized.canonical_structure,
    canonical_formatting: normalized.canonical_formatting,
    canonical_charts: normalized.canonical_charts,
    canonical_kpi_layout: normalized.canonical_kpi_layout,
    canonical_text_style: normalized.canonical_text_style,
    change_summary: changeSummary,
    approved_by: approvedBy,
    approved_at: approvedAt,
    activated_at: activatedAt,
    created_by: createdBy,
  };
}

export function mapCompanyProfileRowToOutputProfile(profile, scope = {}) {
  if (!profile) return null;
  return {
    id: profile.id || null,
    employeeId: profile.employee_id || null,
    teamId: firstDefined(scope.teamId, profile.team_id),
    docType: firstDefined(scope.docType, profile.doc_type, 'general_report'),
    profileName: firstDefined(profile.profile_name, scope.profileName, 'default_profile'),
    deliverableType: firstDefined(scope.deliverableType, profile.deliverable_type),
    audience: firstDefined(scope.audience, profile.audience),
    format: firstDefined(scope.format, profile.format),
    channel: firstDefined(scope.channel, profile.channel),
    status: profile.status || 'active',
    version: Number(profile.version || 1),
    source: 'company_output_profiles',
    confidence: Number(profile.confidence || 0),
    sampleCount: Number(profile.sample_count || 0),
    highVarianceDims: profile.high_variance_dims || [],
    canonical: {
      structure: profile.canonical_structure || {},
      formatting: profile.canonical_formatting || {},
      charts: profile.canonical_charts || {},
      kpiLayout: profile.canonical_kpi_layout || {},
      textStyle: profile.canonical_text_style || {},
    },
  };
}

export async function getActiveCompanyOutputProfile({ employeeId, docType, teamId = null, db = supabase }) {
  let query = applyScope(
    db.from(PROFILE_TABLE).select('*'),
    { employeeId, docType, teamId }
  ).eq('status', 'active');

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`getActiveCompanyOutputProfile failed: ${error.message}`);
  return data || null;
}

export async function listCompanyOutputProfiles({
  employeeId,
  teamId,
  docType,
  status,
  db = supabase,
} = {}) {
  let query = db.from(PROFILE_TABLE).select('*');

  if (employeeId) query = query.eq('employee_id', employeeId);
  if (docType) query = query.eq('doc_type', docType);
  if (teamId !== undefined) {
    query = teamId ? query.eq('team_id', teamId) : query.is('team_id', null);
  }
  if (status) query = query.eq('status', status);

  const { data, error } = await query
    .order('doc_type', { ascending: true })
    .order('version', { ascending: false });

  if (error) throw new Error(`listCompanyOutputProfiles failed: ${error.message}`);
  return data || [];
}

export async function createProfileFromLegacyStyleProfile({
  employeeId,
  docType,
  teamId = null,
  legacyProfileId = null,
  actorUserId = null,
  db = supabase,
  now = defaultNow,
}) {
  const active = await getActiveCompanyOutputProfile({ employeeId, docType, teamId, db });
  if (active) return active;

  const legacyProfile = await fetchLegacyStyleProfile({ employeeId, docType, teamId, legacyProfileId, db });
  if (!legacyProfile) {
    throw new Error('Legacy style profile not found');
  }

  const version = await getNextVersion({ employeeId: legacyProfile.employee_id, docType: legacyProfile.doc_type, teamId: legacyProfile.team_id, db });
  const nowIso = now();
  const insertPayload = buildProfileInsert({
    scope: {
      employeeId: legacyProfile.employee_id,
      teamId: legacyProfile.team_id,
      docType: legacyProfile.doc_type,
      profileName: legacyProfile.profile_name,
      sampleCount: legacyProfile.sample_count,
      confidence: legacyProfile.confidence,
      highVarianceDims: legacyProfile.high_variance_dims,
    },
    version,
    status: 'active',
    candidateProfile: {
      profile_name: legacyProfile.profile_name,
      sample_count: legacyProfile.sample_count,
      confidence: legacyProfile.confidence,
      high_variance_dims: legacyProfile.high_variance_dims,
      canonical_structure: legacyProfile.canonical_structure,
      canonical_formatting: legacyProfile.canonical_formatting,
      canonical_charts: legacyProfile.canonical_charts,
      canonical_kpi_layout: legacyProfile.canonical_kpi_layout,
      canonical_text_style: legacyProfile.canonical_text_style,
    },
    sourceStyleProfileId: legacyProfile.id,
    changeSummary: 'Seeded from legacy style profile',
    approvedAt: nowIso,
    activatedAt: nowIso,
    createdBy: actorUserId,
  });

  const { data, error } = await db
    .from(PROFILE_TABLE)
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw new Error(`createProfileFromLegacyStyleProfile failed: ${error.message}`);
  return data;
}

export async function createOutputProfileProposal({
  employeeId,
  docType,
  teamId = null,
  profileName = null,
  deliverableType = null,
  audience = null,
  format = null,
  channel = null,
  rationale = null,
  proposedChanges = {},
  comparisonSummary = {},
  candidateProfile = {},
  baseProfileId = null,
  sourceStyleProfileId = null,
  sourceTaskId = null,
  sourceReviewId = null,
  sourceRunId = null,
  actorUserId = null,
  db = supabase,
  now = defaultNow,
}) {
  const requestedBy = await resolveActorUserId(db, actorUserId);
  const activeProfile = baseProfileId
    ? await fetchProfileById(baseProfileId, db)
    : await getActiveCompanyOutputProfile({ employeeId, docType, teamId, db });
  const proposedVersion = await getNextVersion({ employeeId, docType, teamId, db });
  const nowIso = now();
  const proposalName = profileName || candidateProfile.profile_name || candidateProfile.profileName || `${docType}_proposal_v${proposedVersion}`;

  const normalizedCandidate = normalizeCandidateProfile(candidateProfile, {
    profileName: proposalName,
    docType,
    deliverableType,
    audience,
    format,
    channel,
    sampleCount: activeProfile?.sample_count,
    confidence: activeProfile?.confidence,
    highVarianceDims: activeProfile?.high_variance_dims,
    canonical_structure: activeProfile?.canonical_structure,
    canonical_formatting: activeProfile?.canonical_formatting,
    canonical_charts: activeProfile?.canonical_charts,
    canonical_kpi_layout: activeProfile?.canonical_kpi_layout,
    canonical_text_style: activeProfile?.canonical_text_style,
  });

  const { data, error } = await db
    .from(PROPOSAL_TABLE)
    .insert({
      employee_id: employeeId,
      team_id: teamId,
      doc_type: docType,
      proposal_name: proposalName,
      status: 'pending_approval',
      base_profile_id: baseProfileId || activeProfile?.id || null,
      source_style_profile_id: sourceStyleProfileId || activeProfile?.source_style_profile_id || null,
      proposed_version: proposedVersion,
      deliverable_type: firstDefined(deliverableType, normalizedCandidate.deliverable_type, activeProfile?.deliverable_type),
      audience: firstDefined(audience, normalizedCandidate.audience, activeProfile?.audience),
      format: firstDefined(format, normalizedCandidate.format, activeProfile?.format),
      channel: firstDefined(channel, normalizedCandidate.channel, activeProfile?.channel),
      rationale,
      proposed_changes: proposedChanges || {},
      comparison_summary: comparisonSummary || {},
      candidate_profile: normalizedCandidate,
      source_task_id: sourceTaskId,
      source_review_id: sourceReviewId,
      source_run_id: sourceRunId,
      requested_by: requestedBy,
      requested_at: nowIso,
    })
    .select()
    .single();

  if (error) throw new Error(`createOutputProfileProposal failed: ${error.message}`);
  return data;
}

export async function approveOutputProfileProposal({
  proposalId,
  reviewComment = null,
  actorUserId = null,
  db = supabase,
  now = defaultNow,
}) {
  const reviewerId = await resolveActorUserId(db, actorUserId);
  const proposal = await fetchProposalById(proposalId, db);

  if (!proposal) throw new Error('Output profile proposal not found');
  if (proposal.status !== 'pending_approval') {
    throw new Error(`Cannot approve proposal in status "${proposal.status}"`);
  }

  const nowIso = now();
  await supersedeActiveProfiles({
    employeeId: proposal.employee_id,
    docType: proposal.doc_type,
    teamId: proposal.team_id,
    db,
  });

  const profilePayload = buildProfileInsert({
    scope: {
      employeeId: proposal.employee_id,
      teamId: proposal.team_id,
      docType: proposal.doc_type,
      profileName: proposal.proposal_name,
      deliverableType: proposal.deliverable_type,
      audience: proposal.audience,
      format: proposal.format,
      channel: proposal.channel,
    },
    version: Number(proposal.proposed_version || 1),
    status: 'active',
    candidateProfile: {
      ...(proposal.candidate_profile || {}),
      profile_name: proposal.proposal_name,
      deliverable_type: proposal.deliverable_type,
      audience: proposal.audience,
      format: proposal.format,
      channel: proposal.channel,
    },
    baseProfileId: proposal.base_profile_id || null,
    sourceStyleProfileId: proposal.source_style_profile_id || null,
    changeSummary: proposal.rationale || reviewComment || null,
    approvedBy: reviewerId,
    approvedAt: nowIso,
    activatedAt: nowIso,
    createdBy: proposal.requested_by || reviewerId,
  });

  const { data: createdProfile, error: profileError } = await db
    .from(PROFILE_TABLE)
    .insert(profilePayload)
    .select()
    .single();

  if (profileError) throw new Error(`approveOutputProfileProposal failed: ${profileError.message}`);

  const { data: updatedProposal, error: proposalError } = await db
    .from(PROPOSAL_TABLE)
    .update({
      status: 'approved',
      reviewed_by: reviewerId,
      reviewed_at: nowIso,
      review_comment: reviewComment,
      activated_profile_id: createdProfile.id,
    })
    .eq('id', proposalId)
    .select()
    .single();

  if (proposalError) throw new Error(`approveOutputProfileProposal failed: ${proposalError.message}`);

  return {
    proposal: updatedProposal,
    profile: createdProfile,
  };
}

export async function rejectOutputProfileProposal({
  proposalId,
  reviewComment = null,
  actorUserId = null,
  db = supabase,
  now = defaultNow,
}) {
  const reviewerId = await resolveActorUserId(db, actorUserId);
  const proposal = await fetchProposalById(proposalId, db);

  if (!proposal) throw new Error('Output profile proposal not found');
  if (proposal.status !== 'pending_approval') {
    throw new Error(`Cannot reject proposal in status "${proposal.status}"`);
  }

  const { data, error } = await db
    .from(PROPOSAL_TABLE)
    .update({
      status: 'rejected',
      reviewed_by: reviewerId,
      reviewed_at: now(),
      review_comment: reviewComment,
    })
    .eq('id', proposalId)
    .select()
    .single();

  if (error) throw new Error(`rejectOutputProfileProposal failed: ${error.message}`);
  return data;
}

export async function rollbackOutputProfile({
  profileId,
  reviewComment = null,
  actorUserId = null,
  db = supabase,
  now = defaultNow,
}) {
  const reviewerId = await resolveActorUserId(db, actorUserId);
  const targetProfile = await fetchProfileById(profileId, db);

  if (!targetProfile) throw new Error('Output profile not found');

  const nextVersion = await getNextVersion({
    employeeId: targetProfile.employee_id,
    docType: targetProfile.doc_type,
    teamId: targetProfile.team_id,
    db,
  });

  const nowIso = now();
  await supersedeActiveProfiles({
    employeeId: targetProfile.employee_id,
    docType: targetProfile.doc_type,
    teamId: targetProfile.team_id,
    db,
  });

  const rollbackPayload = buildProfileInsert({
    scope: {
      employeeId: targetProfile.employee_id,
      teamId: targetProfile.team_id,
      docType: targetProfile.doc_type,
      profileName: targetProfile.profile_name,
      deliverableType: targetProfile.deliverable_type,
      audience: targetProfile.audience,
      format: targetProfile.format,
      channel: targetProfile.channel,
    },
    version: nextVersion,
    status: 'active',
    candidateProfile: {
      profile_name: targetProfile.profile_name,
      deliverable_type: targetProfile.deliverable_type,
      audience: targetProfile.audience,
      format: targetProfile.format,
      channel: targetProfile.channel,
      sample_count: targetProfile.sample_count,
      confidence: targetProfile.confidence,
      high_variance_dims: targetProfile.high_variance_dims,
      canonical_structure: targetProfile.canonical_structure,
      canonical_formatting: targetProfile.canonical_formatting,
      canonical_charts: targetProfile.canonical_charts,
      canonical_kpi_layout: targetProfile.canonical_kpi_layout,
      canonical_text_style: targetProfile.canonical_text_style,
    },
    baseProfileId: targetProfile.id,
    sourceStyleProfileId: targetProfile.source_style_profile_id,
    changeSummary: `Rollback to version ${targetProfile.version}${reviewComment ? `: ${reviewComment}` : ''}`,
    approvedBy: reviewerId,
    approvedAt: nowIso,
    activatedAt: nowIso,
    createdBy: reviewerId,
  });

  const { data, error } = await db
    .from(PROFILE_TABLE)
    .insert(rollbackPayload)
    .select()
    .single();

  if (error) throw new Error(`rollbackOutputProfile failed: ${error.message}`);
  return data;
}

export const _testExports = {
  applyScope,
  normalizeCandidateProfile,
  buildProfileInsert,
  mapCompanyProfileRowToOutputProfile,
};

export default {
  getActiveCompanyOutputProfile,
  listCompanyOutputProfiles,
  createProfileFromLegacyStyleProfile,
  createOutputProfileProposal,
  approveOutputProfileProposal,
  rejectOutputProfileProposal,
  rollbackOutputProfile,
  mapCompanyProfileRowToOutputProfile,
};
