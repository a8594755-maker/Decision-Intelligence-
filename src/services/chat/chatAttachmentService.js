import { strFromU8, unzipSync } from 'fflate';
import { userFilesService } from '../infra/supabaseClient';

export const CHAT_ATTACHMENT_MAX_FILES = 8;
export const CHAT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const CHAT_ATTACHMENT_ACCEPT = '.csv,.xlsx,.xls,.docx,.doc,.pdf,.txt,.md';

const SPREADSHEET_EXTENSIONS = new Set(['csv', 'xlsx', 'xls']);
const DOCUMENT_EXTENSIONS = new Set(['docx', 'doc', 'pdf']);
const TEXT_EXTENSIONS = new Set(['txt', 'md']);

function getFileExtension(fileName = '') {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/i);
  return match?.[1] || '';
}

function sanitizePreviewText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\0').join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncateText(value = '', limit = 800) {
  const normalized = sanitizePreviewText(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}...`;
}

export function formatAttachmentSize(bytes = 0) {
  const numeric = Number(bytes || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0 B';
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  return `${(numeric / 1024 / 1024).toFixed(1)} MB`;
}

export function classifyChatAttachment(fileName = '', mimeType = '') {
  const extension = getFileExtension(fileName);
  const normalizedMime = String(mimeType || '').toLowerCase();

  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (normalizedMime.startsWith('text/')) return 'text';
  return 'unsupported';
}

export function isSpreadsheetAttachment(attachment) {
  return classifyChatAttachment(attachment?.file_name || attachment?.name, attachment?.mime_type) === 'spreadsheet';
}

export function createPendingAttachment(file) {
  const fileName = String(file?.name || '');
  const extension = getFileExtension(fileName);
  const kind = classifyChatAttachment(fileName, file?.type);

  return {
    id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    file,
    file_name: fileName,
    extension,
    mime_type: file?.type || '',
    size_bytes: Number(file?.size || 0),
    last_modified: Number(file?.lastModified || 0),
    kind,
    parse_status: 'pending',
    summary: null,
    preview_text: null,
  };
}

export function preparePendingChatAttachments(files, existingAttachments = []) {
  const accepted = [];
  const rejected = [];
  const seen = new Set(
    (existingAttachments || []).map((attachment) => `${attachment.file_name}::${attachment.size_bytes}::${attachment.last_modified}`)
  );

  for (const file of Array.from(files || [])) {
    if (!file) continue;
    const pending = createPendingAttachment(file);
    const dedupeKey = `${pending.file_name}::${pending.size_bytes}::${pending.last_modified}`;

    if (pending.kind === 'unsupported') {
      rejected.push({ file_name: pending.file_name, reason: 'Unsupported file type' });
      continue;
    }

    if (pending.size_bytes > CHAT_ATTACHMENT_MAX_BYTES) {
      rejected.push({
        file_name: pending.file_name,
        reason: `File exceeds ${Math.round(CHAT_ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB limit`,
      });
      continue;
    }

    if (seen.has(dedupeKey)) {
      rejected.push({ file_name: pending.file_name, reason: 'Duplicate attachment' });
      continue;
    }

    if ((existingAttachments?.length || 0) + accepted.length >= CHAT_ATTACHMENT_MAX_FILES) {
      rejected.push({ file_name: pending.file_name, reason: `Maximum ${CHAT_ATTACHMENT_MAX_FILES} attachments` });
      continue;
    }

    seen.add(dedupeKey);
    accepted.push(pending);
  }

  return { accepted, rejected };
}

function parseDocxXmlToText(xmlString = '') {
  if (!xmlString) return '';

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
      const parseError = doc.getElementsByTagName('parsererror')?.[0];
      if (!parseError) {
        const paragraphs = Array.from(doc.getElementsByTagNameNS('*', 'p'))
          .map((paragraph) => {
            const parts = [];
            const nodes = Array.from(paragraph.childNodes || []);
            const stack = [...nodes];
            while (stack.length > 0) {
              const node = stack.shift();
              if (!node) continue;
              const localName = node.localName || node.nodeName;
              if (localName === 't') {
                parts.push(node.textContent || '');
              } else if (localName === 'tab') {
                parts.push('\t');
              } else if (localName === 'br' || localName === 'cr') {
                parts.push('\n');
              } else if (node.childNodes?.length) {
                stack.unshift(...Array.from(node.childNodes));
              }
            }
            return parts.join('').trim();
          })
          .filter(Boolean);

        if (paragraphs.length > 0) {
          return sanitizePreviewText(paragraphs.join('\n'));
        }
      }
    } catch {
      // Fall through to regex parser.
    }
  }

  return sanitizePreviewText(
    xmlString
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<(?:w:br|w:cr)\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

async function extractDocxText(file) {
  const buffer = await file.arrayBuffer();
  const zip = unzipSync(new Uint8Array(buffer));
  const documentXml = zip['word/document.xml'];
  if (!documentXml) return '';
  return parseDocxXmlToText(strFromU8(documentXml));
}

async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const decoded = new TextDecoder('latin1').decode(new Uint8Array(buffer));
  const matches = [
    ...decoded.matchAll(/\(([^()]*)\)\s*Tj/g),
    ...decoded.matchAll(/\[(.*?)\]\s*TJ/g),
  ];

  const fragments = matches
    .map((match) => String(match[1] || '')
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/<[^>]+>/g, ' ')
    )
    .map((part) => sanitizePreviewText(part))
    .filter(Boolean);

  return fragments.join('\n');
}

async function extractAttachmentText(file, kind, extension) {
  if (!file) return '';
  if (kind === 'text') {
    return sanitizePreviewText(await file.text());
  }
  if (kind === 'document' && extension === 'docx') {
    return extractDocxText(file);
  }
  if (kind === 'document' && extension === 'pdf') {
    return extractPdfText(file);
  }
  return '';
}

function buildDocumentStoragePayload(attachment, extractedText, previewText) {
  return {
    kind: attachment.kind,
    version: 'chat_attachment_v1',
    file_name: attachment.file_name,
    mime_type: attachment.mime_type,
    extension: attachment.extension,
    size_bytes: attachment.size_bytes,
    extracted_text: truncateText(extractedText, 12000),
    preview_text: previewText,
    created_at: new Date().toISOString(),
  };
}

export async function materializeDocumentAttachments({ userId, attachments }) {
  const results = [];

  for (const attachment of attachments || []) {
    const extractedText = await extractAttachmentText(attachment.file, attachment.kind, attachment.extension);
    const previewText = truncateText(extractedText, 1200);
    const parseStatus = previewText
      ? 'ready'
      : attachment.extension === 'pdf'
        ? 'metadata_only'
        : 'metadata_only';

    let fileRecord = null;
    if (userId) {
      try {
        fileRecord = await userFilesService.saveFile(
          userId,
          attachment.file_name,
          buildDocumentStoragePayload(attachment, extractedText, previewText)
        );
      } catch (error) {
        console.warn('[chatAttachmentService] Failed to persist document attachment:', error?.message);
      }
    }

    results.push({
      id: attachment.id,
      file_name: attachment.file_name,
      extension: attachment.extension,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      kind: attachment.kind,
      parse_status: parseStatus,
      preview_text: previewText || null,
      summary: previewText
        ? 'Parsed document context is available for the worker.'
        : 'Stored as attachment metadata only.',
      file_record_id: fileRecord?.id || null,
      source: 'chat_attachment',
    });
  }

  return results;
}

export function buildSpreadsheetAttachmentPayloads({
  pendingAttachments = [],
  files = [],
  uploadPreparation,
  datasetProfileId,
  userFileId,
  fileName = null,
}) {
  const sourceFiles = files.length > 0 ? files : pendingAttachments.map((attachment) => attachment.file).filter(Boolean);
  const isMultiFile = sourceFiles.length > 1;

  return pendingAttachments.map((attachment, index) => {
    const sourceFile = sourceFiles[index] || attachment.file || null;
    const prefix = isMultiFile ? `${sourceFile?.name || attachment.file_name}::` : '';
    const relevantSheets = (uploadPreparation?.sheetsRaw || []).filter((sheet) => {
      const sheetName = String(sheet.sheet_name || '');
      return prefix ? sheetName.startsWith(prefix) : true;
    });
    const relevantPlans = (uploadPreparation?.mappingPlans || []).filter((plan) => {
      const sheetName = String(plan.sheet_name || '');
      return prefix ? sheetName.startsWith(prefix) : true;
    });
    const totalRows = relevantSheets.reduce((sum, sheet) => (
      sum + Number(sheet.row_count_estimate || sheet.rows?.length || 0)
    ), 0);
    const uploadTypes = [...new Set(relevantPlans.map((plan) => plan.upload_type).filter(Boolean))];
    const workflowHint = uploadTypes.length > 0 ? uploadTypes.join(', ') : 'unclassified';

    return {
      id: attachment.id,
      file_name: attachment.file_name,
      extension: attachment.extension,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      kind: 'spreadsheet',
      parse_status: 'ready',
      summary: `${relevantSheets.length} sheet(s), ${totalRows.toLocaleString()} row(s), mapped as ${workflowHint}.`,
      preview_text: null,
      dataset_profile_id: datasetProfileId || null,
      file_record_id: userFileId || null,
      source: 'chat_attachment',
      spreadsheet: {
        sheet_count: relevantSheets.length,
        total_rows: totalRows,
        upload_types: uploadTypes,
        combined_file_name: fileName || null,
      },
    };
  });
}

export function stripPendingAttachmentFile(attachment) {
  if (!attachment || typeof attachment !== 'object') return attachment;
  const next = { ...attachment };
  delete next.file;
  return next;
}

export function buildAttachmentPromptText(attachments = [], {
  heading = 'Attached Files Context',
  includeExcerpts = true,
  maxExcerptChars = 500,
} = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';

  const lines = [heading + ':'];
  attachments.forEach((attachment, index) => {
    const labelParts = [
      `${index + 1}. ${attachment.file_name}`,
      attachment.kind,
      formatAttachmentSize(attachment.size_bytes),
    ].filter(Boolean);

    lines.push(labelParts.join(' | '));

    if (attachment.summary) {
      lines.push(`   Summary: ${attachment.summary}`);
    }

    if (attachment.spreadsheet?.upload_types?.length) {
      lines.push(`   Upload types: ${attachment.spreadsheet.upload_types.join(', ')}`);
    }

    const preview = includeExcerpts ? truncateText(attachment.preview_text, maxExcerptChars) : '';
    if (preview) {
      lines.push(`   Excerpt: ${preview}`);
    }
  });

  return lines.join('\n');
}

export const _testExports = {
  parseDocxXmlToText,
  sanitizePreviewText,
  truncateText,
};
