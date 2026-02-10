/**
 * Sheet Classifier - Generic, testable sheet classifier
 * Uses config-based fingerprints, no hardcoded logic
 */

import { UPLOAD_FINGERPRINTS, getSupportedUploadTypes } from '../config/uploadFingerprints';
import { mapHeaderToCanonical, batchMapHeaders } from '../config/headerSynonyms';

/**
 * Classify a single sheet based on headers and sample data
 * 
 * @param {object} params
 * @param {string} params.sheetName - Sheet name
 * @param {string[]} params.headers - Raw headers from Excel
 * @param {object[]} params.sampleRows - Sample rows (first 10-20) for type checking
 * @returns {object} Classification result
 */
export function classifySheet({ sheetName, headers, sampleRows = [] }) {
  // Map headers to canonical names
  const headerMapping = batchMapHeaders(headers);
  const canonicalHeaders = new Set(headerMapping.values());
  
  // Score all upload types
  const candidates = [];
  const supportedTypes = getSupportedUploadTypes();
  
  for (const uploadType of supportedTypes) {
    const fingerprint = UPLOAD_FINGERPRINTS[uploadType];
    const result = scoreUploadType(uploadType, fingerprint, canonicalHeaders, sampleRows, headerMapping);
    candidates.push(result);
  }
  
  // Sort by confidence (descending)
  candidates.sort((a, b) => b.confidence - a.confidence);
  
  const topCandidate = candidates[0];
  
  return {
    suggestedType: topCandidate.confidence > 0 ? topCandidate.uploadType : null,
    confidence: topCandidate.confidence,
    evidence: topCandidate.evidence,
    candidates: candidates.filter(c => c.confidence > 0.1) // Only return reasonable candidates
  };
}

/**
 * Score a single upload type against sheet data
 * 
 * @param {string} uploadType 
 * @param {object} fingerprint 
 * @param {Set<string>} canonicalHeaders 
 * @param {object[]} sampleRows 
 * @param {Map<string, string>} headerMapping 
 * @returns {object} Scoring result
 */
function scoreUploadType(uploadType, fingerprint, canonicalHeaders, sampleRows, headerMapping) {
  const {
    requiredHeaders = [],
    optionalHeaders = [],
    negativeHeaders = [],
    strongFeatures = [], // Strong features (high weight bonus)
    exclusiveFeatures = [], // Exclusive features (heavy penalty if present)
    fieldTypeHints = {},
    minConfidenceToAutoEnable = 0.75
  } = fingerprint;
  
  // Check required headers
  const matchedRequired = requiredHeaders.filter(h => canonicalHeaders.has(h));
  const missingRequired = requiredHeaders.filter(h => !canonicalHeaders.has(h));
  
  // Check optional headers
  const matchedOptional = optionalHeaders.filter(h => canonicalHeaders.has(h));
  
  // Check negative headers (should NOT appear)
  const matchedNegative = negativeHeaders.filter(h => canonicalHeaders.has(h));
  
  // Check strong features (high bonus)
  const matchedStrongFeatures = (strongFeatures || []).filter(feature => {
    if (Array.isArray(feature)) {
      // Group feature: all must be present
      return feature.every(h => canonicalHeaders.has(h));
    }
    return canonicalHeaders.has(feature);
  });
  
  // Check exclusive features (heavy penalty if present)
  const matchedExclusiveFeatures = (exclusiveFeatures || []).filter(h => canonicalHeaders.has(h));
  
  // Type checking on sample data (expanded to first 50 rows)
  const typeCheckResults = checkFieldTypes(fieldTypeHints, sampleRows.slice(0, 50), headerMapping);
  
  // Calculate base score
  let score = 0;
  
  // Required headers: +10 points each
  score += matchedRequired.length * 10;
  
  // Optional headers: +1 point each
  score += matchedOptional.length * 1;
  
  // Missing required: -20 points each (severe penalty)
  score -= missingRequired.length * 20;
  
  // Negative headers: -15 points each (major penalty)
  score -= matchedNegative.length * 15;
  
  // Strong features: +30 points each (dominant signal)
  score += matchedStrongFeatures.length * 30;
  
  // Exclusive features: -20 points each (wrong type signal)
  score -= matchedExclusiveFeatures.length * 20;
  
  // Type check bonus: +5 points if pass rate > 70%
  if (typeCheckResults.passRate > 0.7) {
    score += 5;
  }
  
  // Type check heavy bonus: +15 points if pass rate > 90% (very high quality data)
  if (typeCheckResults.passRate > 0.9) {
    score += 15;
  }
  
  // Calculate max possible score (all required + all optional + strong features matched, no negatives)
  const maxScore = (requiredHeaders.length * 10) + (optionalHeaders.length * 1) + ((strongFeatures || []).length * 30) + 20;
  
  // Calculate confidence (0-1)
  let confidence = maxScore > 0 ? Math.max(0, score) / maxScore : 0;
  
  // Cap confidence if missing required fields
  if (missingRequired.length > 0) {
    confidence = Math.min(confidence, 0.5); // Cap at 50% if missing any required
  }
  
  // Further reduce confidence if negative headers matched
  if (matchedNegative.length > 0) {
    confidence *= 0.7; // Reduce by 30% for each negative match category
  }
  
  // Clamp to [0, 1]
  confidence = Math.max(0, Math.min(1, confidence));
  
  return {
    uploadType,
    confidence,
    score,
    evidence: {
      matchedRequired,
      missingRequired,
      matchedOptional,
      matchedNegative,
      matchedStrongFeatures,
      matchedExclusiveFeatures,
      typeCheckPassRate: typeCheckResults.passRate,
      typeCheckDetails: typeCheckResults.details
    },
    reasons: buildReasons({
      matchedRequired,
      missingRequired,
      matchedOptional,
      matchedNegative,
      matchedStrongFeatures,
      matchedExclusiveFeatures,
      typeCheckResults
    }),
    autoEnabled: confidence >= minConfidenceToAutoEnable && missingRequired.length === 0
  };
}

/**
 * Build human-readable reasons for classification score
 */
function buildReasons({ matchedRequired, missingRequired, matchedOptional, matchedNegative, matchedStrongFeatures, matchedExclusiveFeatures, typeCheckResults }) {
  const reasons = [];
  
  if (matchedStrongFeatures && matchedStrongFeatures.length > 0) {
    reasons.push(`✓ Strong features: ${matchedStrongFeatures.map(f => Array.isArray(f) ? f.join('+') : f).join(', ')}`);
  }
  
  if (matchedRequired.length > 0) {
    reasons.push(`✓ Required: ${matchedRequired.join(', ')}`);
  }
  
  if (missingRequired.length > 0) {
    reasons.push(`✗ Missing required: ${missingRequired.join(', ')}`);
  }
  
  if (matchedExclusiveFeatures && matchedExclusiveFeatures.length > 0) {
    reasons.push(`✗ Exclusive features (wrong type): ${matchedExclusiveFeatures.join(', ')}`);
  }
  
  if (matchedNegative.length > 0) {
    reasons.push(`✗ Negative: ${matchedNegative.join(', ')}`);
  }
  
  if (matchedOptional.length > 0) {
    reasons.push(`✓ Optional: ${matchedOptional.slice(0, 3).join(', ')}${matchedOptional.length > 3 ? '...' : ''}`);
  }
  
  if (typeCheckResults.passRate > 0.9) {
    reasons.push(`✓ Data type validation: ${Math.round(typeCheckResults.passRate * 100)}% (excellent)`);
  } else if (typeCheckResults.passRate > 0.7) {
    reasons.push(`✓ Data type validation: ${Math.round(typeCheckResults.passRate * 100)}% (good)`);
  }
  
  return reasons;
}

/**
 * Check if sample data matches expected field types
 * 
 * @param {object} fieldTypeHints - { fieldName: 'date'|'number'|'string' }
 * @param {object[]} sampleRows 
 * @param {Map<string, string>} headerMapping 
 * @returns {object} { passRate, details }
 */
function checkFieldTypes(fieldTypeHints, sampleRows, headerMapping) {
  if (!fieldTypeHints || Object.keys(fieldTypeHints).length === 0 || sampleRows.length === 0) {
    return { passRate: 1, details: {} };
  }
  
  const results = {};
  let totalChecks = 0;
  let passedChecks = 0;
  
  // Reverse mapping: canonical -> raw header
  const canonicalToRaw = new Map();
  for (const [raw, canonical] of headerMapping.entries()) {
    canonicalToRaw.set(canonical, raw);
  }
  
  for (const [canonicalField, expectedType] of Object.entries(fieldTypeHints)) {
    const rawHeader = canonicalToRaw.get(canonicalField);
    if (!rawHeader) continue;
    
    let matchCount = 0;
    let totalValues = 0;
    
    for (const row of sampleRows) {
      const value = row[rawHeader];
      if (value === null || value === undefined || value === '') continue;
      
      totalValues++;
      
      if (checkValueType(value, expectedType)) {
        matchCount++;
      }
    }
    
    const fieldPassRate = totalValues > 0 ? matchCount / totalValues : 0;
    results[canonicalField] = {
      expectedType,
      passRate: fieldPassRate,
      sampleSize: totalValues
    };
    
    totalChecks++;
    if (fieldPassRate > 0.7) {
      passedChecks++;
    }
  }
  
  const overallPassRate = totalChecks > 0 ? passedChecks / totalChecks : 1;
  
  return {
    passRate: overallPassRate,
    details: results
  };
}

/**
 * Check if a value matches expected type
 * 
 * @param {any} value 
 * @param {string} expectedType - 'date'|'number'|'string'
 * @returns {boolean}
 */
function checkValueType(value, expectedType) {
  switch (expectedType) {
    case 'number':
      return !isNaN(Number(value)) && value !== '';
      
    case 'date':
      // Check if it's a date-like string or Excel serial number
      if (typeof value === 'number' && value > 1 && value < 100000) {
        return true; // Excel serial date
      }
      const dateStr = String(value);
      // Check common date patterns: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, etc.
      const datePatterns = [
        /^\d{4}-\d{2}-\d{2}$/,           // 2024-01-15
        /^\d{2}\/\d{2}\/\d{4}$/,         // 15/01/2024
        /^\d{2}-\d{2}-\d{4}$/,           // 15-01-2024
        /^\d{4}\/\d{2}\/\d{2}$/,         // 2024/01/15
        /^\d{4}-W\d{2}$/                 // 2024-W03 (week)
      ];
      return datePatterns.some(pattern => pattern.test(dateStr));
      
    case 'string':
      return typeof value === 'string' || String(value).length > 0;
      
    default:
      return true;
  }
}

/**
 * Batch classify multiple sheets
 * 
 * @param {object[]} sheets - Array of { sheetName, headers, sampleRows }
 * @returns {object[]} Array of classification results
 */
export function classifyMultipleSheets(sheets) {
  return sheets.map(sheet => classifySheet(sheet));
}

/**
 * Get detailed reasons why a sheet classification has low confidence
 * 
 * @param {object} classificationResult - Result from classifySheet()
 * @returns {string[]} Array of human-readable reasons
 */
export function getClassificationReasons(classificationResult) {
  const reasons = [];
  const { confidence, evidence, suggestedType } = classificationResult;
  
  if (!suggestedType) {
    reasons.push('No matching upload type found');
    return reasons;
  }
  
  if (evidence.missingRequired.length > 0) {
    reasons.push(`Missing required fields: ${evidence.missingRequired.join(', ')}`);
  }
  
  if (evidence.matchedNegative.length > 0) {
    reasons.push(`Contains unexpected fields: ${evidence.matchedNegative.join(', ')}`);
  }
  
  if (evidence.typeCheckPassRate < 0.7 && Object.keys(evidence.typeCheckDetails).length > 0) {
    reasons.push(`Data type validation failed (${Math.round(evidence.typeCheckPassRate * 100)}% match)`);
  }
  
  if (confidence < 0.5) {
    reasons.push('Low confidence - manual verification recommended');
  }
  
  if (evidence.matchedRequired.length > 0) {
    reasons.push(`✓ Matched ${evidence.matchedRequired.length} required fields`);
  }
  
  if (evidence.matchedOptional.length > 0) {
    reasons.push(`✓ Matched ${evidence.matchedOptional.length} optional fields`);
  }
  
  return reasons;
}
