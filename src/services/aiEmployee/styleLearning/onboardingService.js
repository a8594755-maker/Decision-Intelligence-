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
import { supabase } from '../../supabaseClient.js';
import { extractStyleBatch, enrichTextStyle } from './styleExtractionService.js';
import { compileProfile, saveProfile } from './styleProfileService.js';
import { extractPoliciesFromText, importPoliciesBatch } from './policyIngestionService.js';
import { createExemplarFromFile } from './exemplarService.js';
import { extractRulesFromFeedback } from './feedbackStyleExtractor.js';
import { computeAndSave as computeTrustMetrics } from './trustMetricsService.js';

const JOBS_TABLE = 'style_ingestion_jobs';

// ─── Onboarding Status ───────────────────────────────────────

export const ONBOARDING_STAGES = {
  NOT_STARTED:  'not_started',
  POLICIES:     'ingesting_policies',
  EXEMPLARS:    'ingesting_exemplars',
  BULK_STYLE:   'learning_style',
  FEEDBACK:     'extracting_feedback',
  METRICS:      'computing_metrics',
  COMPLETE:     'complete',
};

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

  const job = await createJob(employeeId, 'onboarding', {
    teamId, docType: inputs.docType,
    hasHandbook: !!inputs.handbookText,
    policyCount: inputs.policies?.length || 0,
    exemplarCount: inputs.exemplarFiles?.length || 0,
    bulkFileCount: inputs.bulkFiles?.length || 0,
  }, userId);

  const result = {
    jobId: job.id,
    policiesCreated: 0,
    exemplarsCreated: 0,
    profileCreated: false,
    rulesExtracted: 0,
    metricsComputed: false,
    errors: [],
  };

  try {
    // Stage 1: Policy Ingestion
    onProgress?.(ONBOARDING_STAGES.POLICIES, 'Starting policy ingestion...');
    await updateJobStatus(job.id, 'processing');

    if (inputs.handbookText && llmFn) {
      const policies = await extractPoliciesFromText(inputs.handbookText, {
        employeeId, teamId, sourceFile: 'handbook', createdBy: userId,
      }, llmFn);
      result.policiesCreated += policies.length;
    }

    if (inputs.policies?.length) {
      const imported = await importPoliciesBatch(employeeId, inputs.policies, userId);
      result.policiesCreated += imported.length;
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
          await saveProfile(profile);
          result.profileCreated = true;
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
    await updateJobCompleted(job.id, result);
    onProgress?.(ONBOARDING_STAGES.COMPLETE, 'Onboarding complete!');

  } catch (err) {
    result.errors.push({ stage: 'unknown', error: err.message });
    await updateJobFailed(job.id, err.message, result);
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
      const { updateProfileIncremental } = await import('./styleProfileService.js');
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
  if (job.status === 'completed') return { stage: ONBOARDING_STAGES.COMPLETE, job };
  if (job.status === 'failed') return { stage: 'failed', job };
  if (job.status === 'processing') return { stage: 'in_progress', job };

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
      status: 'pending',
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
    started_at: status === 'processing' ? new Date().toISOString() : undefined,
  }).eq('id', jobId);
}

async function updateJobProgress(jobId, processed, total) {
  await supabase.from(JOBS_TABLE).update({ processed, total_files: total }).eq('id', jobId);
}

async function updateJobCompleted(jobId, result) {
  await supabase.from(JOBS_TABLE).update({
    status: 'completed',
    completed_at: new Date().toISOString(),
    result,
  }).eq('id', jobId);
}

async function updateJobFailed(jobId, errorMsg, result = {}) {
  await supabase.from(JOBS_TABLE).update({
    status: 'failed',
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
