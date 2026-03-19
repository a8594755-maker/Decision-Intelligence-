/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  _testExports,
  buildAttachmentPromptText,
  classifyChatAttachment,
  preparePendingChatAttachments,
} from './chatAttachmentService';

describe('chatAttachmentService', () => {
  it('classifies spreadsheets and documents', () => {
    expect(classifyChatAttachment('plan.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(classifyChatAttachment('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document');
    expect(classifyChatAttachment('context.txt', 'text/plain')).toBe('text');
    expect(classifyChatAttachment('archive.zip', 'application/zip')).toBe('unsupported');
  });

  it('deduplicates and filters pending attachments', () => {
    const first = new File(['a'], 'plan.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: 1 });
    const second = new File(['a'], 'plan.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: 1 });
    const third = new File(['memo'], 'memo.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', lastModified: 2 });

    const { accepted, rejected } = preparePendingChatAttachments([first, second, third]);

    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/duplicate/i);
  });

  it('builds attachment prompt text with summaries and excerpts', () => {
    const prompt = buildAttachmentPromptText([
      {
        file_name: 'memo.docx',
        kind: 'document',
        size_bytes: 1024,
        summary: 'Parsed document context is available.',
        preview_text: 'This document explains the replenishment policy and approval thresholds.',
      },
    ]);

    expect(prompt).toMatch(/memo\.docx/);
    expect(prompt).toMatch(/Parsed document context/);
    expect(prompt).toMatch(/replenishment policy/i);
  });

  it('extracts basic text from docx xml', () => {
    const xml = [
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body>',
      '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>World</w:t></w:r></w:p>',
      '</w:body>',
      '</w:document>',
    ].join('');

    expect(_testExports.parseDocxXmlToText(xml)).toBe('Hello\nWorld');
  });
});
