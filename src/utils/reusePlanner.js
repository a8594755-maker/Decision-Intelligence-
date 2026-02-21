import UPLOAD_SCHEMAS, { validateFieldType } from './uploadSchemas';
import { getRequiredMappingStatus } from './requiredMappingStatus';
import { buildSignature, similarity } from './datasetSimilarity';

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));

const toSourceToTargetMapping = (targetToSource = {}) => {
  const mapping = {};
  Object.entries(targetToSource || {}).forEach(([targetField, sourceColumn]) => {
    if (!targetField || !sourceColumn) return;
    mapping[String(sourceColumn)] = String(targetField);
  });
  return mapping;
};

const getSheetMapFromProfile = (profileJson = {}) => {
  const map = new Map();
  const sheets = Array.isArray(profileJson?.sheets) ? profileJson.sheets : [];
  sheets.forEach((sheet) => {
    const key = normalizeText(sheet?.sheet_name);
    if (!key) return;
    map.set(key, sheet);
  });
  return map;
};

const getRowsMapFromSheetsRaw = (sheetsRaw = []) => {
  const map = new Map();
  (Array.isArray(sheetsRaw) ? sheetsRaw : []).forEach((sheet) => {
    const key = normalizeText(sheet?.sheet_name || sheet?.sheetName);
    if (!key) return;
    map.set(key, Array.isArray(sheet?.rows) ? sheet.rows : []);
  });
  return map;
};

const countTypeIssues = ({ uploadType, sourceToTargetMap, rows }) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema || !Array.isArray(rows) || rows.length === 0) return 0;
  const schemaByField = new Map(schema.fields.map((field) => [field.key, field]));
  const sampleRows = rows.slice(0, 200);
  let issues = 0;

  Object.entries(sourceToTargetMap || {}).forEach(([sourceColumn, targetField]) => {
    const field = schemaByField.get(targetField);
    if (!field) return;

    let checked = 0;
    let invalid = 0;
    sampleRows.forEach((row) => {
      const value = row?.[sourceColumn];
      if (value === null || value === undefined || value === '') return;
      checked += 1;
      if (!validateFieldType(value, field.type).valid) invalid += 1;
    });

    if (checked > 0 && invalid > 0) issues += 1;
  });

  return issues;
};

export function applyContractTemplateToProfile({
  profile_json = {},
  contract_template_json = {},
  sheetsRaw = []
} = {}) {
  const nextProfile = JSON.parse(JSON.stringify(profile_json || {}));
  const templateDatasets = Array.isArray(contract_template_json?.datasets)
    ? contract_template_json.datasets
    : [];
  const sheetMap = getSheetMapFromProfile(nextProfile);
  const rowsMap = getRowsMapFromSheetsRaw(sheetsRaw);

  const evaluatedDatasets = templateDatasets.map((dataset) => {
    const sheetName = String(dataset?.sheet_name || '').trim();
    const sheet = sheetMap.get(normalizeText(sheetName));
    const columns = Array.isArray(sheet?.original_headers)
      ? sheet.original_headers
      : [];

    const uploadType = String(dataset?.upload_type || sheet?.likely_role || 'unknown');
    const sourceToTarget = toSourceToTargetMapping(dataset?.mapping || {});
    const mappingStatus = (uploadType && UPLOAD_SCHEMAS[uploadType])
      ? getRequiredMappingStatus({
          uploadType,
          columns,
          columnMapping: sourceToTarget
        })
      : {
          isComplete: false,
          coverage: 0,
          missingRequired: [],
          mappedRequired: []
        };

    const typeIssueCount = countTypeIssues({
      uploadType,
      sourceToTargetMap: sourceToTarget,
      rows: rowsMap.get(normalizeText(sheetName)) || []
    });

    const reasons = [];
    if (!mappingStatus.isComplete) {
      reasons.push(`Missing required fields: ${mappingStatus.missingRequired.join(', ')}`);
    }
    if (typeIssueCount > 0) {
      reasons.push(`Type issues detected in ${typeIssueCount} mapped fields`);
    }
    if (!UPLOAD_SCHEMAS[uploadType]) {
      reasons.push('Unknown upload type for schema contract validation');
    }

    if (sheet) {
      sheet.likely_role = uploadType;
      sheet.confidence = Number(Math.max(0.01, toNumber(sheet.confidence, 0.9)).toFixed(3));
      if (sheet?.grain_guess && typeof sheet.grain_guess === 'object') {
        sheet.grain_guess.keys = Object.keys(dataset?.mapping || {}).slice(0, 4);
      }
    }

    return {
      sheet_name: sheetName,
      upload_type: uploadType,
      mapping: dataset?.mapping || {},
      requiredCoverage: Number(toNumber(mappingStatus.coverage, 0).toFixed(3)),
      missing_required_fields: Array.isArray(mappingStatus.missingRequired) ? mappingStatus.missingRequired : [],
      validation: {
        status: (mappingStatus.isComplete && typeIssueCount === 0) ? 'pass' : 'fail',
        reasons
      }
    };
  });

  const coverageValues = evaluatedDatasets
    .map((dataset) => toNumber(dataset.requiredCoverage, 0))
    .filter((value) => Number.isFinite(value));
  const requiredCoverage = coverageValues.length > 0
    ? Number((coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length).toFixed(3))
    : 0;
  const contractPass = evaluatedDatasets.length > 0 && evaluatedDatasets.every((dataset) => dataset.validation.status === 'pass');

  const nextContract = {
    datasets: evaluatedDatasets,
    requiredCoverage,
    missing_required_fields: evaluatedDatasets
      .filter((dataset) => dataset.missing_required_fields.length > 0)
      .map((dataset) => ({
        sheet_name: dataset.sheet_name,
        fields: dataset.missing_required_fields
      })),
    validation: {
      status: contractPass ? 'pass' : 'fail',
      reasons: contractPass ? [] : ['One or more sheets failed required field coverage or type validation']
    }
  };

  if (!nextProfile.global || typeof nextProfile.global !== 'object') {
    nextProfile.global = {};
  }
  const minimalQuestions = [];
  if (!contractPass) {
    minimalQuestions.push('Please confirm mappings for sheets with missing required fields.');
  }
  nextProfile.global.minimal_questions = minimalQuestions.slice(0, 2);

  return {
    profile_json: nextProfile,
    contract_json: nextContract,
    requiredCoverage,
    validation_passed: contractPass
  };
}

const selectBestTemplateBySimilarity = ({
  newSignature,
  templates = [],
  signaturesByFingerprint = new Map()
}) => {
  let best = null;

  templates.forEach((template) => {
    const fingerprint = String(template?.fingerprint || '').trim();
    if (!fingerprint) return;
    const signatureRow = signaturesByFingerprint.get(fingerprint);
    if (!signatureRow?.signature_json) return;

    const sim = similarity(newSignature, signatureRow.signature_json);
    const quality = clamp01(toNumber(template?.quality_score, 0));
    const combined = Number(((sim.score * 0.85) + (quality * 0.15)).toFixed(4));

    const candidate = {
      template,
      similarity_score: sim.score,
      combined_score: combined,
      reasons: sim.reasons || []
    };

    if (!best || candidate.combined_score > best.combined_score) {
      best = candidate;
    }
  });

  return best;
};

const toWorkflow = (profileJson = {}) => {
  const label = normalizeText(profileJson?.global?.workflow_guess?.label || 'unknown');
  if (label === 'a') return 'workflow_A_replenishment';
  if (label === 'b') return 'workflow_B';
  if (label === 'c') return 'workflow_C';
  return 'workflow_A_replenishment';
};

export function buildReusePlan({
  dataset_profile = {},
  contract_templates = [],
  settings_templates = [],
  similarity_index_rows = []
} = {}) {
  const profileJson = dataset_profile?.profile_json || {};
  const contractJson = dataset_profile?.contract_json || {};
  const workflow = toWorkflow(profileJson);
  const fingerprint = String(dataset_profile?.fingerprint || '').trim();
  const newSignature = buildSignature(profileJson, contractJson);

  const workflowContracts = (Array.isArray(contract_templates) ? contract_templates : [])
    .filter((template) => String(template?.workflow || '') === workflow);
  const workflowSettings = (Array.isArray(settings_templates) ? settings_templates : [])
    .filter((template) => String(template?.workflow || '') === workflow);

  const signaturesByFingerprint = new Map();
  (Array.isArray(similarity_index_rows) ? similarity_index_rows : []).forEach((row) => {
    const key = String(row?.fingerprint || '').trim();
    if (!key || !row?.signature_json) return;
    if (!signaturesByFingerprint.has(key)) {
      signaturesByFingerprint.set(key, row);
    }
  });

  const exactContract = workflowContracts.find((template) => String(template.fingerprint || '') === fingerprint) || null;
  const exactSettings = workflowSettings.find((template) => String(template.fingerprint || '') === fingerprint) || null;

  let contractCandidate = null;
  let settingsCandidate = null;
  let confidence = 0;
  let explanation = 'No reusable template matched.';

  if (exactContract) {
    const quality = clamp01(toNumber(exactContract.quality_score, 0));
    confidence = Number((0.9 + (quality * 0.1)).toFixed(4));
    contractCandidate = {
      template: exactContract,
      similarity_score: 1,
      combined_score: confidence,
      reasons: ['fingerprint_exact_match=1.000']
    };
    if (exactSettings) {
      settingsCandidate = {
        template: exactSettings,
        similarity_score: 1,
        combined_score: Number((0.9 + (clamp01(toNumber(exactSettings.quality_score, 0)) * 0.1)).toFixed(4)),
        reasons: ['fingerprint_exact_match=1.000']
      };
    }
    explanation = 'Exact fingerprint match found from prior validated dataset.';
  } else {
    contractCandidate = selectBestTemplateBySimilarity({
      newSignature,
      templates: workflowContracts,
      signaturesByFingerprint
    });

    settingsCandidate = selectBestTemplateBySimilarity({
      newSignature,
      templates: workflowSettings,
      signaturesByFingerprint
    });

    confidence = contractCandidate?.combined_score || 0;
    if (contractCandidate) {
      explanation = `Best similar template score=${contractCandidate.combined_score.toFixed(3)} (${(contractCandidate.reasons || []).join('; ')})`;
    }
  }

  const contractTemplate = contractCandidate?.template || null;
  const settingsTemplate = settingsCandidate?.template || null;
  let mode = 'no_reuse';

  if (contractTemplate) {
    const evaluated = applyContractTemplateToProfile({
      profile_json: profileJson,
      contract_template_json: contractTemplate.contract_json
    });
    const shouldAutoApply = confidence >= 0.9 && evaluated.requiredCoverage >= 1 && evaluated.validation_passed;
    if (shouldAutoApply) {
      mode = 'auto_apply';
    } else if (confidence >= 0.75) {
      mode = 'ask_one_click';
    }
  }

  return {
    contract_template_id: contractTemplate?.id || null,
    settings_template_id: settingsTemplate?.id || null,
    confidence: Number(clamp01(confidence).toFixed(4)),
    mode,
    explanation
  };
}

export default {
  buildReusePlan,
  applyContractTemplateToProfile
};
