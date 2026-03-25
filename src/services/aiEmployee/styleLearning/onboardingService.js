/**
 * Onboarding Service
 *
 * Orchestrates the full onboarding flow for a new Digital Worker.
 * Analogous to a new employee's first week:
 *
 *   Day 1: Read the handbook (policy ingestion)
 *   Day 2: Look at past deliverables (exemplar ingestion)
 *   Day 3: Understand team preferences (style profile from bulk docs)
 *   Day 4: Do first task, get corrected (feedback capture)
 *   Ongoing: Learn from corrections (feedback → rule extraction)
 *
 * The onboarding flow is tracked via style_ingestion_jobs table
 * and can be resumed if interrupted.
 */
import { supabase } from '../../infra/supabaseClient.js';
import { extractStyleBatch } from './styleExtractionService.js';
import { compileProfile, saveProfile, updateProfileIncremental } from './styleProfileService.js';
import { extractPoliciesFromText, importPoliciesBatch } from './policyIngestionService.js';
import { createExemplarFromFile } from './exemplarService.js';
import { extractRulesFromFeedback } from './feedbackStyleExtractor.js';
import { computeAndSave as computeTrustMetrics } from './trustMetricsService.js';
import { createProfileFromLegacyStyleProfile } from './companyOutputProfileService.js';

const JOBS_TABLE = 'style_ingestion_jobs';

/** Best-effort DB call — swallows errors when Supabase is unreachable. */
async function safeDbCall(fn) {
  try { return await fn(); } catch (err) {
    console.warn('[onboarding] DB call skipped (offline?):', err.message);
    return null;
  }
}

// ─── Onboarding Status ───────────────────────────────────────

export const ONBOARDING_STAGES = {
  NOT_STARTED:  'not_started',
  POLICIES:     'ingesting_policies',
  EXEMPLARS:    'ingesting_exemplars',
  BULK_STYLE:   'learning_style',
  FEEDBACK:     'extracting_feedback',
  METRICS:      'computing_metrics',
  COMPLETE:     'complete',
  FAILED:       'failed',
  IN_PROGRESS:  'in_progress',
};

/** DB job statuses (Supabase jobs table values) */
const JOB_STATUS = Object.freeze({
  PENDING:    'pending',
  COMPLETED:  'completed',
  FAILED:     'failed',
  PROCESSING: 'processing',
});

// ─── Full Onboarding Pipeline ────────────────────────────────

/**
 * Run the full onboarding pipeline for a Digital Worker.
 *
 * @param {object} params
 * @param {string} params.employeeId
 * @param {string} params.teamId
 * @param {object} params.inputs
 * @param {string} [params.inputs.handbookText] - raw text of company handbook
 * @param {Array<{title, content, policy_type}>} [params.inputs.policies] - structured policies
 * @param {Array<{buffer, filename, docType}>} [params.inputs.exemplarFiles] - exemplar files
 * @param {Array<{buffer, filename}>} [params.inputs.bulkFiles] - bulk files for style learning
 * @param {string} [params.inputs.docType] - target doc type for style profile
 * @param {Function} [params.llmFn] - async (prompt) => string
 * @param {string} [params.userId] - who initiated onboarding
 * @param {Function} [params.onProgress] - (stage, detail) => void
 * @returns {OnboardingResult}
 */
export async function runOnboarding(params) {
  const { employeeId, teamId, inputs = {}, llmFn, userId, onProgress } = params;

  let job;
  try {
    job = await createJob(employeeId, 'onboarding', {
      teamId, docType: inputs.docType,
      hasHandbook: !!inputs.handbookText,
      policyCount: inputs.policies?.length || 0,
      exemplarCount: inputs.exemplarFiles?.length || 0,
      bulkFileCount: inputs.bulkFiles?.length || 0,
    }, userId);
  } catch (jobErr) {
    // Supabase offline — run pipeline in local-only mode
    console.warn('[onboarding] Job tracking unavailable (Supabase offline?), continuing without persistence:', jobErr.message);
    job = { id: `local_${Date.now()}` };
  }

  const result = {
    jobId: job.id,
    policiesCreated: 0,
    exemplarsCreated: 0,
    profileCreated: false,
    compiledProfiles: [],
    rulesExtracted: 0,
    metricsComputed: false,
    errors: [],
  };

  try {
    // Stage 1: Policy Ingestion
    onProgress?.(ONBOARDING_STAGES.POLICIES, 'Starting policy ingestion...');
    await safeDbCall(() => updateJobStatus(job.id, 'processing'));

    if (inputs.handbookText && llmFn) {
      try {
        const policies = await extractPoliciesFromText(inputs.handbookText, {
          employeeId, teamId, sourceFile: 'handbook', createdBy: userId,
        }, llmFn);
        result.policiesCreated += policies.length;
      } catch (err) {
        result.errors.push({ stage: 'policies', error: err.message });
      }
    }

    if (inputs.policies?.length) {
      try {
        const imported = await importPoliciesBatch(employeeId, inputs.policies, userId);
        result.policiesCreated += imported.length;
      } catch (err) {
        result.errors.push({ stage: 'policies_batch', error: err.message });
      }
    }

    // Stage 2: Exemplar Ingestion
    onProgress?.(ONBOARDING_STAGES.EXEMPLARS, `Processing ${inputs.exemplarFiles?.length || 0} exemplars...`);

    if (inputs.exemplarFiles?.length) {
      for (const file of inputs.exemplarFiles) {
        try {
          await createExemplarFromFile({
            employeeId,
            teamId,
            docType: file.docType || inputs.docType || 'general',
            title: file.filename,
            filename: file.filename,
            fileBuffer: file.buffer,
            approvedBy: userId,
          });
          result.exemplarsCreated++;
        } catch (err) {
          result.errors.push({ stage: 'exemplars', file: file.filename, error: err.message });
        }
      }
    }

    // Stage 3: Bulk Style Learning
    onProgress?.(ONBOARDING_STAGES.BULK_STYLE, `Processing ${inputs.bulkFiles?.length || 0} files for style learning...`);

    if (inputs.bulkFiles?.length) {
      const { fingerprints, errors } = await extractStyleBatch(inputs.bulkFiles, {
        llmFn,
        onProgress: (processed, total) => {
          onProgress?.(ONBOARDING_STAGES.BULK_STYLE, `Processed ${processed}/${total} files`);
        },
      });

      if (errors.length) {
        result.errors.push(...errors.map(e => ({ stage: 'bulk_style', ...e })));
      }

      if (fingerprints.length) {
        // Group by detected doc type (or use provided docType)
        const groups = groupFingerprints(fingerprints, inputs.docType);

        for (const [docType, fps] of Object.entries(groups)) {
          const profile = compileProfile(fps, {
            employee_id: employeeId,
            team_id: teamId,
            doc_type: docType,
            profile_name: `${docType}_profile`,
          });
          const saveResult = await safeDbCall(() => saveProfile(profile));
          if (!saveResult) {
            result.errors.push({ stage: 'bulk_style', error: `Failed to save style_profile for ${docType} (Supabase offline?)` });
          }

          // Bridge: also create a company_output_profile so OutputProfilesPage can see it.
          // Pass compiled profile as profileData so the bridge works even when
          // style_profiles table is unreachable (avoids re-reading from DB).
          // NOT wrapped in safeDbCall — we want errors to surface so the
          // fallback in listCompanyOutputProfiles can auto-bridge later.
          let bridgeResult = null;
          try {
            bridgeResult = await createProfileFromLegacyStyleProfile({
              employeeId,
              docType,
              teamId: teamId || null,
              actorUserId: userId,
              profileData: saveResult || profile,
            });
          } catch (bridgeErr) {
            console.error(`[onboarding] Bridge to company_output_profiles failed for ${docType}:`, bridgeErr.message);
            result.errors.push({ stage: 'bridge', docType, error: bridgeErr.message });
          }

          result.profileCreated = true;
          // Attach compiled profile so the page can use it as local fallback
          result.compiledProfiles.push({
            id: bridgeResult?.id || saveResult?.id || `local_${docType}_${Date.now()}`,
            employee_id: employeeId,
            team_id: teamId || null,
            doc_type: docType,
            profile_name: profile.profile_name || `${docType}_profile`,
            status: 'active',
            version: 1,
            sample_count: profile.sample_count || fps.length,
            confidence: profile.confidence || 0,
            high_variance_dims: profile.high_variance_dims || [],
            canonical_structure: profile.canonical_structure || {},
            canonical_formatting: profile.canonical_formatting || {},
            canonical_charts: profile.canonical_charts || {},
            canonical_kpi_layout: profile.canonical_kpi_layout || {},
            canonical_text_style: profile.canonical_text_style || {},
            _local: !bridgeResult,
          });
        }
      }
    }

    // Stage 4: Feedback Extraction (from existing task history)
    onProgress?.(ONBOARDING_STAGES.FEEDBACK, 'Extracting rules from feedback history...');

    if (llmFn) {
      try {
        const { newRules, updatedRules } = await extractRulesFromFeedback(employeeId, llmFn);
        result.rulesExtracted = newRules.length + updatedRules.length;
      } catch (err) {
        result.errors.push({ stage: 'feedback', error: err.message });
      }
    }

    // Stage 5: Compute initial trust metrics
    onProgress?.(ONBOARDING_STAGES.METRICS, 'Computing initial trust metrics...');

    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
      await computeTrustMetrics(employeeId, thirtyDaysAgo, now);
      result.metricsComputed = true;
    } catch (err) {
      result.errors.push({ stage: 'metrics', error: err.message });
    }

    // Done
    await safeDbCall(() => updateJobCompleted(job.id, result));
    onProgress?.(ONBOARDING_STAGES.COMPLETE, 'Onboarding complete!');

  } catch (err) {
    result.errors.push({ stage: 'unknown', error: err.message });
    await safeDbCall(() => updateJobFailed(job.id, err.message, result));
    throw err;
  }

  return result;
}

// ─── Incremental Learning ────────────────────────────────────

/**
 * Run incremental style learning from new files.
 * Used after initial onboarding to continuously improve the style profile.
 */
export async function learnFromNewFiles(employeeId, teamId, files, docType, opts = {}) {
  const job = await createJob(employeeId, 'bulk_excel', {
    teamId, docType, fileCount: files.length,
  }, opts.userId);

  try {
    await updateJobStatus(job.id, 'processing');

    const { fingerprints, errors } = await extractStyleBatch(files, {
      llmFn: opts.llmFn,
      onProgress: (processed, total) => {
        updateJobProgress(job.id, processed, total);
      },
    });

    if (fingerprints.length) {
      await updateProfileIncremental(employeeId, docType, fingerprints, teamId);
    }

    await updateJobCompleted(job.id, { fingerprints: fingerprints.length, errors });
    return { processed: fingerprints.length, errors };
  } catch (err) {
    await updateJobFailed(job.id, err.message);
    throw err;
  }
}

/**
 * Run periodic feedback extraction and metrics computation.
 * Designed to be called by a scheduler (e.g. weekly).
 */
export async function runPeriodicLearning(employeeId, llmFn) {
  const results = { rulesExtracted: 0, metricsComputed: false };

  // Extract new rules from recent feedback
  if (llmFn) {
    const { newRules, updatedRules } = await extractRulesFromFeedback(employeeId, llmFn, {
      lookbackDays: 14,
    });
    results.rulesExtracted = newRules.length + updatedRules.length;
  }

  // Compute weekly trust metrics
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  await computeTrustMetrics(employeeId, weekAgo, now);
  results.metricsComputed = true;

  return results;
}

// ─── Onboarding Status Check ─────────────────────────────────

/**
 * Check the onboarding status of an employee.
 */
export async function getOnboardingStatus(employeeId) {
  const { data: jobs } = await supabase
    .from(JOBS_TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .eq('job_type', 'onboarding')
    .order('created_at', { ascending: false })
    .limit(1);

  if (!jobs?.length) return { stage: ONBOARDING_STAGES.NOT_STARTED, job: null };

  const job = jobs[0];
  if (job.status === JOB_STATUS.COMPLETED) return { stage: ONBOARDING_STAGES.COMPLETE, job };
  if (job.status === JOB_STATUS.FAILED) return { stage: ONBOARDING_STAGES.FAILED, job };
  if (job.status === JOB_STATUS.PROCESSING) return { stage: ONBOARDING_STAGES.IN_PROGRESS, job };

  return { stage: ONBOARDING_STAGES.NOT_STARTED, job };
}

// ─── Job Tracking ────────────────────────────────────────────

async function createJob(employeeId, jobType, config, userId) {
  const totalFiles = config.bulkFileCount || config.fileCount || config.exemplarCount || 0;

  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .insert({
      employee_id: employeeId,
      job_type: jobType,
      status: JOB_STATUS.PENDING,
      total_files: totalFiles,
      config,
      created_by: userId,
    })
    .select()
    .single();

  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data;
}

async function updateJobStatus(jobId, status) {
  await supabase.from(JOBS_TABLE).update({
    status,
    started_at: status === JOB_STATUS.PROCESSING ? new Date().toISOString() : undefined,
  }).eq('id', jobId);
}

async function updateJobProgress(jobId, processed, total) {
  await supabase.from(JOBS_TABLE).update({ processed, total_files: total }).eq('id', jobId);
}

async function updateJobCompleted(jobId, result) {
  await supabase.from(JOBS_TABLE).update({
    status: JOB_STATUS.COMPLETED,
    completed_at: new Date().toISOString(),
    result,
  }).eq('id', jobId);
}

async function updateJobFailed(jobId, errorMsg, result = {}) {
  await supabase.from(JOBS_TABLE).update({
    status: JOB_STATUS.FAILED,
    completed_at: new Date().toISOString(),
    error_log: [{ error: errorMsg, at: new Date().toISOString() }],
    result,
  }).eq('id', jobId);
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Group fingerprints by doc type. If a single docType is given, all go there.
 * Otherwise, attempt heuristic classification based on structure.
 */
function groupFingerprints(fingerprints, defaultDocType) {
  if (defaultDocType) {
    return { [defaultDocType]: fingerprints };
  }

  // Heuristic: classify by sheet patterns
  const groups = {};
  for (const fp of fingerprints) {
    const docType = classifyDocType(fp);
    if (!groups[docType]) groups[docType] = [];
    groups[docType].push(fp);
  }
  return groups;
}

/**
 * Classify doc type from fingerprint content.
 * Three layers:
 *   1. Filename patterns (EN/ZH)
 *   2. Sheet name patterns (EN/ZH)
 *   3. KPI keyword density in extracted text/fields
 * Falls back to 'general_report' — still valid for learning.
 */
function classifyDocType(fp) {
  // Layer 1: filename
  const fname = (fp.source_file || '').toLowerCase();
  const fnameMatch = classifyByFilename(fname);
  if (fnameMatch) return fnameMatch;

  // Layer 2: sheet names
  const names = (fp.structure?.sheet_names || []).map(n => n.toLowerCase());
  const allNames = names.join(' ');

  // MBR / monthly report
  if (allNames.includes('kpi') || allNames.includes('dashboard') || allNames.includes('cover')
    || allNames.includes('指標') || allNames.includes('儀表') || allNames.includes('封面')
    || allNames.includes('summary') || allNames.includes('總覽') || allNames.includes('摘要'))
    return 'mbr_report';

  // Weekly ops
  if (allNames.includes('weekly') || allNames.includes('週報') || allNames.includes('周報')
    || allNames.includes('week'))
    return 'weekly_ops';

  // QBR / quarterly
  if (allNames.includes('qbr') || allNames.includes('quarterly') || allNames.includes('季')
    || allNames.includes('q1') || allNames.includes('q2') || allNames.includes('q3') || allNames.includes('q4'))
    return 'qbr_deck';

  // Forecast
  if (allNames.includes('forecast') || allNames.includes('預測') || allNames.includes('demand')
    || allNames.includes('需求'))
    return 'forecast_report';

  // Risk
  if (allNames.includes('risk') || allNames.includes('風險') || allNames.includes('exception')
    || allNames.includes('異常'))
    return 'risk_report';

  // Layer 3: KPI keyword density
  const kpiKeywords = fp.kpi_layout?.kpi_keywords_found || [];
  if (kpiKeywords.length >= 3) return 'mbr_report';

  // Structure heuristics
  if (fp.structure?.sheet_count === 1) return 'ad_hoc_analysis';
  if (fp.structure?.sheet_count >= 5) return 'mbr_report'; // complex workbook → likely MBR

  return 'general_report';
}

function classifyByFilename(fname) {
  if (/mbr|monthly.?business|月報|月會|monthly.?report/i.test(fname)) return 'mbr_report';
  if (/weekly|週報|周報/i.test(fname)) return 'weekly_ops';
  if (/qbr|quarterly|季報|季度/i.test(fname)) return 'qbr_deck';
  if (/forecast|預測|demand|需求/i.test(fname)) return 'forecast_report';
  if (/risk|風險|exception|異常/i.test(fname)) return 'risk_report';
  if (/email|mail|update|摘要/i.test(fname)) return 'manager_email';
  return null;
}

export const _testExports = { classifyDocType, groupFingerprints, ONBOARDING_STAGES };
