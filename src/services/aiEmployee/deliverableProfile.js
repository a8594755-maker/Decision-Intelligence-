const DEFAULT_DELIVERABLE_PROFILE = {
  type: 'manager_brief',
  docType: 'general_report',
  format: 'doc',
  channel: 'Document',
  audience: 'Manager',
  label: 'Manager Brief',
};

const TEMPLATE_DELIVERABLE_PROFILES = {
  forecast: {
    type: 'forecast_memo',
    docType: 'forecast_memo',
    format: 'doc',
    channel: 'Document + spreadsheet appendix',
    audience: 'Planning manager',
    label: 'Forecast Memo',
  },
  plan: {
    type: 'planning_recommendation',
    docType: 'planning_recommendation',
    format: 'doc',
    channel: 'Document + spreadsheet appendix',
    audience: 'Operations manager',
    label: 'Planning Recommendation',
  },
  risk: {
    type: 'risk_memo',
    docType: 'risk_memo',
    format: 'doc',
    channel: 'Document + spreadsheet appendix',
    audience: 'Operations manager',
    label: 'Risk Memo',
  },
  forecast_then_plan: {
    type: 'ops_brief',
    docType: 'ops_brief',
    format: 'doc',
    channel: 'Document + spreadsheet appendix',
    audience: 'Operations manager',
    label: 'Operations Brief',
  },
  risk_aware_plan: {
    type: 'risk_adjusted_ops_brief',
    docType: 'risk_adjusted_ops_brief',
    format: 'doc',
    channel: 'Document + spreadsheet appendix',
    audience: 'Operations manager',
    label: 'Risk-Adjusted Ops Brief',
  },
  full_report: {
    type: 'weekly_business_review',
    docType: 'weekly_business_review',
    format: 'doc',
    channel: 'Document',
    audience: 'Functional manager',
    label: 'Weekly Business Review',
  },
  full_report_with_publish: {
    type: 'published_business_review',
    docType: 'published_business_review',
    format: 'doc',
    channel: 'Document + published copy',
    audience: 'Functional manager',
    label: 'Published Business Review',
  },
  mbr_with_excel: {
    type: 'monthly_business_review',
    docType: 'monthly_business_review',
    format: 'spreadsheet',
    channel: 'Spreadsheet pack',
    audience: 'Leadership review',
    label: 'MBR Workbook Pack',
  },
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBulletItem(item) {
  if (typeof item === 'string') return item.trim();
  if (isObject(item)) {
    return String(
      item.claim
      || item.issue
      || item.text
      || item.title
      || item.summary
      || item.recommendation
      || ''
    ).trim();
  }
  return '';
}

function normalizeBulletList(items, maxItems = 6) {
  if (!Array.isArray(items)) return [];
  return items
    .map(normalizeBulletItem)
    .filter(Boolean)
    .slice(0, maxItems);
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return collapseWhitespace(String(value || '').replace(/<[^>]+>/g, ' '));
}

function extractArtifactData(ref) {
  if (!ref || typeof ref !== 'object') return null;
  return ref.data ?? ref.payload ?? null;
}

function sortRunsForPreview(runs = []) {
  return [...runs].sort((a, b) => {
    const aTime = new Date(a?.ended_at || a?.started_at || 0).getTime();
    const bTime = new Date(b?.ended_at || b?.started_at || 0).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return (b?.step_index ?? -1) - (a?.step_index ?? -1);
  });
}

function pickPrimaryArtifact(artifacts = []) {
  const priorities = ['report_html', 'report_json', 'excel_workbook', 'powerbi_dataset', 'llm_analysis'];
  for (const type of priorities) {
    const found = artifacts.find((artifact) => (artifact?.artifact_type || artifact?.type) === type);
    if (found) return found;
  }
  return artifacts[0] || null;
}

function buildDocumentSections(data) {
  if (!isObject(data)) return [];

  const keyResults = normalizeBulletList(data.key_results || data.insights || data.highlights);
  const recommendations = normalizeBulletList(
    data.recommended_actions || data.recommendations || data.action_items
  );
  const exceptions = normalizeBulletList(data.exceptions);

  return [
    keyResults.length > 0 ? { label: 'Key Findings', items: keyResults } : null,
    recommendations.length > 0 ? { label: 'Recommended Actions', items: recommendations } : null,
    exceptions.length > 0 ? { label: 'Exceptions / Watchouts', items: exceptions } : null,
  ].filter(Boolean);
}

function buildSpreadsheetSections(data) {
  const workbook = isObject(data) ? data : {};
  const sheets = Array.isArray(workbook.sheets) ? workbook.sheets.slice(0, 8) : [];
  return sheets.length > 0
    ? [{ label: 'Workbook Sheets', items: sheets.map((sheet) => String(sheet || '').trim()).filter(Boolean) }]
    : [];
}

function buildPrimaryPreview(primaryArtifact, fallbackSummary) {
  const artifactType = primaryArtifact?.artifact_type || primaryArtifact?.type || null;
  const data = extractArtifactData(primaryArtifact);

  if (artifactType === 'report_html') {
    return {
      previewKind: 'document',
      summary: stripHtml(data || fallbackSummary),
      sections: [],
      rawPreview: typeof data === 'string' ? data : null,
      attachmentName: primaryArtifact?.label || 'HTML report',
    };
  }

  if (artifactType === 'report_json') {
    const root = isObject(data) ? data : {};
    const summary = collapseWhitespace(
      root.summary
      || root.summary_text
      || root.executive_summary
      || fallbackSummary
    );
    return {
      previewKind: 'document',
      summary,
      sections: buildDocumentSections(root),
      rawPreview: null,
      attachmentName: primaryArtifact?.label || 'Structured report',
    };
  }

  if (artifactType === 'excel_workbook') {
    const workbook = isObject(data) ? data : {};
    const filename = workbook.filename || primaryArtifact?.label || 'Workbook';
    return {
      previewKind: 'spreadsheet',
      summary: collapseWhitespace(
        `${filename} is ready for manager review.${workbook.file_path ? ` Saved at ${workbook.file_path}.` : ''}`
      ),
      sections: buildSpreadsheetSections(workbook),
      rawPreview: null,
      attachmentName: filename,
    };
  }

  if (artifactType === 'powerbi_dataset') {
    return {
      previewKind: 'bi',
      summary: collapseWhitespace(`Power BI dataset payload is ready for publishing or refresh.${fallbackSummary ? ` ${fallbackSummary}` : ''}`),
      sections: [],
      rawPreview: null,
      attachmentName: primaryArtifact?.label || 'Power BI dataset',
    };
  }

  if (artifactType === 'llm_analysis') {
    const root = isObject(data) ? data : {};
    return {
      previewKind: 'document',
      summary: collapseWhitespace(root.summary || fallbackSummary),
      sections: [
        ...((normalizeBulletList(root.insights).length > 0)
          ? [{ label: 'Insights', items: normalizeBulletList(root.insights) }]
          : []),
        ...((normalizeBulletList(root.recommendations).length > 0)
          ? [{ label: 'Recommendations', items: normalizeBulletList(root.recommendations) }]
          : []),
      ],
      rawPreview: null,
      attachmentName: primaryArtifact?.label || 'Analysis draft',
    };
  }

  return {
    previewKind: 'document',
    summary: collapseWhitespace(fallbackSummary),
    sections: [],
    rawPreview: typeof data === 'string' ? data : null,
    attachmentName: primaryArtifact?.label || primaryArtifact?.artifact_type || primaryArtifact?.type || 'Deliverable',
  };
}

export function getDefaultDeliverableProfile(templateId) {
  return TEMPLATE_DELIVERABLE_PROFILES[templateId] || DEFAULT_DELIVERABLE_PROFILE;
}

export function resolveDeliverableProfile(inputContext = {}) {
  const templateKey = inputContext.deliverable_profile
    || inputContext.template_id
    || inputContext.workflow_type
    || null;
  const base = getDefaultDeliverableProfile(templateKey);

  return {
    ...base,
    type: inputContext.deliverable_type || base.type,
    docType: inputContext.doc_type || inputContext.document_type || base.docType,
    format: inputContext.deliverable_format || base.format,
    channel: inputContext.deliverable_channel || base.channel,
    audience: inputContext.deliverable_audience || base.audience,
    label: inputContext.deliverable_label || base.label,
  };
}

export function buildDeliverablePreview(item) {
  const inputContext = item?.input_context || {};
  const profile = resolveDeliverableProfile(inputContext);
  const runs = sortRunsForPreview(item?.ai_employee_runs || []);
  const latestRun = runs[0] || null;
  const evidenceArtifacts = Array.isArray(latestRun?.artifact_refs) ? latestRun.artifact_refs : [];
  const primaryArtifact = pickPrimaryArtifact(evidenceArtifacts);

  const fallbackSummary = latestRun?.summary || item?.description || 'Draft deliverable is ready for review.';
  const primaryPreview = buildPrimaryPreview(primaryArtifact, fallbackSummary);
  const attachmentNames = evidenceArtifacts
    .filter((artifact) => artifact !== primaryArtifact)
    .map((artifact) => artifact?.label || artifact?.artifact_type || artifact?.type || 'Attachment')
    .filter(Boolean)
    .slice(0, 8);

  return {
    profile,
    latestRun,
    primaryArtifact,
    evidenceArtifacts,
    previewKind: primaryPreview.previewKind || profile.format,
    headline: item?.title || profile.label,
    summary: primaryPreview.summary || collapseWhitespace(fallbackSummary),
    sections: primaryPreview.sections || [],
    rawPreview: primaryPreview.rawPreview || null,
    attachmentNames,
    primaryAttachmentName: primaryPreview.attachmentName || null,
  };
}

export default {
  buildDeliverablePreview,
  getDefaultDeliverableProfile,
  resolveDeliverableProfile,
};
